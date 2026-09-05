'use strict';

const path = require('path');
const fs = require('fs');
const { findPlatform } = require('./platforms');
const { generateAss } = require('./core/ass');
const { runFfmpeg, buildArgs, runFfmpegSegmented } = require('./core/ffmpeg');
const { download } = require('./core/netease-api');

const ROOT = path.join(__dirname, '..');

/**
 * 核心生成流程（CLI 与 WebUI 共用）：
 * 识别平台 → 抓歌词/音频 → (可选)封面 → 生成 ASS → ffmpeg 合成 → (可选)catbox 直链。
 * @param {string} input 关键词或平台链接
 * @returns {Promise<{outPath:string, url:string|null, meta:object, highlight:string}>}
 */
async function generateVideo(input, options = {}) {
  const {
    workDir = path.join(ROOT, 'tmp'),
    outDir = path.join(ROOT, 'output'),
    fontDir = path.join(ROOT, 'fonts'),
    highlight,                  // 未指定时 YouTube 默认 word，其余 line
    bilingual = false,
    background = '0x1a1a2e',
    cookie = '',
    songId,                     // 网易云 --id
    cover = false,              // 封面背景
    out = null,                 // 输出文件名
    onProgress = null,          // 进度回调 (0~1 数字, 或 {segIdx,progress} 对象)
    segCount = 8,               // 分段并行数(线程数)
  } = options;

  for (const d of [outDir, workDir, fontDir]) fs.mkdirSync(d, { recursive: true });

  // 1. 识别平台 + 抓取
  const platform = findPlatform(input, { explicitId: !!songId });
  const result = await platform.fetch(input, {
    workDir, cookie, songId,
    onProgress: (p) => { if (typeof onProgress === 'function') onProgress({ phase: 'download', progress: p }); },
  });

  // 2. 高亮默认值
  let h = highlight;
  if (h === undefined) h = result.meta.source === 'youtube' ? 'word' : 'line';

  // 2.5 下载封面（可选，失败退回纯色）
  let coverPath = null;
  if (cover && result.meta.coverUrl) {
    try {
      coverPath = path.join(workDir, `${result.meta.id}_cover.jpg`);
      await download(result.meta.coverUrl, coverPath);
    } catch (e) {
      console.log('[提示] 封面下载失败，退回纯色背景:', e.message.split('\n')[0]);
      coverPath = null;
    }
  }

  // 3. 生成 ASS
  const assPath = path.join(workDir, `${result.meta.id}.ass`);
  const assText = generateAss(result.lines, {
    highlight: h,
    bilingual,
    audioDurationMs: result.audioMs,
    title: result.meta.title || '',
    showProgress: true,
  });
  fs.writeFileSync(assPath, assText, 'utf8');

  // 4. 合成（纯色背景分段并行编码吃多核；封面背景单段）
  const outPath = path.join(outDir, out || `${result.meta.id}_${h}.mp4`);
  if (segCount > 1 && result.audioMs > 60000) {
    await runFfmpegSegmented({
      audioPath: result.audioPath,
      assText,
      fontDir,
      outPath,
      background,
      coverPath,
      audioMs: result.audioMs,
    }, segCount, (p) => {
      if (typeof onProgress === 'function') onProgress({ phase: 'assemble', segIdx: p.segIdx, progress: p.progress });
    });
  } else {
    const ffargs = buildArgs({
      audioPath: result.audioPath,
      assPath,
      fontDir,
      outPath,
      background,
      coverPath,
    });
    await runFfmpeg(ffargs, (sec) => {
      if (typeof onProgress === 'function' && result.audioMs > 0) {
        onProgress({ phase: 'assemble', progress: Math.min(1, sec / (result.audioMs / 1000)) });
      }
    });
  }

  return { outPath, meta: result.meta, highlight: h };
}

module.exports = { generateVideo };
