// CDP 上传流程规格抓取：请求+响应全录（multipart/new|part|complete|upload/file|preupload）
const http = require('http');
const fs = require('fs');
function httpGetJson(url) { return new Promise((res, rej) => { http.get(url, r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>res(JSON.parse(d))); }).on('error',rej); }); }
(async () => {
  const targets = await httpGetJson('http://127.0.0.1:9222/json');
  const page = targets.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let msgId = 0; const pending = new Map();
  const reqs = new Map();       // requestId -> {url, body}
  const transcript = [];
  const INTEREST = /preupload|multipart\/(new|part|complete)|upload\/file|arc\/detail|precheck/;
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Network.requestWillBeSent') {
      const u = m.params.request.url;
      if (INTEREST.test(u) && !/gol|tooltip/.test(u)) {
        reqs.set(m.params.requestId, { url: u, body: m.params.request.postData || '' });
        console.log('→ REQ:', u.replace(/https:\/\/member\.bilibili\.com/, '').slice(0, 70), '| body:', (m.params.request.postData || '').slice(0, 120));
      }
    } else if (m.method === 'Network.loadingFinished') {
      const info = reqs.get(m.params.requestId);
      if (info) {
        send('Network.getResponseBody', { requestId: m.params.requestId }).then(r => {
          const body = r.result && (r.result.body || '');
          transcript.push({ url: info.url, reqBody: info.body, respBody: (body || '').slice(0, 1500), base64: r.result.base64Encoded });
          console.log('← RESP:', info.url.replace(/https:\/\/member\.bilibili\.com/, '').slice(0, 60), '|', (body || '').slice(0, 220).replace(/\n/g, ' '));
        }).catch(() => {});
      }
    }
  };
  const send = (method, params = {}) => new Promise(res => { const id = ++msgId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const evalJS = async (expr, awaitP = false) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: awaitP, returnByValue: true });
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  await new Promise(r => ws.onopen = r);
  await send('Network.enable');
  await send('Page.enable');

  // 刷新页面重新开始（清掉已有分P），然后注入文件
  await send('Page.navigate', { url: 'https://member.bilibili.com/platform/upload/video' });
  await wait(10000);
  await send('DOM.getDocument');
  const q = await send('DOM.querySelectorAll', { nodeId: (await send('DOM.getDocument')).result.root.nodeId, selector: 'input[type=file][accept*=mp4]' });
  const nodeIds = q.result.nodeIds.filter(n => n);
  if (!nodeIds.length) { console.error('无 file input'); process.exit(1); }
  await send('DOM.setFileInputFiles', { nodeId: nodeIds[0], files: ['/workspace/vrc-karaoke/tmp-webtest/test_hires.mp4'] });
  console.log('[文件注入] 等上传完成...');

  // 等上传完成（complete 请求出现）
  const t0 = Date.now();
  while (Date.now() - t0 < 120000) {
    await wait(5000);
    if (transcript.some(x => x.url.includes('multipart/complete'))) break;
  }
  await wait(5000);
  fs.writeFileSync('/workspace/vrc-karaoke/tmp-webtest/upload_spec.json', JSON.stringify(transcript, null, 2));
  console.log('\n=== 规格 transcript 已存（', transcript.length, '条）===');
  ws.close();
})().catch(e => console.error('FATAL', e.message));
