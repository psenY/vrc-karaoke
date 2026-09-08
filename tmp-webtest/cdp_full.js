// CDP 全流程：上传测试视频 → 填标题 → 勾 Hi-Res → 投稿 → 捕获 add/v3 body
// 前置: cdp_session.js 已注入 cookie 且登录态有效（本脚本重新注入以防丢失）
const http = require('http');
const fs = require('fs');

const CDP_HTTP = 'http://127.0.0.1:9222';
const FILE_LOCAL = process.argv[2] || '/workspace/vrc-karaoke/tmp-webtest/test_hires.mp4';
const TITLE = 'HiRes测试视频-可删除' + Date.now() % 10000;
const SESSDATA = process.env.CD_SESSDATA, JCT = process.env.CD_JCT, DEDE = process.env.CD_DEDE;

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => { let d = ''; res.on('data', c => { d += c; }); res.on('end', () => resolve(JSON.parse(d))); }).on('error', reject);
  });
}

async function main() {
  const targets = await httpGetJson(CDP_HTTP + '/json');
  const page = targets.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let msgId = 0;
  const pending = new Map();
  const captured = [];

  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method === 'Network.requestWillBeSent') {
      const u = m.params.request.url;
      if (/add\/v3|multipart\/complete|multipart\/new/.test(u)) {
        captured.push({ stage: u.includes('add/v3') ? 'SUBMIT' : u.includes('/new') ? 'MP-NEW' : 'MP-COMPLETE', url: u.slice(0, 160), body: m.params.request.postData || '', resp: m.params.request.url });
        console.log('[捕获]', captured[captured.length - 1].stage, '| body长度:', (m.params.request.postData || '').length);
      }
    }
  };
  const send = (method, params = {}) => new Promise(resolve => { const id = ++msgId; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const evalJS = async (expr, awaitP = false) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: awaitP, returnByValue: true });
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  const sleepUntil = async (expr, timeoutMs = 120000, interval = 3000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const v = await evalJS(expr);
      if (v) return v;
      await wait(interval);
    }
    return null;
  };

  await new Promise(r => ws.onopen = r);
  await send('Network.enable');
  for (const c of [
    { name: 'SESSDATA', value: SESSDATA }, { name: 'bili_jct', value: JCT }, { name: 'DedeUserID', value: DEDE },
  ]) await send('Network.setCookie', { ...c, domain: '.bilibili.com', path: '/', expires: Math.floor(Date.now() / 1000) + 86400 * 30 });
  await send('Page.enable');
  await send('Page.navigate', { url: 'https://member.bilibili.com/platform/upload/video' });
  await wait(8000);
  const login = await evalJS("(async()=>{const r=await fetch('https://api.bilibili.com/x/web-interface/nav',{credentials:'include'});const j=await r.json();return j.data&&j.data.isLogin;})()", true);
  if (!login) { console.error('未登录，退出'); process.exit(1); }
  console.log('[登录 OK]');

  // 1. 找到 file input 并注入真实文件（DOM.setFileInputFiles）
  const doc = await send('DOM.getDocument');
  const root = doc.result.root.nodeId;
  const q = await send('DOM.querySelectorAll', { nodeId: root, selector: 'input[type=file][accept*=mp4]' });
  const fileInputs = q.result.nodeIds.filter(n => n);
  console.log('[file inputs]', fileInputs.length);
  if (!fileInputs.length) { console.error('找不到文件输入框'); process.exit(1); }
  await send('DOM.setFileInputFiles', { nodeId: fileInputs[0], files: [FILE_LOCAL] });
  console.log('[文件已注入] 等待上传开始...');

  // 2. 等待上传开始（出现 multipart/new）
  const sawUpload = captured.some(c => c.stage === 'MP-NEW');
  const t0 = Date.now();
  while (!sawUpload && Date.now() - t0 < 20000) { await wait(2000); if (captured.some(c => c.stage === 'MP-NEW')) break; }
  console.log('[上传] 已启动' + (captured.some(c => c.stage === 'MP-NEW') ? '' : '（未见 new 请求，继续观察）'));

  // 3. 等上传完成（页面出现"投稿"按钮可用或 complete 请求）
  let completeSeen = false;
  const t1 = Date.now();
  while (Date.now() - t1 < 180000) {
    if (captured.some(c => c.stage === 'MP-COMPLETE')) { completeSeen = true; break; }
    await wait(3000);
  }
  console.log('[上传完成]', completeSeen);
  await wait(3000);

  // 4. 填标题（网页自动用文件名，改为唯一测试名）
  await evalJS(`
    const inp = document.querySelector('input[placeholder*="标题"], input[class*="title"] input, .title-input input, input[maxlength="80"]');
    if (inp) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(inp, ${JSON.stringify(TITLE)});
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
    }
    'title-set:' + !!inp
  `);

  // 5. 勾选 Hi-Res（找含"高清音质/Hi-Res/无损"的 checkbox/switch）
  const hiresClicked = await evalJS(`
    (() => {
      const els = [...document.querySelectorAll('label, .el-switch, [class*="switch"], [class*="checkbox"], [class*="lossless"], [class*="hires"]')];
      const target = els.find(e => /高清音质|Hi-Res|无损/i.test(e.textContent || ''));
      if (target) { target.click(); return target.textContent.trim().slice(0, 20); }
      return null;
    })()
  `);
  console.log('[Hi-Res 勾选]', hiresClicked || '未找到控件（可能上传分析后才出现）');

  // 6. 分区选择（默认可能有预选——投稿需要；若页面报错再补）
  // 7. 点击投稿按钮
  const clicked = await evalJS(`
    (() => {
      const btns = [...document.querySelectorAll('button')];
      const btn = btns.find(b => /^(投稿|立即投稿|提交稿件)/.test((b.textContent || '').trim()) && !b.disabled);
      if (btn) { btn.click(); return btn.textContent.trim(); }
      return null;
    })()
  `);
  console.log('[投稿按钮]', clicked || '未找到（可能还有必填项）');

  // 8. 等待捕获 add/v3
  const t2 = Date.now();
  while (!captured.some(c => c.stage === 'SUBMIT') && Date.now() - t2 < 30000) await wait(2000);
  const sub = captured.find(c => c.stage === 'SUBMIT');
  if (sub) {
    console.log('\n===== add/v3 捕获成功 =====');
    console.log('URL:', sub.url);
    console.log('BODY:', sub.body);
    fs.writeFileSync('/workspace/vrc-karaoke/tmp-webtest/captured_addv3.json', JSON.stringify({ url: sub.url, body: sub.body }, null, 2));
    console.log('已写入 captured_addv3.json');
  } else {
    console.log('[未捕获 add/v3] 页面当前文本片段:');
    console.log((await evalJS(`document.body.innerText.slice(0, 500)`)) || '');
  }
  // 附带 multipart/complete 响应结构（供新上传流程迁移参考）
  fs.writeFileSync('/workspace/vrc-karaoke/tmp-webtest/captured_all.json', JSON.stringify(captured, null, 2));
  ws.close();
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
