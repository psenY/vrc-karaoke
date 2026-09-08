// CDP 抓包：网页端投稿时选合集，看 add/v3 body 里合集字段的真实形态
const http = require('http');
const fs = require('fs');
function httpGetJson(url) { return new Promise((res, rej) => { http.get(url, r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>res(JSON.parse(d))); }).on('error',rej); }); }
(async () => {
  const targets = await httpGetJson('http://127.0.0.1:9222/json');
  const page = targets.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let msgId = 0; const pending = new Map(); const captured = [];
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method === 'Network.requestWillBeSent') {
      const u = m.params.request.url;
      if (/add\/v3/.test(u) && m.params.request.method === 'POST') {
        captured.push({ url: u, body: m.params.request.postData || '' });
        console.log('★ [add/v3] body长度:', (m.params.request.postData||'').length);
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
  // cookie 再注入（防过期）
  const cfg = JSON.parse(fs.readFileSync('/tmp/cd_ck.json', 'utf8'));
  for (const c of cfg) await send('Network.setCookie', { ...c, domain: '.bilibili.com', path: '/', expires: Math.floor(Date.now()/1000) + 86400*30 });
  await send('Page.navigate', { url: 'https://member.bilibili.com/platform/upload/video' });
  await wait(9000);
  // 注入文件
  const q = await send('DOM.getDocument');
  const qq = await send('DOM.querySelectorAll', { nodeId: q.result.root.nodeId, selector: 'input[type=file][accept*=mp4]' });
  const nodeIds = qq.result.nodeIds.filter(n => n);
  if (!nodeIds.length) { console.error('无 file input'); process.exit(1); }
  await send('DOM.setFileInputFiles', { nodeId: nodeIds[0], files: ['/workspace/vrc-karaoke/tmp-webtest/test_hires.mp4'] });
  console.log('[文件注入] 等上传完成...');
  // 等上传完成（页面出现"上传完成"）
  const t0 = Date.now();
  while (Date.now() - t0 < 120000) {
    const txt = await evalJS(`document.body.innerText.includes('上传完成')`);
    if (txt) break;
    await wait(4000);
  }
  console.log('[上传完成]');
  // 填标题
  await evalJS(`
    (() => { const inp = document.querySelector('input[maxlength="80"]'); if (inp) { const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; s.call(inp, '合集字段抓包-可删除' + (Date.now()%10000)); inp.dispatchEvent(new Event('input', {bubbles:true})); } return 'title'; })()
  `);
  // 创作声明
  await evalJS(`
    (() => { const li = [...document.querySelectorAll('li.bcc-option')].find(e => (e.textContent||'').trim() === '内容无需标注'); if (li && !li.className.includes('selected')) li.click(); return 'stmt'; })()
  `);
  await wait(1500);
  // ⭐ 打开"加入合集"下拉并选择第一个合集
  const seasonPicked = await evalJS(`
    (async () => {
      // 找"加入合集"区域的选择器
      const ph = [...document.querySelectorAll('.el-select, [class*=select]')].find(e => (e.textContent||'').includes('请选择合集') || (e.previousElementSibling && /加入合集/.test(e.previousElementSibling.textContent||'')));
      // 更稳：找 placeholder=请选择合集 的 input
      const inp = document.querySelector('input[placeholder="请选择合集"]');
      if (!inp) return 'no-select-input';
      inp.click();  // 展开下拉
      await new Promise(r => setTimeout(r, 1200));
      // 下拉项（el-select-dropdown 里的 li）
      const items = [...document.querySelectorAll('.el-select-dropdown__item, [class*=dropdown] li')].filter(e => e.offsetParent !== null && (e.textContent||'').trim());
      if (!items.length) return 'dropdown-empty';
      // 选含 vrc-karaoke 的项，否则第一项
      const pick = items.find(e => /vrc-karaoke/i.test(e.textContent)) || items[0];
      const label = pick.textContent.trim();
      pick.click();
      return 'picked: ' + label;
    })()
  `);
  console.log('[合集选择]', seasonPicked);
  await wait(2000);
  // 点击立即投稿
  const r1 = await evalJS(`
    (() => { const el = document.querySelector('.submit-add'); if (!el) return 'nf'; el.scrollIntoView({block:'center'}); const r = el.getBoundingClientRect(); return JSON.stringify({x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2)}); })()
  `);
  const pos = JSON.parse(r1);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
  console.log('[点击投稿]');
  await wait(18000);
  if (captured.length) {
    console.log('===== add/v3 body（含合集字段）=====');
    console.log(captured[0].body);
    fs.writeFileSync('/workspace/vrc-karaoke/tmp-webtest/captured_season.json', JSON.stringify(captured[0], null, 2));
    console.log('✅ 已存 captured_season.json');
  } else {
    console.log('[未捕获] 页面提示:', await evalJS(`(document.querySelector('.el-message--error')||{textContent:'无'}).textContent.slice(0,80)`));
  }
  ws.close();
})().catch(e => console.error('FATAL', e.message));
