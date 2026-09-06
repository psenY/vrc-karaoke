'use strict';

const path = require('path');
const fs = require('fs');
const { searchSong, getLyric, getSongUrl, getSongDetail, getOuterUrl, download } = require('../core/netease-api');
const { parseLrc } = require('../core/lyrics');
const { probeDuration } = require('../core/ffmpeg');

/** 解析网易云链接中的歌曲 ID（music.163.com/song?id=xxx） */
function parseNeteaseUrl(input) {
  const m = String(input).match(/[?&]id=(\d+)/);
  return m ? Number(m[1]) : null;
}

async function downloadWithVerify(songId, cookie, basePath, expectedMs, maxRetries = 2, level = 'standard') {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const { url } = await getSongUrl(songId, cookie, level);
    if (!url) throw new Error('未获取到音频地址（可能是会员/无版权歌曲，或当前音质需要 VIP/SVIP 权限）');
    const ext = url.split('?')[0].endsWith('.flac') ? '.flac' : '.mp3';
    const destPath = basePath + ext;
    await download(url, destPath);
    const actualMs = await probeDuration(destPath);
    if (expectedMs <= 0 || actualMs >= expectedMs * 0.95) {
      return { durationMs: actualMs, path: destPath };
    }
    console.log(`[警告] 第 ${attempt} 次下载不完整(实际 ${(actualMs / 1000).toFixed(1)}s / 完整 ${(expectedMs / 1000).toFixed(1)}s)，重试...`);
  }
  throw new Error('音频多次下载仍不完整（大概率是试听片段，该歌曲需会员/版权），请提供 --cookie 获取完整歌曲');
}

module.exports = {
  id: 'netease',
  name: '网易云音乐',

  search: (kw) => searchSong(kw, 10),

  // 匹配网易云链接；关键词等无明确平台时由 findPlatform 回退到本平台
  matches(input) {
    return /music\.163\.com/.test(input || '');
  },

  async fetch(input, options = {}) {
    const { workDir, cookie = '', songId, onProgress } = options;

    // 1. 解析歌曲 ID
    let id = songId ? Number(songId) : null;
    let title = '';
    if (!id) {
      const urlId = parseNeteaseUrl(input);
      if (urlId) {
        id = urlId;
      } else {
        const songs = await searchSong(input, 1);
        if (!songs.length) throw new Error('未找到歌曲: ' + input);
        id = songs[0].id;
        title = `${songs[0].name} - ${songs[0].artists}`;
      }
    }

    // 2. 歌词（原文 + 翻译）
    const { lrc, tlyric } = await getLyric(id);
    if (!lrc) throw new Error('未获取到歌词');
    const parsed = parseLrc(lrc).lines;
    if (!parsed.length) throw new Error('歌词解析为空');
    // 过滤音乐制作元信息行（作词/作曲/编曲/制作人/和声等），避免混入歌词时间轴干扰显示
    const metaLineRe = /^(作词|作曲|编曲|制作人|制作|录音|混音|母带|和声|和声编写|吉他|贝斯|键盘|鼓|弦乐|监制|企划|词|曲|OP|SP|艺人统筹|配唱制作人)\s*[:：]/;
    const lyricLines = parsed.filter(l => !metaLineRe.test(l.text));
    if (!lyricLines.length) throw new Error('歌词解析为空');
    const transMap = {};
    if (tlyric) {
      for (const t of parseLrc(tlyric).lines) {
        transMap[t.time] = t.text;
      }
    }
    const lines = lyricLines.map(l => ({
      startMs: l.time,
      text: l.text,
      translation: transMap[l.time] || '',
    }));

    // 3. 音频（音质选择：standard 走 outer/url 免费 + 缓存；高品/无损走 song_url 对应音质）
    const detail = await getSongDetail(id);
    const audioLevel = options.audioLevel || 'standard';
    const cachedPath = path.join(workDir, String(id) + (audioLevel !== 'standard' ? '_' + audioLevel : '') + '.mp3');
    let audio;
    // 缓存命中：已有完整音频（时长匹配），跳过下载
    if (fs.existsSync(cachedPath)) {
      try {
        const cachedMs = await probeDuration(cachedPath);
        if (detail.dt <= 0 || cachedMs >= detail.dt * 0.95) {
          audio = { durationMs: cachedMs, path: cachedPath };
        }
      } catch (e) {}
    }
    if (!audio) {
      if (audioLevel !== 'standard') {
        // 高品(320k)/无损(FLAC)：直接用 song_url 对应音质（需 VIP/SVIP cookie）
        audio = await downloadWithVerify(id, cookie, path.join(workDir, String(id) + '_' + audioLevel), detail.dt || 0, 2, audioLevel);
      } else {
        const outerUrl = await getOuterUrl(id);
        if (outerUrl) {
          await download(outerUrl, cachedPath, 3, onProgress);
          audio = { durationMs: await probeDuration(cachedPath), path: cachedPath };
        } else {
          audio = await downloadWithVerify(id, cookie, path.join(workDir, String(id)), detail.dt || 0);
        }
      }
    }

    if (!title && detail.name) {
      title = `${detail.name} - ${detail.artists}`;
    }

    return {
      meta: { id: String(id), title, source: 'netease', coverUrl: detail.picUrl || '' },
      lines,
      audioPath: audio.path,
      audioMs: audio.durationMs,
    };
  },
};
