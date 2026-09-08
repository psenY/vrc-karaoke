// CDP 直连脚本：登录注入 + 打开投稿页 + 捕获 add/v3 请求
// 用法: node cdp_session.js
const http = require('http');

const CDP_HTTP = 'http://127.0.0.1:9222';
const COOKIE_SESSDATA = "580426a4%2C1804344266%2Ca82b0%2A91CjDvJjfxfhZSXxX6qRQDDXDpeIaXzbwnEhDsC_pGamj_tOJ-ROnnRpV31kr-1io0IQUSVlAtNkRiTkE1SGR4cmRyZ0g2OFJjT2lNYUFTZDJMU2tQOF9KbWd6SVZrOTJFMmphckthNG9jbl9lSG5uRG9BTmhvMEpYbmRxR1FvOC04Y0h5RjhNcWJRIIEC";
const COOKIE_JCT = process.env.CD_JCT;
const COOKIE_DEDE = process.env.CD_DEDE;

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let d = '';
      res.on('data', c => { d += c; });
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function main() {
  const targets = await httpGetJson(CDP_HTTP + '/json');
  const page = targets.find(t => t.type === 'page');
  if (!page) throw new Error('无 page target');
  console.log('[cdp] target:', page.url.slice(0, 60));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let msgId = 0;
  const pending = new Map();
  const events = [];
  const captured = [];

  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method) {
      events.push(m);
      // 捕获 add/v3
      if (m.method === 'Network.requestWillBeSent') {
        const u = m.params.request.url;
        if (u.includes('add/v3')) {
          captured.push({ url: u, body: m.params.request.postData || '(no postData)', headers: m.params.request.headers });
          console.log('\n[捕获] add/v3 请求! body 长度:', (m.params.request.postData || '').length);
        }
      }
    }
  };
  const send = (method, params = {}) => new Promise(resolve => {
    const id = ++msgId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const wait = ms => new Promise(r => setTimeout(r, ms));

  await new Promise(r => ws.onopen = r);
  console.log('[cdp] ws 已连接');

  await send('Network.enable');
  // 注入 cookie（原生 CDP，HttpOnly 无碍）
  const cookies = [
    { name: 'SESSDATA', value: COOKIE_SESSDATA, domain: '.bilibili.com', path: '/' },
    { name: 'bili_jct', value: COOKIE_JCT, domain: '.bilibili.com', path: '/' },
    { name: 'DedeUserID', value: COOKIE_DEDE, domain: '.bilibili.com', path: '/' },
  ];
  for (const c of cookies) {
    await send('Network.setCookie', { ...c, expires: Math.floor(Date.now() / 1000) + 86400 * 30 });
  }
  console.log('[cdp] cookie 已注入');

  // 导航到投稿页
  await send('Page.enable');
  await send('Page.navigate', { url: 'https://member.bilibili.com/platform/upload/video' });
  await wait(8000);

  // 登录态检查
  const check = await send('Runtime.evaluate', { expression: "(async()=>{const r=await fetch('https://api.bilibili.com/x/web-interface/nav',{credentials:'include'});const j=await r.json();return JSON.stringify({isLogin:j.data&&j.data.isLogin,uname:j.data&&j.data.uname});})()", awaitPromise: true });
  console.log('[登录态]', check.result && check.result.result && check.result.result.value);

  console.log('[cdp] 会话保持中（脚本将退出，后续步骤在独立脚本中继续）');
  // 保持 60 秒观察事件
  await wait(60000);
  console.log('[cdp] 捕获请求数:', captured.length);
  if (captured.length) console.log(JSON.stringify(captured, null, 2).slice(0, 3000));
  ws.close();
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
