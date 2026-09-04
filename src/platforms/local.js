'use strict';

const fs = require('fs');
const path = require('path');
const { parseLrc } = require('../core/lyrics');
const { probeDuration } = require('../core/ffmpeg');

/**
 * 本地文件平台：输入音频文件路径 + 同目录同名 .lrc 歌词，直接生成。
 * 作为网络平台受版权限制时的兜底方案。
 */
module.exports = {
  id: 'local',
  name: '本地文件',

  matches(input) {
    try { return fs.existsSync(input) && fs.statSync(input).isFile(); }
    catch (e) { return false; }
  },

  async fetch(input, options = {}) {
    const audioPath = input;
    const audioMs = await probeDuration(audioPath);

    // 歌词：同目录同名 .lrc
    const lrcPath = input.replace(/\.[^.]+$/, '.lrc');
    if (!fs.existsSync(lrcPath)) {
      throw new Error('未找到歌词文件（需与音频同目录同名的 .lrc，如 song.mp3 + song.lrc）');
    }
    const parsed = parseLrc(fs.readFileSync(lrcPath, 'utf8')).lines;
    if (!parsed.length) throw new Error('歌词解析为空');
    const lines = parsed.map(l => ({ startMs: l.time, text: l.text }));

    return {
      meta: { id: path.basename(input, path.extname(input)), title: path.basename(input), source: 'local' },
      lines,
      audioPath,
      audioMs,
    };
  },
};
