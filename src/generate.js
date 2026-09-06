'use strict';

const path = require('path');
const fs = require('fs');
const { findPlatform } = require('./platforms');
const { generateAss, escapeAssText } = require('./core/ass');
const { runFfmpeg, buildArgs, runFfmpegSegmented, concatVideos, probeBitrate, probeCodec, resolveAudioBitrate } = require('./core/ffmpeg');
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
    coverMask = true,          // 封面遮罩（全屏半透明黑叠加在封面图上）
    coverMaskLevel = 30,       // 遮罩强度 0-90(%)
    out = null,                 // 输出文件名
    onProgress = null,          // 进度回调 (0~1 数字, 或 {segIdx,progress} 对象)
    segCount = 8,               // 分段并行数(线程数)
    resolution = '1080p',       // 分辨率
    codec = 'libx264',          // 编码器
    preset = 'veryfast',        // 编码预设(速度↔压缩)
    crf = 23,                   // 质量(越小越高)
    fps = 24,                   // 帧率
    audioBitrate = 'auto',      // 音频码率（auto=跟随音源质量对齐）
    currentColor = '#FFFFFF',   // 当前句颜色
    nextColor = '#969696',      // 下一句/翻译颜色
    titleColor = '#FFFFFF',     // 标题颜色
    progressColor = '#FFFFFF',  // 进度颜色
    introText = 'AUTO',       // 片头信息卡（'AUTO'=自动生成项目/开发者/歌曲/音质/参数；''=不加）
    audioLevel = 'higher',    // 音质档位(默认较高192k)
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
  // 封面遮罩：可选全屏半透明黑叠加在封面图上（默认 30%）
  let coverPath = null;
  if (cover && result.meta.coverUrl) {
    try {
      coverPath = path.join(workDir, `${result.meta.id}_cover.jpg`);
      await download(result.meta.coverUrl, coverPath);
      const blurredPath = path.join(workDir, `${result.meta.id}_bg.jpg`);
      const maskFilter = coverMask && coverMaskLevel > 0
        ? `,drawbox=w=iw:h=ih:t=fill:color=black@${(Math.min(90, coverMaskLevel) / 100).toFixed(2)}`
        : '';
      await runFfmpeg(['-y', '-loop', '1', '-i', coverPath, '-vf', `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},boxblur=8:2${maskFilter}`, '-frames:v', '1', blurredPath], null, onSpawn);
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

  // 3.1 无损封装仅对 FLAC 音源有效（mp3/aac 源转 FLAC 是"无损容器装有损内容"，码率虚高、解码压力大、片头码率误导）
  let finalFlac = flacAudio;
  if (flacAudio) {
    const srcCodec = await probeCodec(result.audioPath);
    if (srcCodec !== 'flac') {
      finalFlac = false;
      console.log(`[提示] 音源非 FLAC(实际 ${srcCodec || '未知'})，无损封装不适用，已改用 AAC`);
    }
  }

  // 3.2 片头信息卡（introText === 'AUTO' 时自动生成：生成方/开发者/歌曲/音质码率/参数）
  // levelLabel/brLabel 供 5.5 前置片头片段复用
  let finalIntro = introText;
  let levelLabel = '';
  let brLabel = '';
  if (introText === 'AUTO') {
    const esc = escapeAssText;
    const labels = { standard: '标准', higher: '较高', exhigh: '极高', lossless: '无损', hires: '高解析度无损', jyeffect: '高清甄音', dolby: '甄音全景声', sky: '沉浸环绕声', jymaster: '超清母带' };
    levelLabel = labels[audioLevel] || audioLevel;
    // 音频码率：无损封装(FLAC音源)显示 FLAC 音源码率；否则显示 AAC 目标码率
    brLabel = finalFlac ? `FLAC ${Math.round(srcBitrate / 1000)}k` : `AAC ${finalAudioBitrate}`;
    finalIntro = 'on';  // 标记：需要前置片头片段
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
    introText: '',   // 片头改为前置独立片段，主体 ASS 不含片头
  });
  fs.writeFileSync(assPath, assText, 'utf8');

  // 5. 合成（纯色背景分段并行编码吃多核；封面背景单段）
  const outPath = path.join(outDir, out || `${result.meta.id}_${h}.mp4`);
  const bodyOut = finalIntro ? outPath + '.body.mp4' : outPath;  // 有片头时主体先输出到临时路径
  if (segCount > 1 && result.audioMs > 60000) {
    await runFfmpegSegmented({
      audioPath: result.audioPath,
      assText,
      fontDir,
      outPath: bodyOut,
      background,
      coverPath,
      audioMs: result.audioMs,
      width, height, fps, crf, preset, audioBitrate: finalAudioBitrate, codec, flacAudio: finalFlac,
      onSpawn,
    }, segCount, (p) => {
      if (typeof onProgress === 'function') onProgress({ phase: 'assemble', segIdx: p.segIdx, progress: p.progress });
    });
  } else {
    const ffargs = buildArgs({
      audioPath: result.audioPath,
      assPath,
      fontDir,
      outPath: bodyOut,
      background,
      coverPath,
      width, height, fps, crf, preset, audioBitrate: finalAudioBitrate, codec, flacAudio: finalFlac,
    });
    await runFfmpeg(ffargs, (sec) => {
      if (typeof onProgress === 'function' && result.audioMs > 0) {
        onProgress({ phase: 'assemble', progress: Math.min(1, sec / (result.audioMs / 1000)) });
      }
    }, onSpawn);
  }

  // 5.5 前置片头：3 秒纯黑 + 信息卡文字 + 静音音频（前 3 秒不播放歌曲音频）
  if (finalIntro) {
    const esc = escapeAssText;
    const introAssPath = path.join(workDir, '_intro.ass');
    const introLines = [
      { style: 'IntroMain', y: 400, text: esc('本视频由 psenY/vrc-karaoke 生成') },
      // 标签用全角空格(U+3000)补齐等宽，冒号与值对齐；整块左对齐起点=标题第一行左边
      { style: 'IntroInfo', y: 552, text: esc('开发者：VRChat@psenY7') },
      { style: 'IntroInfo', y: 614, text: esc('歌\u3000曲：' + (result.meta.title || '')) },
      { style: 'IntroInfo', y: 676, text: esc('音\u3000质：' + levelLabel + ' - ' + brLabel) },
      { style: 'IntroInfo', y: 738, text: esc('参\u3000数：' + resolution + ' - ' + fps + 'fps - ' + preset + ' - CRF' + crf) },
    ];
    fs.writeFileSync(introAssPath, buildIntroAss(introLines, width, height));
    const introPath = path.join(workDir, '_intro.mp4');
    await runFfmpeg([
      '-y',
      '-f', 'lavfi', '-i', `color=c=black:s=${width}x${height}:r=${fps}:d=3`,
      '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
      '-t', '3',
      '-vf', `ass=${introAssPath}:fontsdir=${fontDir}`,
      '-c:v', codec, '-preset', preset, '-crf', String(crf), '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k',
      '-shortest',
      introPath,
    ], null, onSpawn);
    // 拼接片头 + 主体：视频用 concat demuxer（-c:v copy，快）；
    // 音频用 adelay（原始歌曲音频延迟 3 秒，前 3 秒静音，然后歌曲开始）
    // 不依赖采样率匹配（filter concat 在 anullsrc 与音源采样率不一致时会输出静音）
    const introList = path.join(workDir, '_intro.list.txt');
    fs.writeFileSync(introList, [`file '${introPath}'`, `file '${bodyOut}'`].join('\n'));
    const muxAudio = [
      '-i', result.audioPath,  // 原始歌曲音频（1:a）
      '-filter_complex', '[1:a]adelay=3000:all=1[a]',
      '-map', '0:v', '-map', '[a]',
      '-c:v', 'copy',
      '-c:a', finalFlac ? 'flac' : 'aac',
      ...(finalFlac ? ['-strict', '-2'] : ['-b:a', finalAudioBitrate]),
      '-shortest', '-movflags', '+faststart',
    ];
    await runFfmpeg([
      '-y',
      '-f', 'concat', '-safe', '0', '-i', introList,
      ...muxAudio,
      outPath,
    ], null, onSpawn);
    for (const p of [bodyOut, introPath, introAssPath, introList]) { try { fs.unlinkSync(p); } catch (e) {} }
  }

  // 6. 清理非音频缓存的中间文件（.ass/.jpg/.png/.txt），保留音频缓存(mp3/flac/m4a)供下次复用
  try {
    for (const f of fs.readdirSync(workDir)) {
      if (/\.(ass|jpg|png|txt)$/i.test(f)) {
        try { fs.unlinkSync(path.join(workDir, f)); } catch (e) {}
      }
    }
  } catch (e) {}

  return { outPath, meta: result.meta, highlight: h };
}

// 片头信息卡 ASS：纯黑背景上的白字/灰字信息，\pos 精确排版
function buildIntroAss(lines, playResX, playResY) {
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${playResX}
PlayResY: ${playResY}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: IntroMain,Noto Sans CJK SC,92,&H00FFFFFF,&H00FFFFFF,&H00000000,&H96000000,-1,0,0,0,100,100,0,0,1,4,2,5,100,100,0,1
Style: IntroInfo,Noto Sans CJK SC,44,&H00D0D0D0,&H00D0D0D0,&H00000000,&H96000000,-1,0,0,0,100,100,0,0,1,3,1,5,100,100,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  // 左对齐：\an4(左中) + 统一 X（标题第一行左边第一个字位置），四行从同一起点左对齐
  const leftX = Math.round(playResX * 0.14);
  const events = lines.map(l => `Dialogue: 0,0:00:00.00,0:00:03.00,${l.style},,0,0,0,,{\\pos(${leftX},${l.y})\\an4}${l.text}`);
  return header + events.join('\n') + '\n';
}

module.exports = { generateVideo };
