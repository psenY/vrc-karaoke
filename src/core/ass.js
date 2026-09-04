'use strict';

/**
 * 生成 ASS 字幕。核心差异化：下一句预览 + 当前句高亮。
 *
 * 布局（1920x1080）：上下两个固定槽位"AB切换"交替显示。
 *   句 i 显示在槽位 i%2（0=上、1=下），下一句显示在对侧槽位。
 *   两句字号相同、仅颜色区分（当前句白 / 下一句灰）。
 *   切换时：当前句原地变灰消失，下一句在对侧槽位原地变亮——歌词不做上下移动。
 *
 * 支持两种歌词数据：
 *   网易云：{time, text, translation?}（逐句，无逐字 → 逐字用估算）
 *   YouTube：{startMs, endMs, words:[{text, startMs}]}（含词级时间戳 → 真逐字）
 *
 * 双语：bilingual 开启时，每句在原文下方附加翻译（Trans 样式小字灰）。
 */

function buildHeader(playResX, playResY, fontName, fontSize) {
  const transSize = Math.round(fontSize * 0.6);
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${playResX}
PlayResY: ${playResY}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Current,${fontName},${fontSize},&H00FFFFFF,&H00969696,&H00000000,&H96000000,-1,0,0,0,100,100,0,0,1,4,2,2,100,100,200,1
Style: Next,${fontName},${fontSize},&H00969696,&H00969696,&H00000000,&H96000000,-1,0,0,0,100,100,0,0,1,3,1,2,100,100,200,1
Style: Trans,${fontName},${transSize},&H00969696,&H00969696,&H00000000,&H96000000,-1,0,0,0,100,100,0,0,1,3,1,2,100,100,200,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
}

// 毫秒 -> H:MM:SS.cc（厘秒）
function formatAssTime(ms) {
  const cs = Math.max(0, Math.round(ms / 10));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}

function escapeAssText(text) {
  return String(text)
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}');
}

// 判断字符是否参与逐字计时（字母/数字/中日韩）
function isTimedChar(c) {
  return /[\p{L}\p{N}]/u.test(c);
}

/** 统一取一行歌词的文本（兼容 {text} 与 {words} 两种结构） */
function getLineText(line) {
  if (!line) return '';
  if (line.text !== undefined) return line.text;
  if (Array.isArray(line.words)) return line.words.map(w => w.text).join('');
  return '';
}

/**
 * 估算逐字：按字数均分时长（用于无逐字时间戳的网易云歌词）。
 */
function buildEstimatedHighlight(text, startMs, endMs, mode) {
  if (mode !== 'word') return escapeAssText(text);

  const chars = [...text];
  const timedCount = chars.filter(isTimedChar).length;
  if (timedCount === 0) return escapeAssText(text);

  const dur = Math.max(1, endMs - startMs);
  const perChar = dur / timedCount;
  let out = '';
  for (const c of chars) {
    if (isTimedChar(c)) {
      const k = Math.max(1, Math.round(perChar / 10));
      out += `{\\k${k}}${escapeAssText(c)}`;
    } else {
      out += escapeAssText(c);
    }
  }
  return out;
}

/**
 * 精确逐字：用词级时间戳（YouTube json3）生成 \k 标签。
 * @param {Array<{text:string,startMs:number}>} words
 * @param {number} endMs 句结束时间
 */
function buildWordHighlight(words, endMs) {
  let out = '';
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const nextStart = (i + 1 < words.length) ? words[i + 1].startMs : endMs;
    const durMs = Math.max(1, nextStart - w.startMs);
    const k = Math.max(1, Math.round(durMs / 10));
    out += `{\\k${k}}${escapeAssText(w.text)}`;
  }
  return out;
}

function generateAss(lines, options = {}) {
  const {
    playResX = 1920,
    playResY = 1080,
    fontName = 'Noto Sans CJK SC',
    highlight = 'line',       // 'line' | 'word'
    showNext = true,
    audioDurationMs = null,
    fontSize = 150,
    topMarginV = 420,
    bottomMarginV = 200,
    bilingual = false,        // 双语（原文 + 翻译）
  } = options;

  const events = [];
  for (let i = 0; i < lines.length; i++) {
    const cur = lines[i];

    // 统一取 start/end
    const startMs = cur.startMs ?? cur.time;
    let endMs = cur.endMs;
    if (endMs === undefined) {
      const next = lines[i + 1];
      endMs = next ? (next.startMs ?? next.time) : (audioDurationMs ?? startMs + 5000);
    }
    if (endMs <= startMs) continue;

    const curText = getLineText(cur);
    if (!curText) continue;

    // 当前句高亮文本
    let highlightText;
    if (highlight === 'word' && Array.isArray(cur.words) && cur.words.length) {
      highlightText = buildWordHighlight(cur.words, endMs); // 精确逐字
    } else {
      highlightText = buildEstimatedHighlight(curText, startMs, endMs, highlight);
    }

    // 双语：当前句附加翻译
    let curFull = highlightText;
    if (bilingual && cur.translation) {
      curFull += `\\N{\\rTrans}${escapeAssText(cur.translation)}`;
    }

    // 交替槽位：句 i 在槽位 i%2
    const curSlot = i % 2;
    const curMarginV = curSlot === 0 ? topMarginV : bottomMarginV;
    events.push(
      `Dialogue: 0,${formatAssTime(startMs)},${formatAssTime(endMs)},Current,,0,0,${curMarginV},,${curFull}`
    );

    // 下一句（灰，对侧槽位）
    if (showNext && i + 1 < lines.length) {
      const next = lines[i + 1];
      const nextText = getLineText(next);
      if (nextText) {
        let nextFull = escapeAssText(nextText);
        if (bilingual && next.translation) {
          nextFull += `\\N{\\rTrans}${escapeAssText(next.translation)}`;
        }
        const nextSlot = (i + 1) % 2;
        const nextMarginV = nextSlot === 0 ? topMarginV : bottomMarginV;
        events.push(
          `Dialogue: 0,${formatAssTime(startMs)},${formatAssTime(endMs)},Next,,0,0,${nextMarginV},,${nextFull}`
        );
      }
    }
  }

  return buildHeader(playResX, playResY, fontName, fontSize) + events.join('\n') + '\n';
}

module.exports = { generateAss, formatAssTime, buildWordHighlight, buildEstimatedHighlight };
