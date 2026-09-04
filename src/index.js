'use strict';

const path = require('path');
const fs = require('fs');
const { parseLrc } = require('./lyrics');
const { generateAss } = require('./ass');
const { probeDuration, runFfmpeg, buildArgs } = require('./ffmpeg');
const { searchSong, getLyric, getSongUrl, getSongDetail, download } = require('./netease');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'output');
const TMP_DIR = path.join(ROOT, 'tmp');
const FONT_DIR = path.join(ROOT, 'fonts');

const DEFAULTS = {
  width: 1920,
  height: 1080,
  fps: 30,
  background: '0x1a1a2e',
  crf: 20,
  preset: 'medium',
  audioBitrate: '192k',
  highlight: 'line',
  fontName: 'Noto Sans CJK SC',
};

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1];
      if (val === undefined || val.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = val;
        i++;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

/** 下载音频并验证时长是否完整（不完整重试）。 */
async function downloadWithVerify(songId, cookie, basePath, expectedMs, maxRetries = 2) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const { url } = await getSongUrl(songId, cookie);
    if (!url) throw new Error('未获取到音频地址（可能是会员/无版权歌曲，需要提供 --cookie）');
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

async function main() {
  const args = parseArgs(process.argv);
  const keywords = args.keywords || args._.join(' ');
  if (!keywords && !args.id) {
    console.error('用法: node src/index.js --keywords "歌手 歌名" [--id 歌曲ID] [--highlight line|word] [--background 0x1a1a2e] [--cookie "..."]');
    process.exit(1);
  }

  for (const d of [OUT_DIR, TMP_DIR, FONT_DIR]) fs.mkdirSync(d, { recursive: true });

  // 1. 找歌
  let songId = args.id ? Number(args.id) : null;
  if (!songId) {
    const songs = await searchSong(keywords, 1);
    if (!songs.length) throw new Error('未找到歌曲: ' + keywords);
    songId = songs[0].id;
    console.log(`[命中] ${songs[0].name} - ${songs[0].artists} (id=${songId})`);
  }

  // 2. 歌词
  const { lrc } = await getLyric(songId);
  if (!lrc) throw new Error('未获取到歌词');
  const { lines } = parseLrc(lrc);
  if (!lines.length) throw new Error('歌词解析为空');
  console.log(`[歌词] 共 ${lines.length} 句`);

  // 3. 音频（下载 + 时长验证，不完整自动重试）
  const detail = await getSongDetail(songId);
  const cookie = args.cookie || '';
  const audio = await downloadWithVerify(songId, cookie, path.join(TMP_DIR, String(songId)), detail.dt || 0);
  const { durationMs: audioMs, path: tmpAudio } = audio;
  console.log(`[时长] ${(audioMs / 1000).toFixed(1)}s`);

  // 4. ASS 字幕
  const highlight = args.highlight || DEFAULTS.highlight;
  const assPath = path.join(TMP_DIR, `${songId}.ass`);
  fs.writeFileSync(assPath, generateAss(lines, {
    highlight,
    fontName: args.font || DEFAULTS.fontName,
    audioDurationMs: audioMs,
  }), 'utf8');
  console.log(`[字幕] 已生成 ASS (高亮=${highlight})`);

  // 5. 合成
  const outName = args.out || `${songId}_${highlight}.mp4`;
  const outPath = path.join(OUT_DIR, outName);
  const ffargs = buildArgs({
    audioPath: tmpAudio,
    assPath,
    fontDir: FONT_DIR,
    outPath,
    width: DEFAULTS.width,
    height: DEFAULTS.height,
    fps: DEFAULTS.fps,
    background: args.background || DEFAULTS.background,
    crf: DEFAULTS.crf,
    preset: DEFAULTS.preset,
    audioBitrate: DEFAULTS.audioBitrate,
  });
  console.log('[合成] ffmpeg 编码中...');
  await runFfmpeg(ffargs);

  console.log(`[完成] ${outPath}`);
  return outPath;
}

main().catch(err => {
  console.error('[失败]', err.message);
  process.exit(1);
});
