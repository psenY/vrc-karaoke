'use strict';

const path = require('path');
const fs = require('fs');
const { parseLrc } = require('./lyrics');
const { generateAss } = require('./ass');
const { probeDuration, runFfmpeg, buildArgs } = require('./ffmpeg');
const { searchSong, getLyric, getSongUrl, getSongDetail, download } = require('./netease');
const { fetchYoutube } = require('./youtube');

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

function isYoutubeUrl(s) {
  return /(youtube\.com|youtu\.be)/i.test(s || '');
}

/** 下载音频并验证时长是否完整（网易云用）。 */
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

/** 生成 ASS + 合成 mp4（网易云/YouTube 共用）。 */
async function synth(lines, audioMs, audioPath, outBase, args) {
  const highlight = args.highlight || DEFAULTS.highlight;
  const assPath = path.join(TMP_DIR, `${outBase}.ass`);
  fs.writeFileSync(assPath, generateAss(lines, {
    highlight,
    fontName: args.font || DEFAULTS.fontName,
    audioDurationMs: audioMs,
  }), 'utf8');
  console.log(`[字幕] 已生成 ASS (高亮=${highlight})`);

  const outName = args.out || `${outBase}_${highlight}.mp4`;
  const outPath = path.join(OUT_DIR, outName);
  const ffargs = buildArgs({
    audioPath,
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

async function main() {
  const args = parseArgs(process.argv);
  const input = (args.url || args.keywords || args._.join(' ')).trim();
  const hasId = !!args.id;

  if (!input && !hasId) {
    console.error('用法:');
    console.error('  网易云: node src/index.js --keywords "歌手 歌名"   或   --id 歌曲ID');
    console.error('  YouTube: node src/index.js --url "https://www.youtube.com/watch?v=..." [--highlight word]');
    console.error('  可选: --highlight line|word --background 0x1a1a2e --cookie "..." --out 名.mp4');
    process.exit(1);
  }

  for (const d of [OUT_DIR, TMP_DIR, FONT_DIR]) fs.mkdirSync(d, { recursive: true });

  let lines, audioMs, audioPath, outBase;

  if (!hasId && isYoutubeUrl(input)) {
    // ===== YouTube 来源（含精确词级时间戳） =====
    const r = await fetchYoutube(input, TMP_DIR);
    if (!r.lines.length) throw new Error('未获取到 YouTube 字幕（该视频可能无自动字幕）');
    console.log(`[命中] ${r.title} (${r.lines.length} 句字幕, 含词级时间戳)`);
    lines = r.lines;
    audioPath = r.audioPath;
    audioMs = await probeDuration(r.audioPath); // 实际音频时长
    outBase = r.videoId;
    if (args.highlight === undefined) args.highlight = 'word'; // YouTube 默认真逐字
    console.log(`[时长] ${(audioMs / 1000).toFixed(1)}s`);
  } else {
    // ===== 网易云来源 =====
    let songId = hasId ? Number(args.id) : null;
    if (!songId) {
      const songs = await searchSong(input, 1);
      if (!songs.length) throw new Error('未找到歌曲: ' + input);
      songId = songs[0].id;
      console.log(`[命中] ${songs[0].name} - ${songs[0].artists} (id=${songId})`);
    }
    const { lrc } = await getLyric(songId);
    if (!lrc) throw new Error('未获取到歌词');
    lines = parseLrc(lrc).lines;
    if (!lines.length) throw new Error('歌词解析为空');
    console.log(`[歌词] 共 ${lines.length} 句`);

    const detail = await getSongDetail(songId);
    const cookie = args.cookie || '';
    const audio = await downloadWithVerify(songId, cookie, path.join(TMP_DIR, String(songId)), detail.dt || 0);
    audioMs = audio.durationMs;
    audioPath = audio.path;
    outBase = String(songId);
    console.log(`[时长] ${(audioMs / 1000).toFixed(1)}s`);
  }

  await synth(lines, audioMs, audioPath, outBase, args);
}

main().catch(err => {
  console.error('[失败]', err.message);
  process.exit(1);
});
