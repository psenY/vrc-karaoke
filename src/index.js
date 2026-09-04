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
    console.error('  可选: --highlight line|word --bilingual --background 0x1a1a2e --cookie "..." --upload --out 名.mp4');
    process.exit(1);
  }

  const result = await generateVideo(input, {
    highlight: args.highlight,
    bilingual: !!args.bilingual,
    background: args.background || '0x1a1a2e',
    cookie: args.cookie || '',
    songId: hasId ? args.id : undefined,
    upload: !!args.upload,
  });

  console.log(`[完成] ${result.outPath}`);
  if (result.url) console.log(`[直链] ${result.url}`);
}

main().catch(err => {
  console.error('[失败]', err.message);
  process.exit(1);
});
