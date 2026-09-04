'use strict';

const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

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
 * json3 结构：events[].{tStartMs, dDurationMs, segs[].{utf8, tOffsetMs}}
 * 每个词绝对时间 = event.tStartMs + seg.tOffsetMs
 * @returns {Array<{startMs:number, endMs:number, words:Array<{text:string,startMs:number}>}>}
 */
function parseJson3(jsonText) {
  const data = JSON.parse(jsonText);
  const events = data.events || [];
  const lines = [];
  for (const ev of events) {
    const segs = (ev.segs || []).filter(s => {
      const t = (s.utf8 || '').trim();
      return t !== '' && !/^\[.*\]$/.test(t); // 过滤空行与 [Music]/[Applause] 等非歌词标签
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

/**
 * 下载 YouTube 音频 + 自动字幕（json3 词级）。
 * @returns {Promise<{videoId:string, title:string, durationMs:number, audioPath:string, lines:Array, json3File:string|null}>}
 */
async function fetchYoutube(url, workDir) {
  // 1. 视频元信息
  const infoJson = await runYtdlp(['--dump-single-json', '--no-warnings', '--skip-download', url]);
  const meta = JSON.parse(infoJson);
  const videoId = meta.id;
  const durationMs = Math.round((meta.duration || 0) * 1000);
  const base = path.join(workDir, videoId);

  // 2. 下载音频（转 mp3）
  await runYtdlp(['-x', '--audio-format', 'mp3', '-o', base + '.%(ext)s', '--no-warnings', url]);
  const audioPath = base + '.mp3';

  // 3. 下载 json3 自动字幕（词级时间戳），按语言优先级逐个尝试
  let lines = [];
  let json3File = null;
  const subLangs = ['zh-Hans,zh-CN,zh', 'en', 'ja', 'ko'];
  for (const lang of subLangs) {
    try {
      await runYtdlp([
        '--skip-download', '--write-auto-sub', '--sub-format', 'json3',
        '--sub-lang', lang,
        '-o', base, '--no-warnings', url,
      ]);
      const json3Files = fs.readdirSync(workDir)
        .filter(f => f.startsWith(videoId) && f.endsWith('.json3'))
        .map(f => path.join(workDir, f))
        .sort();
      if (json3Files.length > 0) {
        json3File = json3Files[0];
        lines = parseJson3(fs.readFileSync(json3File, 'utf8'));
        if (lines.length > 0) break;
      }
    } catch (e) {
      console.log(`[提示] 字幕语言 ${lang} 下载失败:`, e.message.split('\n')[0]);
    }
  }

  return { videoId, title: meta.title, durationMs, audioPath, lines, json3File };
}

module.exports = { fetchYoutube, parseJson3 };
