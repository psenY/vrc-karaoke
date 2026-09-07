'use strict';

const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const { probeDuration } = require('../core/ffmpeg');
const { download } = require('../core/netease-api');

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 13_2_3 like Mac OS X) AppleWebKit/605.1.15';

function get(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': UA } }, res => {
      let d = '';
      res.on('data', c => { d += c; });
      res.on('end', () => resolve(d));
    });
    req.on('error', reject);
  });
}

/** 解析酷我搜索的纯文本 KEY=VALUE 格式 */
function parseSearch(text) {
  const songs = [];
  let cur = {};
  const flush = () => { if (cur.id) songs.push(cur); cur = {}; };
  for (const line of String(text).split('\n')) {
    const l = line.trim();
    if (!l) { flush(); continue; }
    const idx = l.indexOf('=');
    if (idx < 0) continue;
    const key = l.slice(0, idx);
    const val = l.slice(idx + 1);
    if (key === 'MUSICRID') cur.id = val.replace('MUSIC_', '');
    else if (key === 'SONGNAME' || key === 'NAME') cur.name = val;
    else if (key === 'ARTIST') cur.artist = val;
    else if (key === 'DURATION') cur.duration = parseInt(val, 10) || 0;
    else if (key === 'ALBUM') cur.album = val;
  }
  flush();
  return songs;
}

function searchSong(keywords, limit = 5) {
  const url = `http://search.kuwo.cn/r.s?client=kt&all=${encodeURIComponent(keywords)}&pn=0&rn=${limit}&ft=music&strformat=json&encoding=utf8&mobi=1`;
  return get(url).then(parseSearch).then(songs => songs.map(s => ({
    id: s.id,
    name: s.name,
    artists: s.artist,
    album: s.album,
    duration: (s.duration || 0) * 1000,   // 酷我返回秒 → 统一毫秒（前端 fmtDuration 按毫秒）
  })));
}

function getLyric(musicId) {
  const url = `http://m.kuwo.cn/newh5/singles/songinfoandlrc?musicId=${musicId}&httpsStatus=1`;
  return get(url).then(text => {
    try {
      const j = JSON.parse(text);
      const list = j.data?.lrclist || [];
      return { lines: list.map(x => ({ startMs: Math.round(parseFloat(x.time) * 1000), text: x.lineLyric || '' })) };
    } catch (e) {
      return { lines: [] };
    }
  });
}

function getSongUrl(musicId) {
  const url = `http://antiserver.kuwo.cn/anti.s?type=convert_url&rid=${musicId}&format=mp3&response=url`;
  return get(url).then(text => ({ url: text.trim().startsWith('http') ? text.trim() : null }));
}

function parseKuwoUrl(input) {
  const m = String(input).match(/play_detail\/(\d+)/)
    || String(input).match(/yinyue\/(\d+)/)
    || String(input).match(/(?:musicId|rid|mid)[=/](\d+)/);
  return m ? m[1] : null;
}

module.exports = {
  id: 'kuwo',
  name: '酷我音乐',

  search: (kw, offset = 0) => searchSong(kw, 5),

  matches(input) {
    return /kuwo\.cn/.test(input || '');
  },

  async fetch(input, options = {}) {
    const { workDir } = options;

    // 1. 解析/搜索
    let musicId = parseKuwoUrl(input);
    let title = '';
    if (!musicId) {
      const songs = await searchSong(input, 1);
      if (!songs.length) throw new Error('未找到歌曲: ' + input);
      musicId = songs[0].id;
      title = `${songs[0].name} - ${songs[0].artists}`;
    }

    // 2. 歌词
    const { lines } = await getLyric(musicId);
    if (!lines.length) throw new Error('酷我歌词接口暂不可用（可能被风控），请改用网易云/YouTube');

    // 3. 歌曲 URL + 下载 + 时长验证（拦截试听片段）
    const { url } = await getSongUrl(musicId);
    if (!url) throw new Error('未获取到播放地址');
    const audioPath = path.join(workDir, musicId + '.mp3');
    await download(url, audioPath);
    const audioMs = await probeDuration(audioPath);
    const lyricEndMs = lines[lines.length - 1]?.startMs || 0;
    // 试听片段判定：绝对阈值(<45s) + 歌词长但音频明显短（纯音乐无歌词也能拦截）
    if (audioMs < 45000 || (lyricEndMs > 60000 && audioMs < lyricEndMs * 0.5)) {
      try { fs.unlinkSync(audioPath); } catch (e) {}  // 试听不进缓存，避免下次复用
      throw new Error('音频是试听片段（酷我免费接口限制），需会员获取完整歌曲');
    }

    return {
      meta: { id: musicId, title, source: 'kuwo' },
      lines,
      audioPath,
      audioMs,
    };
  },
};
