'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const { platforms } = require('./platforms');
const { generateVideo } = require('./generate');
const { getPlaylist, getQrKey, getQrImg, checkQrLogin, getUserInfo } = require('./core/netease-api');

const ROOT = path.join(__dirname, '..');
const HISTORY_FILE = path.join(ROOT, 'output', 'history.json');
const CONFIG_FILE = path.join(ROOT, 'config.json');

const app = express();
app.use(express.json());
app.use(express.static(path.join(ROOT, 'public')));
app.use('/output', express.static(path.join(ROOT, 'output')));

const tasks = new Map();
let taskSeq = 0;
const queue = [];
let running = 0;
const MAX_CONCURRENT = 1; // 串行(用户要求一首一首来, 单首内部用分段并行吃多核)

function runNext() {
  while (running < MAX_CONCURRENT && queue.length > 0) {
    const { id, input, options } = queue.shift();
    const t = tasks.get(id);
    t.status = 'running';
    t.progress = 0;
    running++;
    options.onProgress = (progress) => {
      if (progress && typeof progress === 'object' && progress.segIdx !== undefined) {
        // 分段进度：progress 是 {segIdx, progress}
        if (!Array.isArray(t.progress)) t.progress = [];
        t.progress[progress.segIdx] = progress.progress;
      } else {
        t.progress = progress;
      }
    };
    generateVideo(input, options)
      .then(result => {
        t.status = 'done';
        t.result = result;
        appendHistory({ input, title: result.meta.title, source: result.meta.source, outPath: result.outPath, url: result.url, time: Date.now() });
      })
      .catch(err => { t.status = 'failed'; t.error = err.message; })
      .finally(() => { running--; runNext(); });
  }
}

// ---- 历史记录 ----
function readHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); }
  catch (e) { return []; }
}
function appendHistory(entry) {
  const h = readHistory();
  h.unshift(entry);
  try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(h.slice(0, 100), null, 2)); } catch (e) {}
}

// ---- 配置(cookie) ----
function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch (e) { return {}; }
}
function writeConfig(cfg) {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2)); } catch (e) {}
}

// 搜索（网易云 / QQ音乐 / 酷我）
app.post('/api/search', async (req, res) => {
  try {
    const { query, platform: platformId } = req.body || {};
    if (!query) return res.json({ ok: false, error: '缺少关键词' });
    const platform = platforms.find(p => p.id === platformId) || platforms[0];
    if (!platform.search) return res.json({ ok: false, error: `${platform.name} 不支持关键词搜索` });
    const songs = await platform.search(query);
    const urlFor = (p, s) => {
      if (p === 'netease') return `https://music.163.com/song?id=${s.id}`;
      if (p === 'qqmusic') return `https://y.qq.com/n/ryqq/songDetail/${s.id}`;
      if (p === 'kuwo') return `http://www.kuwo.cn/play_detail/${s.id}`;
      return s.id;
    };
    res.json({
      ok: true,
      songs: songs.slice(0, 20).map(s => ({
        id: s.id,
        name: s.name,
        artists: s.artists,
        url: urlFor(platform.id, s),
      })),
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// 解析歌单（网易云 playlist 链接）
app.post('/api/playlist', async (req, res) => {
  try {
    const { url } = req.body || {};
    const m = String(url || '').match(/playlist[?/]id[=/](\d+)/) || String(url || '').match(/[?&]id=(\d+)/);
    if (!m) return res.json({ ok: false, error: '无法识别歌单链接（需网易云 playlist 链接）' });
    const playlist = await getPlaylist(m[1]);
    res.json({ ok: true, name: playlist.name, songs: playlist.songs });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// 扫码登录：生成二维码
app.post('/api/login/qr', async (req, res) => {
  try {
    const key = await getQrKey();
    if (!key) return res.json({ ok: false, error: '获取二维码失败' });
    const qrimg = await getQrImg(key);
    res.json({ ok: true, key, qrimg });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// 扫码登录：轮询检查状态（800等待/801已扫码/802过期/803成功）
app.get('/api/login/check', async (req, res) => {
  try {
    const { key } = req.query;
    if (!key) return res.json({ ok: false, error: '缺少 key' });
    const r = await checkQrLogin(key);
    if (r.code === 803 && r.cookie) {
      writeConfig({ cookie: r.cookie });
    }
    res.json({ ok: true, code: r.code, cookie: r.cookie });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// 配置：读 cookie 状态
app.get('/api/config', async (req, res) => {
  const cfg = readConfig();
  let nickname = '';
  if (cfg.cookie) {
    const info = await getUserInfo(cfg.cookie);
    nickname = info.nickname;
  }
  res.json({ ok: true, hasCookie: !!cfg.cookie, nickname });
});

// 配置：保存 cookie
app.post('/api/config', (req, res) => {
  const { cookie } = req.body || {};
  writeConfig({ cookie: cookie || '' });
  res.json({ ok: true, hasCookie: !!cookie });
});

// 生成（异步任务）
app.post('/api/generate', (req, res) => {
  const { input, highlight, bilingual, background, upload, cookie, cover, segCount } = req.body || {};
  if (!input) return res.json({ ok: false, error: '缺少输入' });
  const taskId = 't' + (++taskSeq);
  const cfg = readConfig();
  const finalCookie = cookie || cfg.cookie || '';
  tasks.set(taskId, { status: 'pending', result: null, error: null });
  queue.push({
    id: taskId,
    input,
    options: {
      highlight: highlight || undefined,
      bilingual: !!bilingual,
      background: background || '0x1a1a2e',
      upload: !!upload,
      cover: !!cover,
      cookie: finalCookie,
      segCount: Number(segCount) || 8,
    },
  });
  res.json({ ok: true, taskId });
  runNext();
});

// 历史记录
app.get('/api/history', (req, res) => {
  res.json({ ok: true, history: readHistory() });
});

// 清空历史
app.get('/api/history/clear', (req, res) => {
  try { fs.writeFileSync(HISTORY_FILE, '[]'); } catch (e) {}
  res.json({ ok: true });
});

// 查询任务状态
app.get('/api/task/:id', (req, res) => {
  const t = tasks.get(req.params.id);
  if (!t) return res.json({ ok: false, error: '任务不存在' });
  res.json({ ok: true, status: t.status, result: t.result, error: t.error, progress: t.progress });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`vrc-karaoke WebUI 运行在 http://127.0.0.1:${PORT}`);
});
