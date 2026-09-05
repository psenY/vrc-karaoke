'use strict';

const { spawn } = require('child_process');

/** 用 ffprobe 读取音频时长（毫秒） */
function probeDuration(filePath) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ]);
    let out = '';
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', () => {});
    proc.on('error', reject);
    proc.on('close', code => {
      if (code !== 0) return reject(new Error('ffprobe failed'));
      resolve(parseFloat(out.trim()) * 1000);
    });
  });
}

/**
 * 构建 ffmpeg 合成参数。
 * coverPath 存在时用封面图（模糊铺满）作背景，否则纯色背景。
 */
function buildArgs(opts) {
  const {
    audioPath,
    assPath,
    fontDir,
    outPath,
    width = 1920,
    height = 1080,
    fps = 24,
    background = '0x1a1a2e',
    crf = 20,
    preset = 'veryfast',
    audioBitrate = '192k',
    coverPath = null,
  } = opts;

  const assFilter = `ass=${assPath}` + (fontDir ? `:fontsdir=${fontDir}` : '');

  // 封面背景：缩放铺满 + 模糊，歌词叠加
  if (coverPath) {
    const filterComplex = `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},boxblur=8:2[bg];[bg]${assFilter}[v]`;
    return [
      '-y',
      '-loop', '1', '-i', coverPath,
      '-i', audioPath,
      '-filter_complex', filterComplex,
      '-map', '[v]', '-map', '1:a',
      '-c:v', 'libx264', '-preset', preset, '-crf', String(crf), '-pix_fmt', 'yuv420p', '-threads', '0',
      '-c:a', 'aac', '-b:a', audioBitrate,
      '-shortest', '-movflags', '+faststart',
      outPath,
    ];
  }

  // 纯色背景
  return [
    '-y',
    '-f', 'lavfi', '-i', `color=c=${background}:s=${width}x${height}:r=${fps}`,
    '-i', audioPath,
    '-vf', assFilter,
    '-c:v', 'libx264', '-preset', preset, '-crf', String(crf), '-pix_fmt', 'yuv420p', '-threads', '0',
    '-c:a', 'aac', '-b:a', audioBitrate,
    '-shortest',
    '-movflags', '+faststart',
    outPath,
  ];
}

function runFfmpeg(args, onProgress) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args);
    let stderr = '';
    proc.stderr.on('data', d => {
      stderr += d;
      if (typeof onProgress === 'function') {
        // 解析 time=HH:MM:SS.xx 进度 → 已处理秒数
        const m = String(d).match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
        if (m) {
          const sec = parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseFloat(m[3]);
          onProgress(sec);
        }
      }
    });
    proc.on('error', reject);
    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-800)}`));
    });
  });
}

module.exports = { probeDuration, buildArgs, runFfmpeg };
