'use strict';

/**
 * B站投稿 API（非官方逆向实现，自用低频）。
 * 链路：扫码登录拿 cookie → preupload 预上传 → upos 分片上传 → add/v3 投稿。
 * 所有请求需携带登录 cookie（SESSDATA/bili_jct/DedeUserID）。
 */

const https = require('https');
const http = require('http');
const crypto = require('crypto');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function request(url, { method = 'GET', headers = {}, body = null, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.request(url, { method, headers: { 'User-Agent': UA, ...headers } }, res => {
      let d = '';
      res.on('data', c => { d += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: d }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('请求超时')); });
    if (body) req.write(body);
    req.end();
  });
}

/** 扫码登录：生成二维码 */
async function qrGenerate() {
  const r = await request('https://passport.bilibili.com/x/passport-login/web/qrcode/generate?source=main_web');
  const j = JSON.parse(r.text);
  if (j.code !== 0) throw new Error('B站二维码生成失败: ' + (j.message || j.code));
  return { qrUrl: j.data.url, qrcodeKey: j.data.qrcode_key, qrimg: j.data.qrcode_image || '' };
}

/** 扫码登录：轮询状态。code: 86101=未扫码 86090=已扫未确认 86038=已过期 0=成功(含cookie) */
async function qrPoll(qrcodeKey) {
  const r = await request(`https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${qrcodeKey}`);
  const j = JSON.parse(r.text);
  const d = j.data || {};
  const code = j.data?.code ?? j.code;
  if (code === 0) {
    // cookie 在 set-cookie 头——request 未暴露 res.headers？已暴露
    const raw = r.headers['set-cookie'] || [];
    const pick = name => {
      const line = raw.find(c => c.startsWith(name + '='));
      return line ? line.split(';')[0].split('=').slice(1).join('=') : '';
    };
    return { code, cookies: { SESSDATA: pick('SESSDATA'), bili_jct: pick('bili_jct'), DedeUserID: pick('DedeUserID') }, url: d.url || '' };
  }
  return { code };
}

/** 组装 cookie 字符串 */
function cookieString(cookies) {
  return `SESSDATA=${cookies.SESSDATA}; bili_jct=${cookies.bili_jct}; DedeUserID=${cookies.DedeUserID}`;
}

/** 登录有效性检查（nav 接口，isLogin=true） */
async function checkLogin(cookies) {
  const r = await request('https://api.bilibili.com/x/web-interface/nav', { headers: { Cookie: cookieString(cookies) } });
  try {
    const j = JSON.parse(r.text);
    return { isLogin: !!j.data?.isLogin, uname: j.data?.uname || '', level: j.data?.level_info?.current_level || 0 };
  } catch (e) { return { isLogin: false, uname: '' }; }
}

/**
 * 投稿视频（三步：预上传 → upos 上传 → add/v3 投稿）
 * @param {object} opts { cookies, filePath, fileName, title, desc, tid, tags, coverBuffer? }
 */
async function uploadVideo(opts) {
  const { cookies, filePath, fileName, title, desc = '', tid = 130, tags = '卡拉OK,歌词,VRChat' } = opts;
  const ck = cookieString(cookies);
  const fs = require('fs');
  const stat = fs.statSync(filePath);
  const fileSize = stat.size;

  // 1. 预上传
  const preUrl = `https://member.bilibili.com/preupload?name=${encodeURIComponent(fileName)}&size=${fileSize}&r=upos&profile=ugcfx/bup&ssl=0&version=2.14.0&upcdn=bda2&build=2100000&probe_version=20221109`;
  const pre = await request(preUrl, { headers: { Cookie: ck } });
  const preJ = JSON.parse(pre.text);
  if (!preJ.upos_uri) throw new Error('B站预上传失败: ' + (preJ.msg || pre.text.slice(0, 100)));
  const uposUri = preJ.upos_uri;                      // upos://bucket/path
  const bucket = uposUri.replace('upos://', '').split('/')[0];
  const osPath = uposUri.replace(`upos://${bucket}/`, '');
  const host = `upos-cs-up.${preJ.os === 'upos' ? 'acgvideo.com' : (preJ.endpoint || 'acgvideo.com')}`;

  // 2. upos 上传（小文件单请求模式：init → PUT 数据 → finish）
  const uploadHost = `https://${host}`;
  // 2.1 init
  const initUrl = `${uploadHost}/${osPath}?uploads&output=json&filesize=${fileSize}&partsize=${fileSize}&profile=ugcfx/bup&ups.ak=${preJ.upos_uri ? '' : ''}`;
  const initRes = await request(initUrl, {
    method: 'POST',
    headers: { Cookie: ck, 'X-Upos-Auth': ck },
  });
  const initJ = JSON.parse(initRes.text || '{}');
  const uploadId = initJ.upload_id;
  if (!uploadId) throw new Error('B站上传初始化失败: ' + initRes.text.slice(0, 120));

  // 2.2 PUT 数据（单分片）
  const data = fs.readFileSync(filePath);
  const putUrl = `${uploadHost}/${osPath}?partNumber=1&uploadId=${uploadId}&chunk=1&chunks=1&size=${fileSize}&start=0&end=${fileSize}&output=json`;
  const putRes = await request(putUrl, {
    method: 'PUT',
    headers: { Cookie: ck, 'X-Upos-Auth': ck, 'Content-Type': 'application/octet-stream' },
    body: data,
  });
  if (putRes.status !== 200) throw new Error('B站数据上传失败: HTTP ' + putRes.status);

  // 2.3 finish
  const finUrl = `${uploadHost}/${osPath}?output=json&name=${encodeURIComponent(fileName)}&profile=ugcfx/bup&submit=finish&os=upos&uploadId=${uploadId}&biz_id=${preJ.biz_id || 0}`;
  const finRes = await request(finUrl, { method: 'POST', headers: { Cookie: ck, 'X-Upos-Auth': ck }, body: '{}' });
  let finJ = {};
  try { finJ = JSON.parse(finRes.text || '{}'); } catch (e) {}
  if (finJ.OK !== 1 && finJ.ok !== 1) throw new Error('B站上传完成确认失败: ' + finRes.text.slice(0, 120));

  // 3. 投稿 add/v3
  const addBody = JSON.stringify({
    copyright: 1,
    source: '',
    tid,
    title: title.slice(0, 80),
    desc_format_id: 0,
    desc: String(desc || '').slice(0, 2000),
    tag: tags,
    videos: [{ filename: osPath, title: '合并投稿', desc: '' }],
    csrf: cookies.bili_jct,
    dtime: undefined,
    dynamic: '',
    open_elec: 0,
    no_reprint: 1,
    subtitle: { open: 0, lan: '', list: [] },
  });
  const addRes = await request('https://member.bilibili.com/x/vu/web/add/v3', {
    method: 'POST',
    headers: { Cookie: ck, 'Content-Type': 'application/json;charset=UTF-8', Referer: 'https://member.bilibili.com/platform/upload/video/frame' },
    body: addBody,
  });
  const addJ = JSON.parse(addRes.text || '{}');
  if (addJ.code !== 0) throw new Error('B站投稿失败: ' + (addJ.message || addJ.code));
  const aid = addJ.data?.aid || addJ.data?.id;
  const bvid = addJ.data?.bvid || '';
  return { aid, bvid, url: bvid ? `https://www.bilibili.com/video/${bvid}` : `https://www.bilibili.com/video/av${aid}` };
}

module.exports = { qrGenerate, qrPoll, cookieString, checkLogin, uploadVideo };
