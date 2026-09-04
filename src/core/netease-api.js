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

/** 下载文件到本地，自动跟随重定向 */
function download(url, destPath) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return download(res.headers.location, destPath).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`下载失败 HTTP ${res.statusCode}`));
      }
      const file = fs.createWriteStream(destPath);
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
      file.on('error', reject);
    });
    req.on('error', reject);
  });
}

module.exports = { searchSong, getLyric, getSongUrl, getSongDetail, download };
