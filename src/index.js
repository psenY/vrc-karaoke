'use strict';

const path = require('path');
const fs = require('fs');
const { generateAss } = require('./core/ass');
const { runFfmpeg, buildArgs } = require('./core/ffmpeg');
const { findPlatform } = require('./platforms');
const { uploadCatbox } = require('./core/catbox');

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

/** 生成 ASS + 合成 mp4（平台无关）。 */
async function synth(result, outBase, args) {
  let highlight = args.highlight;
  if (highlight === undefined) {
    highlight = result.meta.source === 'youtube' ? 'word' : 'line'; // YouTube 默认真逐字
  }

  const assPath = path.join(TMP_DIR, `${outBase}.ass`);
  fs.writeFileSync(assPath, generateAss(result.lines, {
    highlight,
    fontName: args.font || DEFAULTS.fontName,
    audioDurationMs: result.audioMs,
    bilingual: !!args.bilingual,
  }), 'utf8');
  console.log(`[字幕] 已生成 ASS (高亮=${highlight})`);

  const outName = args.out || `${outBase}_${highlight}.mp4`;
  const outPath = path.join(OUT_DIR, outName);
  const ffargs = buildArgs({
    audioPath: result.audioPath,
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
  const explicitId = !!args.id;

  if (!input && !explicitId) {
    console.error('用法:');
    console.error('  网易云: node src/index.js --keywords "歌手 歌名"   或   --id 歌曲ID');
    console.error('  YouTube: node src/index.js --url "https://www.youtube.com/watch?v=..." (默认真逐字)');
    console.error('  可选: --highlight line|word --background 0x1a1a2e --cookie "..." --out 名.mp4');
    process.exit(1);
  }

  for (const d of [OUT_DIR, TMP_DIR, FONT_DIR]) fs.mkdirSync(d, { recursive: true });

  // 自动识别平台
  const platform = findPlatform(input, { explicitId });
  console.log(`[平台] ${platform.name}`);

  const result = await platform.fetch(input, {
    workDir: TMP_DIR,
    cookie: args.cookie || '',
    songId: explicitId ? args.id : undefined,
  });

  const title = result.meta.title || result.meta.id;
  console.log(`[命中] ${title} (${result.lines.length} 句)`);
  if (result.audioMs) console.log(`[时长] ${(result.audioMs / 1000).toFixed(1)}s`);

  const outPath = await synth(result, result.meta.id, args);

  if (args.upload) {
    console.log('[上传] catbox.moe ...');
    const url = await uploadCatbox(outPath);
    console.log(`[直链] ${url}`);
  }
}

main().catch(err => {
  console.error('[失败]', err.message);
  process.exit(1);
});
