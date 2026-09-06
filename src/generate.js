'use strict';

const path = require('path');
const fs = require('fs');
const { findPlatform } = require('./platforms');
const { generateAss, escapeAssText } = require('./core/ass');
const { runFfmpeg, buildArgs, runFfmpegSegmented, probeBitrate, resolveAudioBitrate } = require('./core/ffmpeg');
const { download } = require('./core/netease-api');

const ROOT = path.join(__dirname, '..');

// #RRGGBB → ASS &H00BBGGRR
function hexToAssBgr(hex) {
  const h = String(hex || '').replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return `&H00${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`;
}

/**
 * 核心生成流程（CLI 与 WebUI 共用）：
 * 识别平台 → 抓歌词/音频 → (可选)封面 → 生成 ASS → ffmpeg 合成。
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
    resolution = '1080p',       // 分辨率
    codec = 'libx264',          // 编码器
    preset = 'veryfast',        // 编码预设(速度↔压缩)
    crf = 20,                   // 质量(越小越高)
    fps = 24,                   // 帧率
    audioBitrate = 'auto',      // 音频码率（auto=跟随音源质量对齐）
    currentColor = '#FFFFFF',   // 当前句颜色
    nextColor = '#969696',      // 下一句/翻译颜色
    titleColor = '#FFFFFF',     // 标题颜色
    progressColor = '#FFFFFF',  // 进度颜色
    introText = 'AUTO',       // 片头信息卡（'AUTO'=自动生成项目/开发者/歌曲/音质/参数；''=不加）
    audioLevel = 'standard',  // 音质 standard/exhigh/lossless
    flacAudio = false,        // 无损封装：音频保持 FLAC（部分播放器不支持）
    onSpawn = null,            // ffmpeg 进程暴露回调(用于取消)
  } = options;

  const RESOLUTIONS = { '1080p': [1920, 1080], '720p': [1280, 720], '480p': [854, 480] };
  const [width, height] = RESOLUTIONS[resolution] || RESOLUTIONS['1080p'];

  for (const d of [outDir, workDir, fontDir]) fs.mkdirSync(d, { recursive: true });

  // 1. 识别平台 + 抓取
  const platform = findPlatform(input, { explicitId: !!songId });
  const result = await platform.fetch(input, {
    workDir, cookie, songId, audioLevel,
    onProgress: (p) => { if (typeof onProgress === 'function') onProgress({ phase: 'download', progress: p }); },
  });

  // 2. 高亮默认值
  let h = highlight;
  if (h === undefined) h = result.meta.source === 'youtube' ? 'word' : 'line';

  // 2.5 下载封面（可选，失败退回纯色）+ 预生成模糊背景图（blur 只做一次，分段/单段共用）
  let coverPath = null;
  if (cover && result.meta.coverUrl) {
    try {
      coverPath = path.join(workDir, `${result.meta.id}_cover.jpg`);
      await download(result.meta.coverUrl, coverPath);
      const blurredPath = path.join(workDir, `${result.meta.id}_bg.jpg`);
      await runFfmpeg(['-y', '-loop', '1', '-i', coverPath, '-vf', `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},boxblur=8:2`, '-frames:v', '1', blurredPath], null, onSpawn);
      coverPath = blurredPath;  // 后续用已模糊的背景图
    } catch (e) {
      console.log('[提示] 封面处理失败，退回纯色背景:', e.message.split('\n')[0]);
      coverPath = null;
    }
  }

  // 3. 音频码率：auto 时按音源实际码率对齐（无损/高音质不再被压到 128k）；无损封装也需探测音源码率用于信息卡
  const needProbe = audioBitrate === 'auto' || flacAudio;
  const srcBitrate = needProbe ? await probeBitrate(result.audioPath) : 0;
  const finalAudioBitrate = resolveAudioBitrate(audioBitrate, srcBitrate);

  // 3.2 片头信息卡（introText === 'AUTO' 时自动生成：生成方/开发者/歌曲/音质码率/参数）
  let finalIntro = introText;
  if (introText === 'AUTO') {
    const esc = escapeAssText;
    const labels = { standard: '标准', higher: '较高', exhigh: '极高', lossless: '无损', hires: '高解析度无损', jyeffect: '高清甄音', dolby: '甄音全景声', sky: '沉浸环绕声', jymaster: '超清母带' };
    const levelLabel = labels[audioLevel] || audioLevel;
    // 音频码率：无损封装显示 FLAC 音源码率；否则显示 AAC 目标码率
    const brLabel = flacAudio ? `FLAC ${Math.round(srcBitrate / 1000)}k` : `AAC ${finalAudioBitrate}`;
    finalIntro = `{\\fs92}${esc('本视频由 psenY/vrc-karaoke 生成')}{\\fs44}\\N${esc('开发者：VRChat@psenY7')}\\N${esc('歌曲：' + (result.meta.title || ''))}\\N${esc('音质：' + levelLabel + ' · ' + brLabel)}\\N${esc('参数：' + resolution + ' · ' + fps + 'fps · ' + preset + ' · CRF' + crf)}`;
  }

  // 4. 生成 ASS
  const assPath = path.join(workDir, `${result.meta.id}.ass`);
  const assText = generateAss(result.lines, {
    highlight: h,
    bilingual,
    audioDurationMs: result.audioMs,
    title: result.meta.title || '',
    showProgress: true,
    currentColor: hexToAssBgr(currentColor) || '&H00FFFFFF',
    nextColor: hexToAssBgr(nextColor) || '&H00969696',
    titleColor: hexToAssBgr(titleColor) || '&H00FFFFFF',
    progressColor: hexToAssBgr(progressColor) || '&H00FFFFFF',
    introText: finalIntro,
  });
  fs.writeFileSync(assPath, assText, 'utf8');

  // 5. 合成（纯色背景分段并行编码吃多核；封面背景单段）
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
      width, height, fps, crf, preset, audioBitrate: finalAudioBitrate, codec, flacAudio,
      onSpawn,
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
      width, height, fps, crf, preset, audioBitrate: finalAudioBitrate, codec, flacAudio,
    });
    await runFfmpeg(ffargs, (sec) => {
      if (typeof onProgress === 'function' && result.audioMs > 0) {
        onProgress({ phase: 'assemble', progress: Math.min(1, sec / (result.audioMs / 1000)) });
      }
    }, onSpawn);
  }

  return { outPath, meta: result.meta, highlight: h };
}

module.exports = { generateVideo };
