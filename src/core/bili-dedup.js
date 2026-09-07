'use strict';

/**
 * B站投稿查重与历史去重（纯函数，便于测试）。
 * 查重源 = 本工具的投稿历史（带 biliUrl 的条目）。
 */

/**
 * 历史去重：同 title 只保留最新（列表已按最新在前排序）。
 * @param {Array} list 历史记录数组
 */
function dedupeHistory(list) {
  const seen = new Set();
  const out = [];
  for (const h of list || []) {
    const key = h.title || h.outPath || JSON.stringify(h).slice(0, 50);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
  }
  return out;
}

/**
 * 查重：历史记录里该歌是否已有投稿（biliUrl 存在即本工具投过）。
 * title 匹配分级：
 *   - 完全一致（忽略大小写）→ 命中
 *   - 短标题（≤3 字符）只精确匹配（防"谁"误命中含"谁"字的其它标题）
 *   - 长标题（≥4 字符）允许相互包含
 * @param {Array} history 历史记录数组
 * @param {string} songTitle 当前歌曲标题
 * @returns {object|null} 命中的历史记录
 */
function findBiliDup(history, songTitle) {
  if (!songTitle) return null;
  const t = String(songTitle).toLowerCase();
  return (history || []).find(h => {
    if (!h.biliUrl || !h.title) return false;
    const ht = String(h.title).toLowerCase();
    if (ht === t) return true;
    if (t.length <= 3 || ht.length <= 3) return false;  // 短标题只精确匹配
    return ht.includes(t) || t.includes(ht);
  }) || null;
}

/**
 * B站投稿模板渲染：支持 {歌名} {音质} {比特率} {分辨率} {日期} 变量。
 * @param {string} tpl 模板字符串
 * @param {{songTitle:string, levelLabel:string, brLabel:string, resolution:string}} vars 变量值
 */
function renderBiliTpl(tpl, vars) {
  const v = vars || {};
  return String(tpl || '')
    .replace(/\{歌名\}/g, v.songTitle || '')
    .replace(/\{音质\}/g, v.levelLabel || '')
    .replace(/\{比特率\}/g, v.brLabel || '')
    .replace(/\{分辨率\}/g, v.resolution || '')
    .replace(/\{日期\}/g, new Date().toISOString().slice(0, 10));
}

module.exports = { dedupeHistory, findBiliDup, renderBiliTpl };
