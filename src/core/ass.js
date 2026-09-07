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

function buildHeader(playResX, playResY, fontName, fontSize, colors = {}) {
  const transSize = Math.round(fontSize * 0.6);
  const {
    currentColor = '&H00FFFFFF',
    nextColor = '&H00969696',
    titleColor = '&H00FFFFFF',
    progressColor = '&H00FFFFFF',
  } = colors;
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${playResX}
PlayResY: ${playResY}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Current,${fontName},${fontSize},${currentColor},&H00969696,&H00000000,&H96000000,-1,0,0,0,100,100,0,0,1,4,2,2,100,100,200,1
Style: Next,${fontName},${fontSize},${nextColor},${nextColor},&H00000000,&H96000000,-1,0,0,0,100,100,0,0,1,3,1,2,100,100,200,1
Style: Trans,${fontName},${transSize},${nextColor},${nextColor},&H00000000,&H96000000,-1,0,0,0,100,100,0,0,1,3,1,2,100,100,200,1
Style: Title,${fontName},54,${titleColor},${titleColor},&H00000000,&H96000000,-1,0,0,0,100,100,0,0,1,4,2,8,100,100,60,1
Style: Progress,${fontName},48,${progressColor},${progressColor},&H00000000,&H96000000,-1,0,0,0,100,100,0,0,1,4,2,9,100,100,60,1
Style: Intro,${fontName},42,&H00FFFFFF,&H00FFFFFF,&H00000000,&H96000000,-1,0,0,0,100,100,0,0,1,6,2,5,100,100,0,1
Style: Mask,${fontName},1,&H00000000,&H00000000,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1

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

// 秒 -> mm:ss
function formatClock(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ASS 时间 H:MM:SS.cc -> 毫秒
function parseAssTime(t) {
  const m = String(t).match(/(\d+):(\d+):(\d+)[.:](\d+)/);
  if (!m) return 0;
  return (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000 + Number(m[4]) * 10;
}

// 从完整 ASS 提取 [startMs, endMs) 时间段，时间偏移到段内（用于分段并行编码）
function segmentAss(assText, startMs, endMs) {
  const lines = assText.split('\n');
  const header = [];
  const events = [];
  let inEvents = false;
  const segLen = endMs - startMs;
  for (const line of lines) {
    if (!inEvents) {
      header.push(line);
      if (line.startsWith('[Events]')) inEvents = true;
      continue;
    }
    if (!line.startsWith('Dialogue:')) { events.push(line); continue; }
    const m = line.match(/^Dialogue: (\d+),([^,]+),([^,]+),(.*)$/);
    if (!m) { events.push(line); continue; }
    const start = parseAssTime(m[2]);
    const end = parseAssTime(m[3]);
    const segStart = Math.max(start, startMs) - startMs;
    const segEnd = Math.min(end, endMs) - startMs;
    if (segEnd > 0 && segStart < segLen) {
      events.push(`Dialogue: ${m[1]},${formatAssTime(segStart)},${formatAssTime(segEnd)},${m[4]}`);
    }
  }
  return header.join('\n') + '\n' + events.join('\n') + '\n';
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

// 估算文本显示宽度（全角≈1字宽、半角≈0.5字宽，Noto Sans CJK 拉丁实测约0.5em），单位 px
function estTextWidth(text, fontSize) {
  let units = 0;
  for (const ch of String(text)) {
    units += ch.charCodeAt(0) > 255 ? 1 : 0.5;
  }
  return units * fontSize;
}

// 长句断行 + 字号自适应：单行放不下则拆两行（中文按字符对半、英文优先空格），
// 两行时字号压到 ≤90（两行 ≤180px，配合翻译行总高不超过槽位间距，防溢出屏幕顶部），仍超则继续缩到 60
function fitLyricLine(text, fontSize, maxWidth) {
  const str = String(text);
  if (estTextWidth(str, fontSize) <= maxWidth) return { cut: 0, fontSize };
  let cut = Math.floor(str.length / 2);
  const spaceIdx = str.lastIndexOf(' ', cut);
  if (spaceIdx > str.length * 0.25) cut = spaceIdx + 1;  // 英文优先在空格处断
  let fs = Math.min(fontSize, 90);                        // 两行高度约束
  while (fs >= 60) {
    if (estTextWidth(str.slice(0, cut), fs) <= maxWidth && estTextWidth(str.slice(cut), fs) <= maxWidth) break;
    fs -= 10;
  }
  return { cut, fontSize: fs };
}

// 在含 {\k...} 标签的文本第 cut 个实际字符后插入 \N（断行）
function insertBreakAtTagged(tagged, cut) {
  let count = 0, out = '', i = 0;
  while (i < tagged.length) {
    if (tagged[i] === '{') {
      const end = tagged.indexOf('}', i);
      out += tagged.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    out += tagged[i];
    count++;
    if (count === cut) out += '\\N';
    i++;
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
    topMarginV = 580,
    bottomMarginV = 380,
    bilingual = false,        // 双语（原文 + 翻译）
    title = '',               // 顶部歌曲信息（歌名-歌手）
    showProgress = false,     // 右上角进度 [当前/总时长]
    currentColor = '&H00FFFFFF',   // 当前句颜色
    nextColor = '&H00969696',      // 下一句/翻译颜色
    titleColor = '&H00FFFFFF',     // 标题颜色
    progressColor = '&H00FFFFFF',  // 进度颜色
    introText = '',           // 片头信息卡文本（完整 ASS 文本，含 \fs/\N 标签；空=不加）
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

    // 长句处理：断行 + 字号自适应（\an4 左对齐时右边距不约束，只留左边距 100）
    const maxWidth = playResX - 100;
    const transSize = Math.round(fontSize * 0.6);
    const fitted = fitLyricLine(curText, fontSize, maxWidth);
    let curFull = fitted.cut > 0 ? insertBreakAtTagged(highlightText, fitted.cut) : highlightText;
    if (fitted.fontSize !== fontSize) curFull = `{\\fs${fitted.fontSize}}` + curFull;
    // 双语：当前句附加翻译。翻译保持单行（超长缩字号），总行数≤3 防上槽溢出屏幕顶部
    if (bilingual && cur.translation) {
      const fsTag = (() => {
        const tw = estTextWidth(cur.translation, transSize);
        return tw > maxWidth ? `{\\fs${Math.max(28, Math.round(transSize * maxWidth / tw))}}` : '';
      })();
      curFull += `\\N{\\rTrans}${fsTag}${escapeAssText(cur.translation)}`;
    }

    // 交替槽位：句 i 在槽位 i%2
    const curSlot = i % 2;
    const curMarginV = curSlot === 0 ? topMarginV : bottomMarginV;
    events.push(
      `Dialogue: 0,${formatAssTime(startMs)},${formatAssTime(endMs)},Current,,0,0,${curMarginV},,${curFull}`
    );

    // 下一句（灰，对侧槽位）：显示到下一句自己开始（间隔大时保持提前预览，不中途消失）
    if (showNext && i + 1 < lines.length) {
      const next = lines[i + 1];
      const nextText = getLineText(next);
      if (nextText) {
        const nfitted = fitLyricLine(nextText, fontSize, maxWidth);
        let nextFull = nfitted.cut > 0 ? insertBreakAtTagged(escapeAssText(nextText), nfitted.cut) : escapeAssText(nextText);
        if (nfitted.fontSize !== fontSize) nextFull = `{\\fs${nfitted.fontSize}}` + nextFull;
        if (bilingual && next.translation) {
          const tw = estTextWidth(next.translation, transSize);
          const fsTag = tw > maxWidth ? `{\\fs${Math.max(28, Math.round(transSize * maxWidth / tw))}}` : '';
          nextFull += `\\N{\\rTrans}${fsTag}${escapeAssText(next.translation)}`;
        }
        const nextSlot = (i + 1) % 2;
        const nextMarginV = nextSlot === 0 ? topMarginV : bottomMarginV;
        const nextStartTime = next.startMs ?? next.time;
        const nextEnd = Math.max(endMs, nextStartTime);  // 至少显示到当前句结束；间隔大时持续到下一句开始
        events.push(
          `Dialogue: 0,${formatAssTime(startMs)},${formatAssTime(nextEnd)},Next,,0,0,${nextMarginV},,${nextFull}`
        );
      }
    }
  }

  // 顶部歌曲信息（贯穿整个视频）
  if (title) {
    const titleEnd = audioDurationMs ?? (lines.length ? (lines[lines.length - 1].startMs ?? 0) + 5000 : 300000);
    events.unshift(
      `Dialogue: 0,0:00:00.00,${formatAssTime(titleEnd)},Title,,0,0,0,,${escapeAssText(title)}`
    );
  }

  // 右上角进度 [当前/总时长]（每秒一条）
  if (showProgress && audioDurationMs) {
    const totalSec = Math.max(1, Math.round(audioDurationMs / 1000));
    const totalStr = formatClock(totalSec);
    for (let sec = 0; sec < totalSec; sec++) {
      events.push(
        `Dialogue: 0,${formatAssTime(sec * 1000)},${formatAssTime((sec + 1) * 1000)},Progress,,0,0,0,,[${formatClock(sec)} / ${totalStr}]`
      );
    }
  }

  // 片头信息卡（前 3 秒：50% 黑遮罩 + 中央多行信息，无淡入淡出）
  // introText 由调用方生成完整 ASS 文本（含 \fs/\N 标签，文字已转义），这里直接插入
  if (introText) {
    // 全屏 50% 黑遮罩（\c 黑色 + \alpha&H80& = 50% 不透明；大字号方块铺满）
    events.push(
      `Dialogue: 0,0:00:00.00,0:00:03.00,Mask,,0,0,0,,{\\pos(960,540)\\fs1080\\fscx(178)\\c&H000000&\\alpha&H80&}█`
    );
    events.push(
      `Dialogue: 0,0:00:00.00,0:00:03.00,Intro,,0,0,0,,${introText}`
    );
  }

  return buildHeader(playResX, playResY, fontName, fontSize, { currentColor, nextColor, titleColor, progressColor }) + events.join('\n') + '\n';
}

module.exports = { generateAss, formatAssTime, segmentAss, buildWordHighlight, buildEstimatedHighlight, escapeAssText, fitLyricLine };
