'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { parseLrc, parseTimeTag } = require('../src/core/lyrics');
const { generateAss, segmentAss, formatAssTime } = require('../src/core/ass');

// ---- lyrics.js ----

test('parseTimeTag 解析分钟:秒', () => {
  assert.equal(parseTimeTag('00:15'), 15000);
  assert.equal(parseTimeTag('01:00'), 60000);
});

test('parseTimeTag 解析毫秒', () => {
  assert.equal(parseTimeTag('00:15.20'), 15200);   // 百分秒
  assert.equal(parseTimeTag('00:15.205'), 15205);  // 毫秒
});

test('parseLrc 解析标准 LRC', () => {
  const lrc = '[00:00.00]第一句\n[00:10.00]第二句\n[00:20.00]第三句';
  const { lines } = parseLrc(lrc);
  assert.equal(lines.length, 3);
  assert.equal(lines[0].text, '第一句');
  assert.equal(lines[0].time, 0);
  assert.equal(lines[1].time, 10000);
});

test('parseLrc 忽略元信息行', () => {
  const lrc = '[ti:歌名]\n[ar:歌手]\n[00:00.00]歌词';
  const { lines, meta } = parseLrc(lrc);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, '歌词');
  assert.equal(meta.ti, '歌名');
  assert.equal(meta.ar, '歌手');
});

test('parseLrc 应用 offset', () => {
  const lrc = '[offset:1000]\n[00:00.00]歌词';
  const { lines } = parseLrc(lrc);
  assert.equal(lines[0].time, 1000);
});

test('parseLrc 一行多时间标签(重复副歌)', () => {
  const lrc = '[00:00.00][00:30.00]副歌';
  const { lines } = parseLrc(lrc);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].time, 0);
  assert.equal(lines[1].time, 30000);
});

// ---- ass.js ----

test('formatAssTime 正确格式化', () => {
  assert.equal(formatAssTime(0), '0:00:00.00');
  assert.equal(formatAssTime(10000), '0:00:10.00');
  assert.equal(formatAssTime(60000), '0:01:00.00');
  assert.equal(formatAssTime(3600000), '1:00:00.00');
});

test('generateAss 生成含歌曲信息和进度', () => {
  const ass = generateAss(
    [{ startMs: 0, text: '测试歌词' }],
    { title: '歌名 - 歌手', audioDurationMs: 10000, showProgress: true }
  );
  assert.ok(ass.includes('[Events]'));
  assert.ok(ass.includes('Style: Title'));
  assert.ok(ass.includes('歌名 - 歌手'));
  assert.ok(ass.includes('Style: Progress'));
  assert.ok(ass.includes('测试歌词'));
});

test('generateAss 应用自定义颜色', () => {
  const ass = generateAss(
    [{ startMs: 0, text: '歌词' }],
    { currentColor: '&H000000FF', audioDurationMs: 5000 }
  );
  assert.ok(ass.includes('&H000000FF'));
});

test('segmentAss 提取时间段并偏移', () => {
  const ass = generateAss(
    [{ startMs: 0, text: '第一句歌词' }, { startMs: 5000, text: '第二句歌词' }],
    { audioDurationMs: 10000, showProgress: false }
  );
  const seg = segmentAss(ass, 5000, 10000);
  assert.ok(seg.includes('第二句歌词'));
  assert.ok(!seg.includes('第一句歌词'));  // 第一句在段外，不包含
  assert.ok(seg.includes('0:00:00.00'));  // 第二句偏移到段内 0 起点
});

test('generateAss 双语附加翻译', () => {
  const ass = generateAss(
    [{ startMs: 0, text: '原文', translation: '翻译' }],
    { bilingual: true, audioDurationMs: 5000 }
  );
  assert.ok(ass.includes('原文'));
  assert.ok(ass.includes('翻译'));
  assert.ok(ass.includes('Style: Trans'));
});
