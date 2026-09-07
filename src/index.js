'use strict';

const { generateVideo } = require('./generate');

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

async function main() {
  const args = parseArgs(process.argv);
  const input = (args.url || args.keywords || args._.join(' ')).trim();
  const hasId = !!args.id;

  if (!input && !hasId) {
    console.error('用法:');
    console.error('  网易云: node src/index.js --keywords "歌手 歌名"   或   --id 歌曲ID');
    console.error('  YouTube: node src/index.js --url "https://www.youtube.com/watch?v=..."');
    console.error('  QQ音乐: node src/index.js --url "https://y.qq.com/n/ryqq/songDetail/<mid>"');
    console.error('  可选: --highlight line|word --bilingual --cover --background 0x1a1a2e --cookie "..." --out 名.mp4');
    console.error('  质量: --resolution 1080p --codec libx264 --preset veryfast --crf 23 --fps 24 --seg-count 8');
    console.error('  音频: --audio-level higher|lossless|hires|jymaster --flac --subtitle-lang auto|zh|en|ja|ko --no-intro');
    process.exit(1);
  }

  const result = await generateVideo(input, {
    highlight: args.highlight,
    bilingual: !!args.bilingual,
    background: args.background || '0x1a1a2e',
    cookie: args.cookie || '',
    songId: hasId ? args.id : undefined,
    cover: !!args.cover,
    out: args.out,
    resolution: args.resolution || '1080p',
    codec: args.codec || 'libx264',
    preset: args.preset || 'veryfast',
    crf: Number(args.crf) || 23,
    fps: Number(args.fps) || 24,
    segCount: Number(args.segCount) || 8,
    audioLevel: args['audio-level'] || 'higher',
    flacAudio: !!args.flac,
    subtitleLang: args['subtitle-lang'] || 'auto',
    introText: args['no-intro'] ? '' : 'AUTO',
  });

  console.log(`[完成] ${result.outPath} | ${result.quality ? result.quality.levelLabel + ' ' + result.quality.brLabel : ''} | ${(result.size / 1048576).toFixed(1)}MB`);
}

main().catch(err => {
  console.error('[失败]', err.message);
  process.exit(1);
});
