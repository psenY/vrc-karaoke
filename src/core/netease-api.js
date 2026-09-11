'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const api = require('NeteaseCloudMusicApi');

/** 搜索单曲（type=1），返回精简结果列表 */
async function searchSong(keywords, limit = 5, offset = 0) {
  const res = await api.search({ keywords, limit, offset, type: 1 });
  const songs = res.body?.result?.songs || [];
  return songs.map(s => ({
    id: s.id,
    name: s.name,
    artists: (s.artists || s.ar || []).map(a => a.name).join(' / '),
    album: s.album?.name || s.al?.name || '',
    duration: s.duration || s.dt || 0,
    fee: s.fee,
  }));
}

/** 获取歌词（原文 + 翻译） */
async function getLyric(songId) {
  const res = await api.lyric({ id: songId });
  const body = res.body || {};
  return {
    lrc: body.lrc?.lyric || '',
    tlyric: body.tlyric?.lyric || '',
  };
}

/** 获取歌曲播放地址（高音质需 cookie） */
async function getSongUrl(songId, cookie = '', level = 'standard') {
  const fn = api.song_url_v1 || api.song_url;
  const res = await fn({ id: songId, level, cookie });
  const data = res.body?.data || [];
  const item = data.find(d => d.id === songId) || data[0] || {};
  return {
    url: item.url || null,
    br: item.br || 0,
    type: item.type || '',
    level: item.level || '',   // 实际返回档位（可能低于请求：hires→lossless、dolby→jyeffect）
  };
}

/** 获取歌曲详情（含总时长 dt，毫秒） */
async function getSongDetail(songId) {
  const res = await api.song_detail({ ids: String(songId) });
  const s = res.body?.songs?.[0] || {};
  return {
    id: s.id,
    name: s.name,
    artists: (s.ar || []).map(a => a.name).join(' / '),
    dt: s.dt || 0,
    picUrl: s.al?.picUrl || '',
  };
}

/** 获取歌单（含歌曲列表） */
async function getPlaylist(playlistId) {
  const res = await api.playlist_detail({ id: String(playlistId) });
  const p = res.body?.playlist || {};
  return {
    name: p.name || '',
    songs: (p.tracks || []).map(t => ({
      id: t.id,
      name: t.name,
      artists: (t.ar || []).map(a => a.name).join(' / '),
    })),
  };
}

/** 网易云官方外链接口：免费歌返回真实 mp3 直链，VIP/版权歌返回 404 */
function getOuterUrl(songId) {
  return new Promise((resolve) => {
    const req = https.get(
      `https://music.163.com/song/media/outer/url?id=${songId}.mp3`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } },
      res => {
        const loc = res.headers.location || '';
        res.resume();
        resolve(loc && !loc.includes('404') ? loc : null);
      }
    );
    req.on('error', () => resolve(null));
    req.setTimeout(8000, () => { req.destroy(); resolve(null); });
  });
}

/** 二维码登录：获取 unikey */
async function getQrKey() {
  const res = await api.login_qr_key({});
  return res.body?.data?.unikey || null;
}

/** 二维码登录：生成二维码图片（base64） */
async function getQrImg(key) {
  const res = await api.login_qr_create({ key, qrimg: true });
  return res.body?.data?.qrimg || null;
}

/** 二维码登录：轮询检查状态（800等待/801已扫码/802过期/803成功含cookie） */
async function checkQrLogin(key) {
  const res = await api.login_qr_check({ key });
  const body = res.body || {};
  // 登录 cookie 在响应头（res.cookie 数组）；body.cookie 在等待扫码阶段只有 NMTID（无效）
  const fromHeaders = Array.isArray(res.cookie)
    ? res.cookie.map(c => String(c).split(';')[0]).filter(Boolean).join('; ')
    : '';
  const cookie = fromHeaders || body.cookie || '';
  return { code: body.code, cookie };
}

/** 用 cookie 获取账号信息（昵称/头像/VIP/等级） */
async function getUserInfo(cookie) {
  try {
    const res = await api.login_status({ cookie });
    const profile = res.body?.data?.profile || res.body?.profile || {};
    // 等级单独从 /user/level 接口拿（login_status 不返回）
    let level = 0;
    try {
      const lv = await api.user_level({ cookie });
      level = lv.body?.data?.level || 0;
    } catch (e) {}
    return {
      nickname: profile.nickname || '',
      avatarUrl: profile.avatarUrl || '',
      vipType: profile.vipType || 0,
      level,
    };
  } catch (e) {
    return { nickname: '', avatarUrl: '', vipType: 0, level: 0 };
  }
}

/** 下载文件到本地，自动跟随重定向 + 网络/DNS 错误自动重试 + 下载进度回调
 *  超时保护很关键：CDN 挂起时若不设超时，promise 永不 settle —— 而生成队列是串行的，
 *  该任务会永久 running、后续任务永久排队，只能重启服务。 */
function download(url, destPath, retries = 3, onProgress = null, depth = 0) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const attempt = (n) => {
      const req = mod.get(url, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (depth >= 5) return reject(new Error('重定向次数过多'));
          let next;
          try { next = new URL(res.headers.location, url).toString(); }
          catch (e) { return reject(new Error('无效的重定向地址')); }
          return download(next, destPath, 0, onProgress, depth + 1).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`下载失败 HTTP ${res.statusCode}`));
        }
        const total = parseInt(res.headers['content-length'], 10) || 0;
        let downloaded = 0;
        const file = fs.createWriteStream(destPath);
        const fail = (err) => { try { file.destroy(); } catch (e) {} reject(err); };
        res.on('data', (chunk) => {
          downloaded += chunk.length;
          if (total > 0 && typeof onProgress === 'function') onProgress(Math.min(1, downloaded / total));
        });
        res.on('error', fail);
        res.on('aborted', () => fail(new Error('下载中断（连接被对端关闭）')));
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
        file.on('error', fail);
      });
      // 空闲超时：30 秒无数据往来即断开（持续下载不受影响），避免 CDN 挂起时永久 pending
      req.setTimeout(30000, () => req.destroy(new Error('下载超时（30 秒无数据）')));
      req.on('error', (err) => {
        // 网络/DNS 错误（ENOTFOUND/ECONNRESET 等）→ 自动重试
        if (n > 1) {
          console.log(`[重试] 网络错误(${err.code || err.message})，第 ${retries - n + 2}/${retries} 次重试...`);
          setTimeout(() => attempt(n - 1), 2000);
        } else {
          reject(err);
        }
      });
    };
    attempt(retries);
  });
}

/** 列出账号歌单（先取登录 uid，再查歌单） */
async function getUserPlaylists(cookie) {
  const me = await api.login_status({ cookie });
  const profile = me.body?.data?.profile || me.body?.profile || {};
  const uid = profile.userId;
  if (!uid) return [];
  const res = await api.user_playlist({ uid: String(uid), cookie, limit: 100 });
  return ((res.body && res.body.playlist) || []).map(p => ({
    id: p.id,
    name: p.name,
    count: p.trackCount || 0,
  }));
}

module.exports = { searchSong, getLyric, getSongUrl, getSongDetail, getPlaylist, getOuterUrl, getQrKey, getQrImg, checkQrLogin, getUserInfo, getUserPlaylists, download };
