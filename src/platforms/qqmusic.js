'use strict';

const https = require('https');
const path = require('path');
const { parseLrc } = require('../core/lyrics');
const { probeDuration } = require('../core/ffmpeg');
const { download } = require('../core/netease-api');

function getJson(url, referer) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: referer ? { Referer: referer } : {} }, res => {
      let d = '';
      res.on('data', c => { d += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch (e) { reject(new Error('JSON 解析失败: ' + d.slice(0, 100))); }
      });
    });
    req.on('error', reject);
  });
}

// QQ 音乐搜索：旧 client_search_cp GET 接口已被腾讯下线（返回空 body），
// 迁移到 musicu.fcg POST 接口（music.search.SearchCgiService）
function searchSong(keywords, limit = 5, page = 1) {
  const payload = {
    'music.search.SearchCgiService': {
      method: 'DoSearchForQQMusicDesktop',
      module: 'music.search.SearchCgiService',
      param: { query: keywords, search_type: 0, num_per_page: limit, page_num: page },
    },
  };
  const opt = {
    hostname: 'u.y.qq.com',
    path: '/cgi-bin/musicu.fcg',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Referer: 'https://y.qq.com/',
      Origin: 'https://y.qq.com',
    },
  };
  const data = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = https.request(opt, res => {
      let d = '';
      res.on('data', c => { d += c; });
      res.on('end', () => {
        try {
          const r = JSON.parse(d);
          const songs = (r['music.search.SearchCgiService']?.data?.body?.song?.list || []).map(s => ({
            id: s.mid || s.songmid,
            name: s.name || s.songname,
            artists: (s.singer || []).map(x => x.name).join(' / '),
            album: (s.album || {}).name || '',
            interval: s.interval || 0, // 秒
            duration: (s.interval || 0) * 1000, // 统一毫秒
            payplay: s.pay?.payplay || 0,
          }));
          resolve(songs);
        } catch (e) { reject(new Error('QQ 搜索解析失败: ' + d.slice(0, 80))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('QQ 搜索超时')));
    req.write(data);
    req.end();
  });
}

function getLyric(songmid) {
  const url = `https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=${songmid}&format=json&nobase64=1`;
  return getJson(url, 'https://y.qq.com').then(r => ({
    lrc: r.lyric || '',
    tlyric: r.trans || '',
  }));
}

function getSongUrl(songmid) {
  const data = JSON.stringify({
    req_0: {
      module: 'vkey.GetVkeyServer',
      method: 'CgiGetVkey',
      param: {
        guid: '1234567890',
        songmid: [songmid],
        songtype: [0],
        uin: '0',
        loginflag: 1,
        platform: '20',
      },
    },
  });
  return getJson(`https://u.y.qq.com/cgi-bin/musicu.fcg?data=${encodeURIComponent(data)}`).then(r => {
    const info = r.req_0?.data?.midurlinfo?.[0] || {};
    return { url: info.purl ? `http://ws.stream.qqmusic.qq.com/${info.purl}` : null };
  });
}

/** 解析 QQ音乐链接中的 songmid（y.qq.com/n/ryqq/songDetail/<mid> 等） */
function parseQqUrl(input) {
  const m = String(input).match(/songDetail\/([0-9A-Za-z]+)/) || String(input).match(/[?&]songmid=([0-9A-Za-z]+)/);
  return m ? m[1] : null;
}

module.exports = {
  id: 'qqmusic',
  name: 'QQ音乐',

  search: (kw, offset = 0, limit = 10) => searchSong(kw, limit, Math.floor(offset / limit) + 1),  // offset → 页码

  matches(input) {
    return /y\.qq\.com/.test(input || '');
  },

  async fetch(input, options = {}) {
    const { workDir } = options;

    // 1. 解析/搜索歌曲
    let songmid = parseQqUrl(input);
    let title = '';
    if (!songmid) {
      const songs = await searchSong(input, 1);
      if (!songs.length) throw new Error('未找到歌曲: ' + input);
      songmid = songs[0].id;
      title = `${songs[0].name} - ${songs[0].artists}`;
    }

    // 2. 歌词（原文 + 翻译）
    const { lrc, tlyric } = await getLyric(songmid);
    if (!lrc) throw new Error('未获取到歌词');
    const parsed = parseLrc(lrc).lines;
    if (!parsed.length) throw new Error('歌词解析为空');
    const transMap = {};
    if (tlyric) {
      for (const t of parseLrc(tlyric).lines) transMap[t.time] = t.text;
    }
    const lines = parsed.map(l => ({
      startMs: l.time,
      text: l.text,
      translation: transMap[l.time] || '',
    }));

    // 3. 歌曲 URL + 下载
    const { url } = await getSongUrl(songmid);
    if (!url) throw new Error('未获取到播放地址（QQ音乐歌曲下载有 IP 风控 invalidq，需登录 cookie）');
    const audioPath = path.join(workDir, songmid + '.m4a');
    await download(url, audioPath);
    const audioMs = await probeDuration(audioPath);

    return {
      meta: { id: songmid, title, source: 'qqmusic' },
      lines,
      audioPath,
      audioMs,
    };
  },
};
