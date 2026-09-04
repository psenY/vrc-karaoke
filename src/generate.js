'use strict';

const path = require('path');
const fs = require('fs');
const { findPlatform } = require('./platforms');
const { generateAss } = require('./core/ass');
const { runFfmpeg, buildArgs } = require('./core/ffmpeg');
const { uploadCatbox } = require('./core/catbox');
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
    upload = false,
    cover = false,              // 封面背景
    out = null,                 // 输出文件名
    onProgress = null,          // 合成进度回调 (0~1)
  } = options;

  for (const d of [outDir, workDir, fontDir]) fs.mkdirSync(d, { recursive: true });

  // 1. 识别平台 + 抓取
  const platform = findPlatform(input, { explicitId: !!songId });
  const result = await platform.fetch(input, { workDir, cookie, songId });

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
  fs.writeFileSync(assPath, generateAss(result.lines, {
    highlight: h,
    bilingual,
    audioDurationMs: result.audioMs,
  }), 'utf8');

  // 4. 合成
  const outPath = path.join(outDir, out || `${result.meta.id}_${h}.mp4`);
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
      onProgress(Math.min(1, sec / (result.audioMs / 1000)));
    }
  });

  // 5. 可选上传 catbox
  let url = null;
  if (upload) url = await uploadCatbox(outPath);

  return { outPath, url, meta: result.meta, highlight: h };
}

module.exports = { generateVideo };
