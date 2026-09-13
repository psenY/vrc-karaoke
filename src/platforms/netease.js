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
    const { url, br, type, level: actualLevel } = await getSongUrl(songId, cookie, level);
    if (!url) throw new Error('未获取到音频地址（可能是会员/无版权歌曲，或当前音质需要 VIP/SVIP 权限）');
    const ext = url.split('?')[0].endsWith('.flac') ? '.flac' : '.mp3';
    const destPath = basePath + ext;
    await download(url, destPath);
    const actualMs = await probeDuration(destPath);
    if (expectedMs <= 0 || actualMs >= expectedMs * 0.95) {
      return { durationMs: actualMs, path: destPath, actualLevel: actualLevel || '', actualBr: br || 0, actualType: type || '' };
    }
    console.log(`[警告] 第 ${attempt} 次下载不完整(实际 ${(actualMs / 1000).toFixed(1)}s / 完整 ${(expectedMs / 1000).toFixed(1)}s)，重试...`);
  }
  throw new Error('音频多次下载仍不完整（大概率是试听片段，该歌曲需会员/版权），请提供 --cookie 获取完整歌曲');
}

module.exports = {
  id: 'netease',
  name: '网易云音乐',

  search: (kw, offset = 0) => searchSong(kw, 10, offset),

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
    const transMap = {};
    if (tlyric) {
      for (const t of parseLrc(tlyric).lines) {
        transMap[t.time] = t.text;
      }
    }
    const lines = parsed.map(l => ({
      startMs: l.time,
      text: l.text,
      endMs: l.endMs,          // 空行标记的结束时间（有则当前句在该时刻隐藏）
      translation: transMap[l.time] || '',
    }));

    // 3. 音频（音质选择：standard 走 outer/url 免费 + 缓存；高品/无损走 song_url 对应音质）
    const detail = await getSongDetail(id);
    const audioLevel = options.audioLevel || 'standard';
    // 缓存按「请求档位」命名，实际格式由下载决定（.flac / .mp3），并配一份 .meta.json 记录真实档位。
    // 命中必须同时满足：①时长匹配 ②meta.actualLevel 与请求档位一致。
    // —— 只比时长是不够的：cookie 临时失效时会下载到降级音质，若被当作正常缓存留下，
    //    之后无论怎样重新生成都会命中这个低音质文件、再也拿不回无损（2026-09-13 实际踩到）。
    const cacheBase = path.join(workDir, String(id) + (audioLevel !== 'standard' ? '_' + audioLevel : ''));
    const cachedPath = cacheBase + '.mp3';   // standard 档沿用旧命名
    let audio;
    if (audioLevel !== 'standard') {
      for (const ext of ['.flac', '.mp3']) {
        const p = cacheBase + ext;
        if (!fs.existsSync(p)) continue;
        let meta = null;
        try { meta = JSON.parse(fs.readFileSync(cacheBase + '.meta.json', 'utf8')); } catch (e) {}
        const ms = await probeDuration(p).catch(() => 0);
        const okDuration = detail.dt <= 0 || ms >= detail.dt * 0.95;
        const okLevel = !!(meta && meta.actualLevel === audioLevel);
        if (okDuration && okLevel) {
          audio = { durationMs: ms, path: p, actualLevel: meta.actualLevel, actualBr: meta.br || 0, actualType: meta.type || '' };
          console.log(`[音源缓存] 命中 ${path.basename(p)}（${meta.actualLevel} ${meta.br || ''}）`);
          break;
        }
        // 无效缓存（降级遗留或档位不符）：直接删掉，避免一直被误用
        console.log(`[音源缓存] 丢弃无效缓存 ${path.basename(p)}（实际档位 ${meta ? meta.actualLevel : '未知'}，请求 ${audioLevel}）`);
        try { fs.unlinkSync(p); } catch (e) {}
        try { fs.unlinkSync(cacheBase + '.meta.json'); } catch (e) {}
      }
    } else if (fs.existsSync(cachedPath)) {
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
        audio = await downloadWithVerify(id, cookie, cacheBase, detail.dt || 0, 2, audioLevel);
        // 只有「实际拿到的档位 == 请求档位」才写缓存；降级结果用完即弃，下次会重新尝试下载
        if (!audio.actualLevel || audio.actualLevel === audioLevel) {
          try {
            fs.writeFileSync(cacheBase + '.meta.json', JSON.stringify({
              actualLevel: audio.actualLevel || '', br: audio.actualBr || 0, type: audio.actualType || '',
              durationMs: audio.durationMs || 0, cachedAt: Date.now(),
            }));
          } catch (e) {}
        } else {
          console.log(`[音源缓存] 实际档位 ${audio.actualLevel} 低于请求 ${audioLevel}，不写入缓存（避免低音质文件被固化）`);
        }
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
      meta: {
        id: String(id), title, artist: detail.artists || '', source: 'netease', coverUrl: detail.picUrl || '',
        actualLevel: audio.actualLevel || '', actualBr: audio.actualBr || 0, actualType: audio.actualType || '',
        requestedLevel: audioLevel,
      },
      lines,
      audioPath: audio.path,
      audioMs: audio.durationMs,
    };
  },
};
