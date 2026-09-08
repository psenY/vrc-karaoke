// 一体化：重新上传 → 选合集 → 投稿 → 捕获 add/v3（每步验证）
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
      if (/add\/v3/.test(u) && m.params.request.method === 'POST') captured.push({ url: u, body: m.params.request.postData || '' });
    }
  };
  const send = (method, params = {}) => new Promise(res => { const id = ++msgId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const evalJS = async (expr, awaitP = false) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: awaitP, returnByValue: true }); return r.result && r.result.result ? r.result.result.value : undefined; };

  await new Promise(r => ws.onopen = r);
  await send('Network.enable');
  await send('Page.enable');

  // cookie 注入 + 刷新页面（干净状态）
  const cfg = JSON.parse(fs.readFileSync('/tmp/cd_ck.json', 'utf8'));
  for (const c of cfg) await send('Network.setCookie', { ...c, domain: '.bilibili.com', path: '/', expires: Math.floor(Date.now()/1000) + 86400*30 });
  await send('Page.navigate', { url: 'https://member.bilibili.com/platform/upload/video' });
  await wait(10000);
  console.log('[1] 页面加载');

  // 注入文件
  const q = await send('DOM.getDocument');
  const qq = await send('DOM.querySelectorAll', { nodeId: q.result.root.nodeId, selector: 'input[type=file][accept*=mp4]' });
  const nodeIds = qq.result.nodeIds.filter(n => n);
  if (!nodeIds.length) { console.error('无 file input'); process.exit(1); }
  await send('DOM.setFileInputFiles', { nodeId: nodeIds[0], files: ['/workspace/vrc-karaoke/tmp-webtest/test_hires.mp4'] });
  console.log('[2] 文件注入');

  // 等"上传完成"
  let done = false;
  for (let i = 0; i < 30; i++) {
    await wait(4000);
    if (await evalJS(`document.body.innerText.includes('上传完成') && !document.body.innerText.includes('上传失败')`)) { done = true; break; }
    // 若失败则重新注入
    if (await evalJS(`document.body.innerText.includes('上传失败')`)) {
      console.log('   上传失败，重新注入...');
      await send('DOM.setFileInputFiles', { nodeId: nodeIds[0], files: ['/workspace/vrc-karaoke/tmp-webtest/test_hires.mp4'] });
    }
  }
  if (!done) { console.error('上传未完成'); process.exit(1); }
  console.log('[3] 上传完成');

  // 标题
  await evalJS(`
    (() => { const inp = document.querySelector('input[maxlength="80"]'); if (inp) { const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; s.call(inp, '合集抓包-可删除' + (Date.now()%10000)); inp.dispatchEvent(new Event('input', {bubbles:true})); } })()
  `);
  await wait(1000);

  // 创作声明
  await evalJS(`(() => { const li = [...document.querySelectorAll('li.bcc-option')].find(e => (e.textContent||'').trim() === '内容无需标注'); if (li) li.click(); return 1; })()`);
  await wait(1500);

  // 选择合集：点 .season-enter → 弹窗选 .season-item → 确认按钮
  const seasonClick = await evalJS(`
    (async () => {
      const enter = document.querySelector('.season-enter');
      if (!enter) return 'no-enter';
      enter.scrollIntoView({ block: 'center' });
      await new Promise(r => setTimeout(r, 500));
      enter.click();
      await new Promise(r => setTimeout(r, 2500));
      const item = document.querySelector('.season-item');
      if (!item) return 'no-item';
      item.click();
      await new Promise(r => setTimeout(r, 1500));
      // 确认按钮（弹窗内）
      const btns = [...document.querySelectorAll('button')].filter(b => b.offsetParent !== null && /^(确定|确认)$/.test((b.textContent||'').trim()));
      if (btns.length) { btns[btns.length-1].click(); return 'confirmed'; }
      return 'no-confirm-btn';
    })()
  `, true);
  console.log('[4] 合集选择:', seasonClick);
  const seasonShown = await evalJS(`(document.querySelector('.season-enter-text')||{textContent:'nf'}).textContent.trim()`);
  console.log('    合集区显示:', seasonShown);
  await wait(2000);

  // 声明再确认（弹窗可能重置）
  await evalJS(`(() => { const li = [...document.querySelectorAll('li.bcc-option')].find(e => (e.textContent||'').trim() === '内容无需标注'); if (li && !li.className.includes('selected')) li.click(); return 1; })()`);
  await wait(1000);

  // 投稿
  const posStr = await evalJS(`
    (() => { const el = document.querySelector('.submit-add'); if (!el) return '"nf"'; el.scrollIntoView({ block: 'center' }); return new Promise(res => setTimeout(() => { const r = el.getBoundingClientRect(); res(JSON.stringify({ x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) })); }, 500)); })()
  `, true);
  const pos = JSON.parse(posStr);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pos.x, y: pos.y });
  await wait(300);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
  console.log('[5] 点击投稿', pos);

  await wait(20000);
  console.log('[6] 捕获:', captured.length, '条');
  if (captured.length) {
    console.log('===== add/v3 body =====');
    console.log(captured[0].body);
    fs.writeFileSync('/workspace/vrc-karaoke/tmp-webtest/captured_season.json', JSON.stringify(captured[0], null, 2));
    console.log('✅ 已存 captured_season.json');
  } else {
    console.log('[页面提示]', await evalJS(`document.body.innerText.slice(0, 150).replace(/\\n/g, '|')`));
  }
  ws.close();
  process.exit(0);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
