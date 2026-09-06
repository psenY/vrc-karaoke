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

/** 用 ffprobe 读取音频码率（bps，读取失败返回 0）。FLAC 等 VBR 无损流 bit_rate 是 N/A，回退容器 format.bit_rate */
function probeBitrate(filePath) {
  return new Promise((resolve) => {
    const proc = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'stream=bit_rate:format=bit_rate',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ]);
    let out = '';
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', () => {});
    proc.on('error', () => resolve(0));
    proc.on('close', () => {
      const vals = out.trim().split('\n').map(s => parseInt(s, 10)).filter(v => v > 0);
      resolve(vals.length ? Math.max(...vals) : 0);
    });
  });
}

/** 用 ffprobe 读取音频编码器名（如 flac/aac/mp3），失败返回 '' */
function probeCodec(filePath) {
  return new Promise((resolve) => {
    const proc = spawn('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name', '-of', 'default=noprint_wrappers=1:nokey=1', filePath]);
    let out = '';
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', () => {});
    proc.on('error', () => resolve(''));
    proc.on('close', () => resolve(out.trim()));
  });
}

/** 按音源实际码率对齐最终 AAC 码率（auto 逻辑）：无损级→512k、320k 级→320k、192k→192k、128k→128k */
function resolveAudioBitrate(audioBitrate, srcBitrate) {
  if (audioBitrate !== 'auto') return audioBitrate;
  if (!srcBitrate || srcBitrate < 140000) return '128k';
  if (srcBitrate < 220000) return '192k';
  if (srcBitrate < 800000) return '320k';   // 320k 音源 → AAC 320k
  return '512k';  // 无损/高音质源(≥800k) → AAC 512k（接近无损，兼容播放器；MP4 封装 FLAC 播放器不认）
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
    codec = 'libx264',
    coverPath = null,
    flacAudio = false,   // 无损封装：音频保持 FLAC
  } = opts;

  // fps filter 强制每帧精确 1/fps PTS，避免帧时间戳抖动导致音画漂移
  const assFilter = `fps=${fps},ass=${assPath}` + (fontDir ? `:fontsdir=${fontDir}` : '');

  // 封面背景：coverPath 已是预生成的模糊背景图，歌词叠加
  if (coverPath) {
    const filterComplex = `[0:v]${assFilter}[v]`;
    return [
      '-y',
      '-loop', '1', '-i', coverPath,
      '-i', audioPath,
      '-filter_complex', filterComplex,
      '-map', '[v]', '-map', '1:a',
      '-c:v', codec, '-preset', preset, '-crf', String(crf), '-pix_fmt', 'yuv420p', '-threads', '0',
      '-c:a', flacAudio ? 'flac' : 'aac',
      ...(flacAudio ? ['-strict', '-2'] : ['-b:a', audioBitrate]),
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
    '-c:v', codec, '-preset', preset, '-crf', String(crf), '-pix_fmt', 'yuv420p', '-threads', '0',
    '-c:a', flacAudio ? 'flac' : 'aac',
    ...(flacAudio ? ['-strict', '-2'] : ['-b:a', audioBitrate]),
    '-shortest',
    '-movflags', '+faststart',
    outPath,
  ];
}

function runFfmpeg(args, onProgress, onSpawn) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args);
    if (typeof onSpawn === 'function') onSpawn(proc);
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
function concatVideos(segPaths, outPath, onSpawn) {
  const listFile = outPath + '.concat.txt';
  fs.writeFileSync(listFile, segPaths.map(p => `file '${p}'`).join('\n'));
  // -shortest：以最短流（视频）为准，避免音频流时长异常拉长总时长
  return runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-shortest', '-movflags', '+faststart', outPath], null, onSpawn)
    .finally(() => { try { fs.unlinkSync(listFile); } catch (e) {} });
}

/**
 * 分段并行编码：把一首歌切成 segCount 段，并行编码各段（单首吃多核），最后合并。
 */
async function runFfmpegSegmented(opts, segCount, onProgress) {
  const {
    audioPath, assText, fontDir, outPath, background, coverPath = null,
    audioMs, width = 1920, height = 1080, fps = 24,
    crf = 20, preset = 'veryfast', audioBitrate = '192k', codec = 'libx264',
    flacAudio = false,   // 无损封装：音频保持 FLAC（部分播放器不支持）
    onSpawn = null,
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
    const single = buildArgs({ audioPath, assPath: fullAss, fontDir, outPath, background, width, height, fps, crf, preset, audioBitrate, flacAudio });
    await runFfmpeg(single, onProgress);
    return;
  }

  // 1. 完整音频一次性转 AAC（音频完全连续，不参与分段，避免拼接处间隙）
  // 1. 完整音频一次性转码（音频完全连续，不参与分段，避免拼接处间隙）
  //    无损封装用 FLAC（保留音源码率），否则 AAC 输出到 .m4a 容器（裸流 .aac 的 duration 计算有 bug，会异常拉长）
  const audioExt = flacAudio ? 'flac' : 'm4a';
  const audioOutPath = path.join(tmpDir, '_audio.' + audioExt);
  const audioArgs = ['-y', '-i', audioPath, '-vn', '-c:a', flacAudio ? 'flac' : 'aac', '-ac', '2'];
  if (flacAudio) audioArgs.push('-strict', '-2');
  else audioArgs.push('-b:a', audioBitrate);
  audioArgs.push(audioOutPath);
  await runFfmpeg(audioArgs, null, onSpawn);

  // 2. 视频分段并行编码（无音频 -an；coverPath 已是预生成的模糊背景图）
  // fps filter 强制每帧精确 1/fps PTS（lavfi 源默认帧 PTS 有周期性抖动，累积成音画漂移）
  const assFilter = (f) => `fps=${fps},ass=${f}` + (fontDir ? `:fontsdir=${fontDir}` : '');
  const segOuts = segments.map(s => path.join(tmpDir, `seg_${s.idx}.mp4`));
  const segAsses = segments.map(s => path.join(tmpDir, `seg_${s.idx}.ass`));

  await Promise.all(segments.map(async (seg) => {
    const segAssPath = segAsses[seg.idx];
    const segOut = segOuts[seg.idx];
    fs.writeFileSync(segAssPath, segmentAss(assText, seg.startMs, seg.endMs));
    // 每段精确帧数 + 恒定帧率(CFR)，避免帧时长微调导致 VFR 使歌词随播放漂移
    const segFrames = Math.max(1, Math.round((seg.endMs - seg.startMs) / 1000 * fps));
    const segArgs = coverPath ? [
      '-y',
      '-loop', '1', '-i', coverPath,
      '-vf', assFilter(segAssPath),
      '-an',
      '-c:v', codec, '-preset', preset, '-crf', String(crf), '-pix_fmt', 'yuv420p', '-threads', '0',
      '-fps_mode', 'cfr',
      '-frames:v', String(segFrames),
      segOut,
    ] : [
      '-y',
      '-f', 'lavfi', '-i', `color=c=${background}:s=${width}x${height}:r=${fps}`,
      '-vf', assFilter(segAssPath),
      '-an',
      '-c:v', codec, '-preset', preset, '-crf', String(crf), '-pix_fmt', 'yuv420p', '-threads', '0',
      '-fps_mode', 'cfr',
      '-frames:v', String(segFrames),
      segOut,
    ];
    await runFfmpeg(segArgs, (sec) => {
      if (typeof onProgress === 'function') {
        const segDurSec = (seg.endMs - seg.startMs) / 1000;
        onProgress({ segIdx: seg.idx, progress: Math.min(1, sec / segDurSec) });
      }
    }, onSpawn);
  }));

  // 3. 视频 concat + 重编码（filter concat 拼接所有段 + setpts 强制帧时间戳均匀）
  //    concat demuxer 拼接时段边界帧 PTS 会跳变(0.167s/边界)，播放器累积漂移导致歌词越来越慢
  const videoPath = path.join(tmpDir, '_video.mp4');
  const segInputs = segOuts.map(p => ['-i', p]).flat();
  const concatFilter = segOuts.map((_, i) => `[${i}:v]`).join('') + `concat=n=${segOuts.length}:v=1:a=0,setpts=N/${fps}/TB[v]`;
  await runFfmpeg(['-y', ...segInputs, '-filter_complex', concatFilter, '-map', '[v]', '-c:v', codec, '-preset', preset, '-crf', String(crf), '-pix_fmt', 'yuv420p', '-threads', '0', videoPath], null, onSpawn);

  // 4. 视频 + 完整音频 mux（无损，音频完全连续；FLAC 封装需 -strict -2）
  const muxArgs = ['-y', '-i', videoPath, '-i', audioOutPath, '-c', 'copy', '-shortest', '-movflags', '+faststart'];
  if (flacAudio) muxArgs.push('-strict', '-2');
  muxArgs.push(outPath);
  await runFfmpeg(muxArgs, null, onSpawn);

  // 清理临时文件
  for (const p of [...segOuts, ...segAsses, videoPath, audioOutPath]) { try { fs.unlinkSync(p); } catch (e) {} }
}

module.exports = { probeDuration, probeBitrate, probeCodec, resolveAudioBitrate, buildArgs, runFfmpeg, runFfmpegSegmented, concatVideos };
