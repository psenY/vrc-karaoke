'use strict';

const netease = require('./netease');
const youtube = require('./youtube');
const qqmusic = require('./qqmusic');

const platforms = [netease, youtube, qqmusic];

/**
 * 根据输入找到匹配的平台。
 * explicitId（--id）强制走网易云；否则按 URL 匹配，YouTube 优先，默认网易云。
 */
function findPlatform(input, { explicitId = false } = {}) {
  if (explicitId) return netease;
  return platforms.find(p => p.matches(input)) || netease;
}

module.exports = { platforms, findPlatform };
