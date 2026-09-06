'use strict';

/**
 * 解析 LRC 歌词文本，返回逐句时间轴。
 * 时间单位统一为毫秒，lines 按时间升序。
 */

function parseTimeTag(tag) {
  // tag 形如 "00:15" / "00:15.20" / "00:15.205"
  const m = tag.match(/^(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?$/);
  if (!m) return null;
  const min = parseInt(m[1], 10);
  const sec = parseInt(m[2], 10);
  let frac = 0;
  if (m[3]) {
    const f = m[3];
    if (f.length === 3) frac = parseInt(f, 10);            // 毫秒
    else if (f.length === 2) frac = parseInt(f, 10) * 10;  // 百分秒
    else frac = parseInt(f.padEnd(3, '0'), 10);
  }
  return (min * 60 + sec) * 1000 + frac;
}

function parseLrc(lrcText) {
  const meta = {};
  const lines = [];
  let offset = 0;

  const rawLines = String(lrcText || '').split(/\r?\n/);
  for (const raw of rawLines) {
    const line = raw.trim();
    if (!line) continue;

    // 元数据标签 [ti:xx] / [ar:xx] / [offset:xx]
    const metaMatch = line.match(/^\[(ti|ar|al|by|offset|re|ve|au|length):([^\]]*)\]/i);
    if (metaMatch) {
      const key = metaMatch[1].toLowerCase();
      const val = metaMatch[2].trim();
      meta[key] = val;
      if (key === 'offset') {
        const o = parseInt(val, 10);
        if (!Number.isNaN(o)) offset = o;
      }
      continue;
    }

    // 时间标签（一行可含多个时间标签，对应重复副歌）
    const tags = [...line.matchAll(/\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g)];
    if (tags.length === 0) continue;

    const text = line.replace(/\[[^\]]*\]/g, '').trim();
    if (!text) continue;  // 跳过空歌词行（空拍/间隔标记），避免打断相邻句的下一句预览
    for (const tag of tags) {
      const timeMs = parseTimeTag(tag[0].slice(1, -1));
      if (timeMs === null) continue;
      lines.push({ time: timeMs + offset, text });
    }
  }

  lines.sort((a, b) => a.time - b.time);
  return { meta, lines };
}

module.exports = { parseLrc, parseTimeTag };
