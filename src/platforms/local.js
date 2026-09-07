'use strict';

const fs = require('fs');
const path = require('path');
const { parseLrc } = require('../core/lyrics');
const { probeDuration } = require('../core/ffmpeg');

/**
 * 本地文件平台：输入音频文件路径 + 同目录同名 .lrc 歌词，直接生成。
 * 作为网络平台受版权限制时的兜底方案。
 */

// 读取 LRC 文件（自动检测 UTF-8 / GBK 编码，避免中文歌词乱码）
function readLrcFile(lrcPath) {
  const buf = fs.readFileSync(lrcPath);
  const utf8 = buf.toString('utf8');
  if (utf8.includes('\ufffd')) {
    try {
      return new TextDecoder('gbk').decode(buf);
    } catch (e) {
      return utf8;
    }
  }
  return utf8;
}

module.exports = {
  id: 'local',
  name: '本地文件',

  matches(input) {
    // 安全加固：仅接受音频扩展名（防任意文件被当音频源处理）
    if (typeof input !== 'string') return false;
    if (!/\.(mp3|flac|m4a|wav|aac|ogg|opus)$/i.test(input)) return false;
    try { return fs.existsSync(input) && fs.statSync(input).isFile(); }
    catch (e) { return false; }
  },

  async fetch(input, options = {}) {
    const audioPath = input;
    const audioMs = await probeDuration(audioPath);

    // 歌词：同目录同名 .lrc（自动检测编码）
    const lrcPath = input.replace(/\.[^.]+$/, '.lrc');
    if (!fs.existsSync(lrcPath)) {
      throw new Error('未找到歌词文件（需与音频同目录同名的 .lrc，如 song.mp3 + song.lrc）');
    }
    const parsed = parseLrc(readLrcFile(lrcPath)).lines;
    if (!parsed.length) throw new Error('歌词解析为空');
    const lines = parsed.map(l => ({ startMs: l.time, text: l.text, endMs: l.endMs }));

    return {
      meta: { id: path.basename(input, path.extname(input)), title: path.basename(input, path.extname(input)), source: 'local' },
      lines,
      audioPath,
      audioMs,
    };
  },
};
