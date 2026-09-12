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
    if (!text) {
      // 空歌词行 = 上一句的结束标记。但很多 LRC 会用 [03:04.61] 这类**远距离**的
      // 纯时间戳标记间奏/段落，若无条件采纳，上一句的 endMs 会被拉到那里、
      // 导致它在接下来几分钟里一直显示（实测：46.85s 的句子 endMs 被设为 184.61s，
      // 该句与其"下一句预览"整段常驻，画面同时出现 4 行）。
      // 因此只在"与上一句间隔在正常句长范围内"时才采纳。
      if (lines.length > 0) {
        const t = parseTimeTag(tags[0][0].slice(1, -1));
        const prev = lines[lines.length - 1];
        if (t !== null && t > prev.time && t - prev.time <= 15000) {
          prev.endMs = t + offset;
        }
      }
      continue;
    }
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
