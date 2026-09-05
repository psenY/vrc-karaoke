'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { segmentAss } = require('./ass');

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

/** 合并分段视频（concat demuxer，无损） */
function concatVideos(segPaths, outPath) {
  const listFile = outPath + '.concat.txt';
  fs.writeFileSync(listFile, segPaths.map(p => `file '${p}'`).join('\n'));
  return runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-movflags', '+faststart', outPath])
    .finally(() => { try { fs.unlinkSync(listFile); } catch (e) {} });
}

/**
 * 分段并行编码：把一首歌切成 segCount 段，并行编码各段（单首吃多核），最后合并。
 */
async function runFfmpegSegmented(opts, segCount, onProgress) {
  const {
    audioPath, assText, fontDir, outPath, background,
    audioMs, width = 1920, height = 1080, fps = 24,
    crf = 20, preset = 'veryfast', audioBitrate = '192k',
  } = opts;
  const tmpDir = path.dirname(outPath);
  const segMs = Math.ceil(audioMs / segCount);

  const segments = [];
  for (let i = 0; i < segCount; i++) {
    const startMs = i * segMs;
    const endMs = Math.min((i + 1) * segMs, audioMs);
    if (startMs >= audioMs) break;
    segments.push({ idx: i, startMs, endMs });
  }
  if (segments.length <= 1) {
    // 太短不分段
    const fullAss = path.join(tmpDir, '_full.ass');
    fs.writeFileSync(fullAss, assText);
    const single = buildArgs({ audioPath, assPath: fullAss, fontDir, outPath, background, width, height, fps, crf, preset, audioBitrate });
    await runFfmpeg(single, onProgress);
    return;
  }

  const assFilter = (f) => `ass=${f}` + (fontDir ? `:fontsdir=${fontDir}` : '');
  const segOuts = segments.map(s => path.join(tmpDir, `seg_${s.idx}.mp4`));
  const segAsses = segments.map(s => path.join(tmpDir, `seg_${s.idx}.ass`));

  await Promise.all(segments.map(async (seg) => {
    const segAssPath = segAsses[seg.idx];
    const segOut = segOuts[seg.idx];
    fs.writeFileSync(segAssPath, segmentAss(assText, seg.startMs, seg.endMs));
    const segArgs = [
      '-y',
      '-f', 'lavfi', '-i', `color=c=${background}:s=${width}x${height}:r=${fps}`,
      '-ss', String(seg.startMs / 1000), '-i', audioPath,
      '-vf', assFilter(segAssPath),
      '-c:v', 'libx264', '-preset', preset, '-crf', String(crf), '-pix_fmt', 'yuv420p', '-threads', '0',
      '-c:a', 'aac', '-b:a', audioBitrate,
      '-t', String((seg.endMs - seg.startMs) / 1000),
      '-shortest',
      segOut,
    ];
    await runFfmpeg(segArgs, (sec) => {
      if (typeof onProgress === 'function' && audioMs > 0) {
        onProgress(Math.min(1, (seg.startMs / 1000 + sec) / (audioMs / 1000)));
      }
    });
  }));

  await concatVideos(segOuts, outPath);
  for (const p of [...segOuts, ...segAsses]) { try { fs.unlinkSync(p); } catch (e) {} }
}

module.exports = { probeDuration, buildArgs, runFfmpeg, runFfmpegSegmented, concatVideos };
