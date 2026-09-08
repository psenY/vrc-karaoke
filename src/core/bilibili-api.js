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

async function request(url, { method = 'GET', headers = {}, body = null, timeoutMs = 30000 } = {}) {
  // 用 node 22 内置 fetch（undici）：header/body/Content-Length 处理更标准，upos 网关兼容性好
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: { 'User-Agent': UA, ...headers },
      body: body === null || body === undefined ? undefined : body,
      signal: ac.signal,
    });
    const text = await res.text();
    const h = {};
    res.headers.forEach((v, k) => { h[k] = v; });
    // set-cookie 需要特殊取（多个）
    try { h['set-cookie'] = res.headers.getSetCookie ? res.headers.getSetCookie() : (h['set-cookie'] ? [h['set-cookie']] : []); } catch (e) {}
    return { status: res.status, headers: h, text };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 从 URL 下载图片并上传到B站图床（投稿封面用）。返回图床 URL。
 * 封面上传接口：POST x/vu/web/cover/up（form: fileUp=@图片, csrf）→ data.url
 */
async function uploadCoverFromUrl(cookies, imageUrl) {
  // 1. 下载图片（buffer，通用重定向跟随最多 3 次——CDN 可能多级 302）
  const img = await new Promise((resolve, reject) => {
    const fetchBuf = (u, redirects) => {
      const mod = u.startsWith('https') ? https : http;
      const req = mod.get(u, { headers: { 'User-Agent': UA } }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 3) {
          res.resume();
          return fetchBuf(res.headers.location, redirects + 1);
        }
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, buf: Buffer.concat(chunks), type: res.headers['content-type'] || '' }));
      });
      req.on('error', reject);
      req.setTimeout(30000, () => req.destroy(new Error('封面下载超时')));
    };
    fetchBuf(imageUrl, 0);
  });
  if (img.status !== 200 || !img.buf.length) throw new Error('封面下载失败 HTTP ' + img.status);

  // 2. 上传到B站图床（对齐 biliup：form 编码 data:image/jpeg;base64 + csrf，非 multipart）
  const dataUrl = 'data:image/jpeg;base64,' + img.buf.toString('base64');
  const params = new URLSearchParams({ cover: dataUrl, csrf: cookies.bili_jct });
  const formBody = params.toString();

  const upRes = await request('https://member.bilibili.com/x/vu/web/cover/up', {
    method: 'POST',
    headers: {
      Cookie: cookieString(cookies),
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      Referer: 'https://member.bilibili.com/',
      Origin: 'https://member.bilibili.com',
    },
    body: formBody,
  });
  let j = {};
  try { j = JSON.parse(upRes.text || '{}'); } catch (e) {}
  if (j.code !== 0 || !j.data || !j.data.url) throw new Error('封面上传失败: ' + (j.message || upRes.text.slice(0, 80)));
  return j.data.url;
}

/**
 * WBI 签名（w_rid/wts）：B 站部分接口要求对 query 做签名，缺失/错误时参数可能被静默忽略。
 * 实现：nav 接口取 img_key/sub_key → 按混淆表重排得 mixin_key → query 参数排序拼接 + wts → MD5。
 */
const WBI_MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52,
];
let wbiKeyCache = { keys: null, ts: 0 };
async function getWbiKeys() {
  if (wbiKeyCache.keys && Date.now() - wbiKeyCache.ts < 12 * 60 * 60 * 1000) return wbiKeyCache.keys;
  const r = await request('https://api.bilibili.com/x/web-interface/nav', { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const j = JSON.parse(r.text || '{}');
  const wbi = (j.data && j.data.wbi_img) || {};
  const img = (wbi.img_url || '').split('/').pop().split('.')[0];
  const sub = (wbi.sub_url || '').split('/').pop().split('.')[0];
  if (!img || !sub) throw new Error('WBI key 获取失败');
  const raw = img + sub;
  const keys = WBI_MIXIN_TAB.map(i => raw[i]).join('').slice(0, 32);
  wbiKeyCache = { keys, ts: Date.now() };
  return keys;
}
async function wbiSign(params) {
  const mixin = await getWbiKeys();
  const p = { ...params, wts: Math.floor(Date.now() / 1000) };
  const q = Object.keys(p)
    .filter(k => p[k] !== undefined && p[k] !== null)
    .sort()
    .map(k => `${k}=${encodeURIComponent(String(p[k]).replace(/[!'()*]/g, ''))}`)
    .join('&');
  const crypto = require('crypto');
  const w_rid = crypto.createHash('md5').update(q + mixin).digest('hex');
  return { w_rid, wts: p.wts, _q: q };
}

/** node http 原版请求（用于 upos init/finish：需要显式 Content-Length: 0，fetch/undici 会剥离 CL） */
function requestRaw(url, { method = 'GET', headers = {}, body = null, timeoutMs = 30000 } = {}) {
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
  // 服务端本地生成二维码图（qrcode 包，data URI）——不依赖第三方渲染服务
  const QRCode = require('qrcode');
  const qrimg = await QRCode.toDataURL(j.data.url, { width: 220, margin: 1 });
  return { qrUrl: j.data.url, qrcodeKey: j.data.qrcode_key, qrimg };
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
  const { cookies, filePath: rawFilePath, fileName: rawFileName, title, desc = '', tid = 130, tags = '卡拉OK,歌词,VRChat', onProgress = null, seasonId = 0, coverImageUrl = '', losslessMusic = false } = opts;
  const report = (phase, extra = {}) => { try { onProgress && onProgress({ phase, ...extra }); } catch (e) {} };
  const ck = cookieString(cookies);
  const fs = require('fs');
  let filePath = rawFilePath;
  let fileName = rawFileName;
  // Hi-Res 投稿：MP4 内 FLAC 音轨 B 站转码器不识别（降级 AAC）→ 转封装 MKV+FLAC（流复制无损，秒级）
  if (losslessMusic && /\.mp4$/i.test(filePath)) {
    const mkvPath = filePath.replace(/\.mp4$/i, '') + '_bili.mkv';
    await new Promise((resolve, reject) => {
      const { spawn } = require('child_process');
      const ff = spawn('ffmpeg', ['-y', '-v', 'error', '-i', filePath, '-c', 'copy', mkvPath]);
      ff.on('close', code => code === 0 ? resolve() : reject(new Error('MKV 转封装失败 exit ' + code)));
      ff.on('error', reject);
    });
    filePath = mkvPath;
    fileName = path.basename(mkvPath);
  }
  const stat = fs.statSync(filePath);
  const fileSize = stat.size;

  // 1. 预上传
  const preUrl = `https://member.bilibili.com/preupload?name=${encodeURIComponent(fileName)}&size=${fileSize}&r=upos&profile=ugcupos/bup&ssl=0&version=2.8.12&upcdn=bda2&build=2081200`;
  report('preupload');
  const pre = await request(preUrl, { headers: { Cookie: ck } });
  const preJ = JSON.parse(pre.text);
  if (!preJ.upos_uri) throw new Error('B站预上传失败: ' + (preJ.msg || pre.text.slice(0, 100)));
  const uposUri = preJ.upos_uri;                      // upos://bucket/path
  // osPath = 去掉 upos:// 前缀的完整路径（保留 bucket 段，对齐 biliup：https://endpoint/bucket/path）
  const osPath = uposUri.replace(/^upos:\/\//, '');
  // 上传域名用 preupload 返回的 endpoint（如 //upos-cs-upcdnbda2.bilivideo.com），旧 acgvideo.com 域名已废弃
  const host = String(preJ.endpoint || '//upos-cs-upcdnbda2.bilivideo.com').replace(/^\/\//, '');

  // 2. upos 分片上传（严格对齐 biliup 协议：init=POST / 分片 PUT / finish=POST+parts JSON）
  //    注意 upos 对无 body 的 PUT 返回 411（MissingContentLength），init/finish 必须用 POST
  const uploadHost = `https://${host}`;

  // 2.1 init（POST ?uploads&output=json → upload_id）
  const initRes = await requestRaw(`${uploadHost}/${osPath}?uploads&output=json`, {
    method: 'POST', headers: { 'X-Upos-Auth': preJ.auth, 'Content-Length': 0 },
  });
  const initJ = JSON.parse(initRes.text || '{}');
  const uploadId = initJ.upload_id;
  if (!uploadId) throw new Error('B站上传初始化失败: ' + initRes.text.slice(0, 600));

  // 2.2 分片 PUT（10MB/片，与 biliup chunk_size 一致；串行，超时按大小给足）
  const data = fs.readFileSync(filePath);
  const CHUNK = preJ.chunk_size || 10485760;
  const chunks = Math.ceil(fileSize / CHUNK);
  report('uploading', { chunk: 0, chunks, totalMB: +(fileSize / 1048576).toFixed(1) });
  for (let c = 0; c < chunks; c++) {
    const start = c * CHUNK;
    const size = Math.min(CHUNK, fileSize - start);
    report('uploading', { chunk: c + 1, chunks, uploadedMB: +(Math.min(start + size, fileSize) / 1048576).toFixed(1), totalMB: +(fileSize / 1048576).toFixed(1) });
    const q = new URLSearchParams({
      partNumber: c + 1, uploadId, chunk: c, chunks,
      size, start, end: start + size, total: fileSize,
    });
    const putRes = await request(`${uploadHost}/${osPath}?${q}`, {
      method: 'PUT',
      headers: { 'X-Upos-Auth': preJ.auth, 'Content-Type': 'application/octet-stream' },
      body: data.subarray(start, start + size),
      timeoutMs: Math.max(300000, size / 1024),
    });
    if (putRes.status !== 200) throw new Error(`B站分片上传失败(第${c + 1}/${chunks}片): HTTP ${putRes.status} ` + putRes.text.slice(0, 100));
  }

  report('finish');
  // 2.3 finish（POST ?name&uploadId&biz_id&output=json&profile=ugcupos/bup + parts JSON）
  const parts = Array.from({ length: chunks }, (_, i) => ({ partNumber: i + 1, eTag: 'etag' }));
  const finQ = new URLSearchParams({
    name: fileName, uploadId, biz_id: preJ.biz_id || 0,
    output: 'json', profile: 'ugcupos/bup',
  });
  const finRes = await request(`${uploadHost}/${osPath}?${finQ}`, {
    method: 'POST', headers: { 'X-Upos-Auth': preJ.auth }, body: JSON.stringify({ parts }),
  });
  let finJ = {};
  try { finJ = JSON.parse(finRes.text || '{}'); } catch (e) {}
  if (finJ.OK !== 1) throw new Error('B站上传完成确认失败: ' + finRes.text.slice(0, 120));

  report('publish');
  // 2.5 封面（可选：从 URL 下载后上传到B站图床，add/v3 用返回的图片 URL；失败降级=自动截帧）
  let coverUrl = '';
  if (coverImageUrl) {
    try {
      coverUrl = await uploadCoverFromUrl(cookies, coverImageUrl);
      console.log('[B站封面] 上传成功:', coverUrl.slice(0, 60));
    } catch (e) {
      console.log('[B站封面] 上传失败(降级自动截帧):', e.message);
    }
  }

  // 3. 投稿 add/v3（body 逐字段对齐 2026-09 网页端真实抓包：web_os=1/no_reprint=0/recreate=0/videos带cid/creation_statement/watermark等）
  const addBody = JSON.stringify({
    ...(coverUrl ? { cover: coverUrl, cover43: coverUrl } : {}),
    ai_cover: 0,
    is_ab_cover: 0,
    ab_cover_info: null,
    title: title.slice(0, 80),
    copyright: 1,
    creation_statement: { id: -1 },
    human_type2: 1003,
    tid,
    tag: tags,
    desc: String(desc || '').slice(0, 2000),
    dynamic: '',
    recreate: 0,
    interactive: 0,
    videos: [{ filename: osPath.split("/").pop().replace(/\.[^.]*$/, ""), title: title.slice(0, 80), desc: "" }],
    act_reserve_create: 0,
    act_reserve_create_title: '',
    no_disturbance: 0,
    is_only_self: 0,
    space_hidden: 2,
    watermark: { state: 1 },
    subtitle: { open: 0, lan: '' },
    no_reprint: 0,
    up_selection_reply: false,
    up_close_reply: false,
    up_close_danmu: false,
    dolby: 0,
    lossless_music: losslessMusic ? 1 : 0,  // 无损音乐=Hi-Res 金标
    web_os: 1,
    csrf: cookies.bili_jct,
    ...(seasonId ? { season_id: seasonId } : {}),
  });
  // URL：ts+csrf+WBI 签名（w_rid/wts，网页端带，缺签名疑被静默降级）
  const wbi = await wbiSign({ t: Date.now(), csrf: cookies.bili_jct });
  const addRes = await request(`https://member.bilibili.com/x/vu/web/add/v3?${wbi._q}&w_rid=${wbi.w_rid}&wts=${wbi.wts}&web_location=333.1024`, {
    method: 'POST',
    headers: {
      Cookie: ck,
      'Content-Type': 'application/json;charset=UTF-8',
      Referer: 'https://member.bilibili.com/platform/upload/video/frame',
      Origin: 'https://member.bilibili.com',
    },
    body: addBody,
  });
  const addJ = JSON.parse(addRes.text || '{}');
  if (addJ.code !== 0) throw new Error('B站投稿失败: ' + (addJ.message || addJ.code));
  console.log('[B站投稿debug] lossless_music已发送, 响应data字段:', Object.keys(addJ.data || {}).join(','), '| cid:', addJ.data?.cid);
  const aid = addJ.data?.aid || addJ.data?.id;
  const bvid = addJ.data?.bvid || '';
  // 清理临时 MKV（Hi-Res 转封装副本，原始 MP4 保留）
  try { if (filePath !== rawFilePath && fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (e) {}
  return { aid, bvid, url: bvid ? `https://www.bilibili.com/video/${bvid}` : `https://www.bilibili.com/video/av${aid}` };
}

/** 创作中心合集列表（用于投稿时选择自动加入） */
async function listSeasons(cookies) {
  const r = await request('https://member.bilibili.com/x2/creative/web/seasons?pn=1&ps=50', { headers: { Cookie: cookieString(cookies), Referer: 'https://member.bilibili.com/' } });
  try {
    const j = JSON.parse(r.text);
    return (j.data && j.data.seasons || []).map(s => ({
      id: s.season.id,
      title: s.season.title,
      sectionId: (s.sections && s.sections.sections && s.sections.sections[0] && s.sections.sections[0].id) || 0,
      total: (s.sections && s.sections.sections && s.sections.sections[0] && s.sections.sections[0].epCount) || 0,
    }));
  } catch (e) { return []; }
}

/**
 * 查询B站视频是否仍存在（无需登录的 view 接口）。
 * @returns {Promise<boolean>} true=存在 code 0；false=已删除 code -404/-403；其他错误抛出
 */
async function checkVideoExists(bvid, cookies = null) {
  const headers = cookies ? { Cookie: cookieString(cookies) } : {};
  // 阶段1: view 单查（1 请求）——code 0 = 已公开，确定存在（多数场景一轮结束）
  const r = await request(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`, { headers });
  let j = {};
  try { j = JSON.parse(r.text || '{}'); } catch (e) {}
  if (j.code === 0) return true;  // 已公开
  // 阶段2: view 非 0（62002 未公开/审核中 或 -404 等）→ 创作中心稿件列表权威判定
  //        在稿件列表 = 存在（未公开/审核中）；不在 = 已删除
  const ck = cookies ? cookieString(cookies) : '';
  for (let pn = 1; pn <= 2; pn++) {
    const r2 = await request(`https://member.bilibili.com/x2/creative/web/archives/sp?pn=${pn}&ps=20&status=all`, {
      headers: { Cookie: ck, Referer: 'https://member.bilibili.com/platform/upload/video' },
    });
    let j2 = {};
    try { j2 = JSON.parse(r2.text || '{}'); } catch (e) {}
    const arcs = (j2.data && j2.data.arc_audits) || [];
    for (const a of arcs) {
      if ((a.Archive || {}).bvid === bvid) return true;
    }
    if (arcs.length < 20) break;  // 最后一页
  }
  return false;  // 已删除（前 2 页 40 条未找到）
}

/**
 * 投稿后把视频补挂进合集（add/v3 的 season_id 不生效，必须事后 episodes/add，csrf 放 query）。
 */
async function addToSeason(cookies, { bvid, aid: aidIn, cid: cidIn, title, seasonId, sectionId }) {
  let aid = aidIn, cid = cidIn;
  if ((!cid || !aid) && bvid) {
    const v = await request(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, { headers: { Cookie: cookieString(cookies) } });
    try { const d = JSON.parse(v.text).data || {}; cid = cid || d.cid; aid = aid || d.aid; } catch (e) {}
  }
  if (!aid || !cid) throw new Error('无法获取视频 aid/cid，合集补挂失败');
  const q = new URLSearchParams({ csrf: cookies.bili_jct });
  const body = {
    episodes: [{ aid: Number(aid), cid: Number(cid), title: title || '' }],
    sectionId: Number(sectionId),
    seasonId: Number(seasonId),
    csrf: cookies.bili_jct,
  };
  const r = await request(`https://member.bilibili.com/x2/creative/web/season/section/episodes/add?${q}`, {
    method: 'POST',
    headers: {
      Cookie: cookieString(cookies),
      'Content-Type': 'application/json;charset=UTF-8',
      Referer: 'https://member.bilibili.com/',
      Origin: 'https://member.bilibili.com',
    },
    body: JSON.stringify(body),
  });
  let j = {};
  try { j = JSON.parse(r.text || '{}'); } catch (e) {}
  if (j.code !== 0) throw new Error('合集补挂失败: ' + (j.message || r.text.slice(0, 100)));
  return { ok: true };
}

module.exports = { qrGenerate, qrPoll, cookieString, checkLogin, uploadVideo, listSeasons, addToSeason, uploadCoverFromUrl, checkVideoExists };
