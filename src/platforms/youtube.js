'use strict';

const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const { probeDuration } = require('../core/ffmpeg');

const PROXY = process.env.YTDLP_PROXY || 'http://192.168.100.1:7890';

function runYtdlp(args) {
  return new Promise((resolve, reject) => {
    const fullArgs = ['--proxy', PROXY, '--js-runtimes', `node:${process.execPath}`, ...args];
    execFile('yt-dlp', fullArgs, { maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).slice(-1500)));
      else resolve(stdout);
    });
  });
}

/**
 * 解析 YouTube json3 自动字幕 → 逐句（含精确词级时间戳）。
 * 词级绝对时间 = event.tStartMs + seg.tOffsetMs
 */
function parseJson3(jsonText) {
  const data = JSON.parse(jsonText);
  const events = data.events || [];
  const lines = [];
  for (const ev of events) {
    const segs = (ev.segs || []).filter(s => {
      const t = (s.utf8 || '').trim();
      return t !== '' && !/^\[.*\]$/.test(t); // 过滤空与 [Music]/[Applause] 等标签
    });
    if (segs.length === 0) continue;
    const evStart = ev.tStartMs || 0;
    const words = segs.map(s => ({ text: s.utf8, startMs: evStart + (s.tOffsetMs || 0) }));
    lines.push({
      startMs: words[0].startMs,
      endMs: evStart + (ev.dDurationMs || (words[words.length - 1].startMs - words[0].startMs + 500)),
      words,
    });
  }
  return lines;
}

module.exports = {
  id: 'youtube',
  name: 'YouTube',

  matches(input) {
    return /(youtube\.com|youtu\.be)/i.test(input || '');
  },

  // YouTube 搜索（yt-dlp ytsearch，走 mihomo 代理）
  async search(keywords, offset = 0, limit = 10) {
    const out = await runYtdlp([`ytsearch${limit}:${keywords}`, '--dump-single-json', '--flat-playlist', '--no-warnings']);
    const j = JSON.parse(out);
    return (j.entries || []).map(e => ({
      id: e.id,
      name: e.title || '',
      artists: e.channel || '',
      album: '',
      duration: e.duration || 0,
      fee: 0,
    }));
  },

  async fetch(input, options = {}) {
    const workDir = options.workDir;

    // 1. 视频元信息
    const infoJson = await runYtdlp(['--dump-single-json', '--no-warnings', '--skip-download', input]);
    const meta = JSON.parse(infoJson);
    const videoId = meta.id;
    const base = path.join(workDir, videoId);

    // 2. 下载音频（转 mp3，有缓存则复用）
    const audioPath = base + '.mp3';
    if (!fs.existsSync(audioPath)) {
      await runYtdlp(['-x', '--audio-format', 'mp3', '-o', base + '.%(ext)s', '--no-warnings', input]);
    }

    // 3. json3 自动字幕（按语言优先级逐个尝试；用户可选字幕语言）
    let lines = [];
    const userLang = options.subtitleLang || 'auto';
    const langOrders = {
      auto: ['zh-Hans,zh-CN,zh', 'en', 'ja', 'ko'],
      zh: ['zh-Hans,zh-CN,zh', 'en', 'ja', 'ko'],
      en: ['en', 'zh-Hans,zh-CN,zh', 'ja', 'ko'],
      ja: ['ja', 'zh-Hans,zh-CN,zh', 'en', 'ko'],
      ko: ['ko', 'zh-Hans,zh-CN,zh', 'en', 'ja'],
    };
    const subLangs = langOrders[userLang] || langOrders.auto;
    // 缓存复用：按语言优先级匹配 workDir 里已有的 json3（cleanup 不清 json3，重复生成免下载）
    const cachedByLang = fs.readdirSync(workDir)
      .filter(f => f.startsWith(videoId) && f.endsWith('.json3'))
      .map(f => ({ lang: f.slice(videoId.length + 1, -'.json3'.length), path: path.join(workDir, f) }));
    for (const lang of subLangs) {
      for (const want of lang.split(',')) {
        const hit = cachedByLang.find(c => c.lang === want);
        if (hit) {
          lines = parseJson3(fs.readFileSync(hit.path, 'utf8'));
          if (lines.length > 0) break;
        }
      }
      if (lines.length > 0) break;
    }
    for (const lang of subLangs) {
      if (lines.length > 0) break;
      try {
        await runYtdlp([
          '--skip-download', '--write-auto-sub', '--sub-format', 'json3',
          '--sub-lang', lang, '-o', base, '--no-warnings', input,
        ]);
        const json3Files = fs.readdirSync(workDir)
          .filter(f => f.startsWith(videoId) && f.endsWith('.json3'))
          .map(f => path.join(workDir, f))
          .sort();
        if (json3Files.length > 0) {
          lines = parseJson3(fs.readFileSync(json3Files[0], 'utf8'));
          if (lines.length > 0) break;
        }
      } catch (e) {
        console.log(`[提示] 字幕语言 ${lang} 下载失败:`, e.message.split('\n')[0]);
      }
    }

    if (!lines.length) throw new Error('未获取到 YouTube 字幕（该视频可能无自动字幕）');

    // 统一 lines 格式（加整句 text）
    const unifiedLines = lines.map(l => ({ ...l, text: l.words.map(w => w.text).join('') }));
    const audioMs = await probeDuration(audioPath);

    return {
      meta: { id: videoId, title: meta.title, source: 'youtube' },
      lines: unifiedLines,
      audioPath,
      audioMs,
    };
  },
};
