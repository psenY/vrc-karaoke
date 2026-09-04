'use strict';

const path = require('path');
const express = require('express');
const { platforms } = require('./platforms');
const { generateVideo } = require('./generate');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/output', express.static(path.join(__dirname, '..', 'output')));

const tasks = new Map();
let taskSeq = 0;

// 搜索（网易云 / QQ音乐）
app.post('/api/search', async (req, res) => {
  try {
    const { query, platform: platformId } = req.body || {};
    if (!query) return res.json({ ok: false, error: '缺少关键词' });
    const platform = platforms.find(p => p.id === platformId) || platforms[0];
    if (!platform.search) return res.json({ ok: false, error: `${platform.name} 不支持关键词搜索` });
    const songs = await platform.search(query);
    res.json({
      ok: true,
      songs: songs.slice(0, 20).map(s => ({
        id: s.id,
        name: s.name,
        artists: s.artists,
        url: platform.id === 'netease'
          ? `https://music.163.com/song?id=${s.id}`
          : `https://y.qq.com/n/ryqq/songDetail/${s.id}`,
      })),
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// 生成（异步任务）
app.post('/api/generate', (req, res) => {
  const { input, highlight, bilingual, background, upload, cookie, cover } = req.body || {};
  if (!input) return res.json({ ok: false, error: '缺少输入' });
  const taskId = 't' + (++taskSeq);
  tasks.set(taskId, { status: 'running', result: null, error: null });
  res.json({ ok: true, taskId });

  generateVideo(input, {
    highlight: highlight || undefined,
    bilingual: !!bilingual,
    background: background || '0x1a1a2e',
    upload: !!upload,
    cover: !!cover,
    cookie: cookie || '',
  })
    .then(result => tasks.set(taskId, { status: 'done', result }))
    .catch(err => tasks.set(taskId, { status: 'failed', error: err.message }));
});

// 查询任务状态
app.get('/api/task/:id', (req, res) => {
  const t = tasks.get(req.params.id);
  if (!t) return res.json({ ok: false, error: '任务不存在' });
  res.json({ ok: true, status: t.status, result: t.result, error: t.error });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`vrc-karaoke WebUI 运行在 http://127.0.0.1:${PORT}`);
});
