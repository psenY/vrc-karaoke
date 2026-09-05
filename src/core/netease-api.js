'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const api = require('NeteaseCloudMusicApi');

/** 搜索单曲（type=1），返回精简结果列表 */
async function searchSong(keywords, limit = 5) {
  const res = await api.search({ keywords, limit, type: 1 });
  const songs = res.body?.result?.songs || [];
  return songs.map(s => ({
    id: s.id,
    name: s.name,
    artists: (s.artists || s.ar || []).map(a => a.name).join(' / '),
    album: s.album?.name || s.al?.name || '',
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
async function getSongUrl(songId, cookie = '') {
  const fn = api.song_url_v1 || api.song_url;
  const res = await fn({ id: songId, level: 'standard', cookie });
  const data = res.body?.data || [];
  const item = data.find(d => d.id === songId) || data[0] || {};
  return {
    url: item.url || null,
    br: item.br || 0,
    type: item.type || '',
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
  return { code: body.code, cookie: body.cookie || '' };
}

/** 用 cookie 获取账号信息（昵称） */
async function getUserInfo(cookie) {
  try {
    const res = await api.login_status({ cookie });
    const profile = res.body?.data?.profile || res.body?.profile || {};
    return { nickname: profile.nickname || '' };
  } catch (e) {
    return { nickname: '' };
  }
}

/** 下载文件到本地，自动跟随重定向 + 网络/DNS 错误自动重试 + 下载进度回调 */
function download(url, destPath, retries = 3, onProgress = null) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const attempt = (n) => {
      const req = mod.get(url, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return download(res.headers.location, destPath, 0, onProgress).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`下载失败 HTTP ${res.statusCode}`));
        }
        const total = parseInt(res.headers['content-length'], 10) || 0;
        let downloaded = 0;
        const file = fs.createWriteStream(destPath);
        res.on('data', (chunk) => {
          downloaded += chunk.length;
          if (total > 0 && typeof onProgress === 'function') onProgress(Math.min(1, downloaded / total));
        });
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
        file.on('error', reject);
      });
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

module.exports = { searchSong, getLyric, getSongUrl, getSongDetail, getPlaylist, getOuterUrl, getQrKey, getQrImg, checkQrLogin, getUserInfo, download };
