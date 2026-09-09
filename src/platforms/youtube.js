'use strict';

const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const { probeDuration } = require('../core/ffmpeg');

const PROXY = process.env.YTDLP_PROXY || 'http://192.168.100.1:7890';

function runYtdlp(args, onLine = null) {
  return new Promise((resolve, reject) => {
    const fullArgs = ['--proxy', PROXY, '--js-runtimes', `node:${process.execPath}`, ...args];
    const child = execFile('yt-dlp', fullArgs, { maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).slice(-1500)));
      else resolve(stdout);
    });
    // 逐行回调（下载进度：--newline 时 [download] xx.x% 每块刷新一行）
    if (typeof onLine === 'function') {
      let buf = '';
      child.stdout.on('data', c => {
        buf += c.toString();
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (line) onLine(line);
        }
      });
    }
  });
}

/**
 * 解析 YouTube json3 自动字幕 → 逐句（含精确词级时间戳）。
 * 词级绝对时间 = event.tStartMs + seg.tOffsetMs
 */
/**
 * 解析 YouTube json3 自动字幕 → 逐句（含精确词级时间戳）。
 * 按 event 边界分句（YouTube 显示行 = 唱的一句）；清洗 segs 内嵌换行（\n 会拆坏 ASS Dialogue）。
 * 词级绝对时间 = event.tStartMs + seg.tOffsetMs
 */
function parseJson3(jsonText) {
  const data = JSON.parse(jsonText);
  const events = data.events || [];
  const lines = [];
  for (const ev of events) {
    const segs = (ev.segs || []).map(s => ({ ...s, utf8: String(s.utf8 || '').replace(/[\n\r]+/g, ' ') }))
      .map(s => ({ ...s, utf8: s.utf8.replace(/\s+/g, ' ') }))
      .filter(s => {
        const t = s.utf8.trim();
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
    // yt-dlp 的 ytsearchN 只能按总数顺序取：取 offset+limit 条后切片，实现真正的分页
    const n = offset + limit;
    const out = await runYtdlp([`ytsearch${n}:${keywords}`, '--dump-single-json', '--flat-playlist', '--no-warnings']);
    const j = JSON.parse(out);
    return (j.entries || []).slice(offset, offset + limit).map(e => ({
      id: e.id,
      name: e.title || '',
      artists: e.channel || '',
      album: '',
      duration: (e.duration || 0) * 1000, // yt-dlp 秒 → 统一毫秒（前端 fmtDuration）
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
    if (fs.existsSync(audioPath)) {
      // 缓存命中：进度直接拉满（前端显示 100% 而非误导性的 0%）
      if (typeof options.onProgress === 'function') options.onProgress(1);
    } else {
      const onLine = typeof options.onProgress === 'function' ? (line) => {
        const m = line.match(/\[download\]\s+([0-9.]+)%/);
        if (m) options.onProgress(parseFloat(m[1]) / 100);
      } : null;
      await runYtdlp(['-x', '--audio-format', 'mp3', '--newline', '-o', base + '.%(ext)s', '--no-warnings', input], onLine);
    }

    // 3. json3 自动字幕。auto=视频原语言优先（不带 --sub-lang，yt-dlp 拿原生自动字幕，
    //    避免英文歌被 YouTube 的 zh-Hans 自动翻译字幕抢先导致全中文）；明确选择按语言。
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
    const useNativeFirst = userLang === 'auto';
    // 缓存复用（仅明确选择语言时按优先级匹配；auto 不用缓存——原语言优先）
    const cachedByLang = fs.readdirSync(workDir)
      .filter(f => f.startsWith(videoId) && f.endsWith('.json3'))
      .map(f => ({ lang: f.slice(videoId.length + 1, -'.json3'.length), path: path.join(workDir, f) }));
    if (!useNativeFirst) {
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
    }
    // 原语言字幕（无 --sub-lang）优先于翻译字幕列表
    const attempts = useNativeFirst
      ? [{ lang: 'native', args: ['--skip-download', '--write-auto-sub', '--sub-format', 'json3', '-o', base, '--no-warnings', input] },
         ...subLangs.map(lang => ({ lang, args: ['--skip-download', '--write-auto-sub', '--sub-format', 'json3', '--sub-lang', lang, '-o', base, '--no-warnings', input] }))]
      : subLangs.map(lang => ({ lang, args: ['--skip-download', '--write-auto-sub', '--sub-format', 'json3', '--sub-lang', lang, '-o', base, '--no-warnings', input] }));
    for (const attempt of attempts) {
      if (lines.length > 0) break;
      try {
        const before = new Set(fs.readdirSync(workDir).filter(f => f.startsWith(videoId) && f.endsWith('.json3')));
        await runYtdlp(attempt.args);
        // 取本次新增的 json3（避免与缓存混淆），无新增则回退全部
        const after = fs.readdirSync(workDir).filter(f => f.startsWith(videoId) && f.endsWith('.json3'));
        const fresh = after.filter(f => !before.has(f));
        const pick = fresh.length ? fresh : after;
        if (pick.length > 0) {
          lines = parseJson3(fs.readFileSync(path.join(workDir, pick[0]), 'utf8'));
          if (lines.length > 0) break;
        }
      } catch (e) {
        console.log(`[提示] 字幕语言 ${attempt.lang} 下载失败:`, e.message.split('\n')[0]);
      }
    }

    if (!lines.length) throw new Error('未获取到 YouTube 字幕（该视频可能无自动字幕）');

    // 统一 lines 格式（加整句 text）
    // ⚠️ json3 event 时间大量重叠（滚动字幕），若不裁剪，重叠窗口内新旧两句 Dialogue 同屏（三行歌词/跳变）
    lines.sort((a, b) => a.startMs - b.startMs);
    for (let i = 0; i < lines.length; i++) {
      if (i + 1 < lines.length && lines[i].endMs > lines[i + 1].startMs) {
        lines[i].endMs = lines[i + 1].startMs;  // 下一句开始时上一句必须消失
      }
    }
    const unifiedLines = lines.map(l => ({ ...l, text: l.words.map(w => w.text).join('') }));
    const audioMs = await probeDuration(audioPath);

    return {
      meta: { id: videoId, title: meta.title, artist: meta.artists || '', source: 'youtube' },
      // meta.artists = 频道名（e.channel）
      lines: unifiedLines,
      audioPath,
      audioMs,
    };
  },
};
