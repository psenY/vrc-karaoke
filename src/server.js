'use strict';

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const express = require('express');
const { platforms } = require('./platforms');
const { getSongUrl } = require('./core/netease-api');
const { generateVideo } = require('./generate');
const { getPlaylist, getQrKey, getQrImg, checkQrLogin, getUserInfo, getLyric } = require('./core/netease-api');

const ROOT = path.join(__dirname, '..');
const HISTORY_FILE = path.join(ROOT, 'output', 'history.json');
const CONFIG_FILE = path.join(ROOT, 'data', 'config.json');

const crypto = require('crypto');

const tokens = new Map(); // token -> 登录时间戳

const app = express();
app.use(express.json());

// 基础安全响应头（防点击劫持 / MIME 嗅探 / 降低 XSS 影响面）
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

// 访问保护：启用密码且未登录时，/ 返回轻量登录页（避免未登录加载整套应用）
app.get('/', (req, res, next) => {
  const cfg = readConfig();
  if (!cfg.adminPassword) return next();
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/vrc_auth=([^;]+)/);
  const token = m ? m[1] : '';
  if (token && tokens.has(token)) return next();
  return res.sendFile(path.join(ROOT, 'public', 'login.html'));
});
app.get('/login', (req, res) => {
  res.sendFile(path.join(ROOT, 'public', 'login.html'));
});

app.use(express.static(path.join(ROOT, 'public')));
app.use('/output', express.static(path.join(ROOT, 'output')));

const tasks = new Map();
let taskSeq = 0;
const queue = [];
let running = 0;
const MAX_CONCURRENT = 1; // 串行(用户要求一首一首来, 单首内部用分段并行吃多核)

// 失败错误信息友好化：把技术错误映射成可操作的提示
function friendlyError(msg) {
  const m = String(msg || '未知错误');
  if (m.includes('ffmpeg exit')) return '视频合成失败（编码异常），可尝试降低音质、分辨率或分段数后重试';
  if (m.includes('未获取到音频地址')) return '未能获取音频（可能是会员/无版权歌曲，或所选音质无权限）';
  if (m.includes('多次下载仍不完整')) return '音频多次下载不完整（可能是试听片段/会员歌），请检查登录状态';
  if (m.includes('未获取到歌词')) return '未能获取歌词（该歌曲可能没有歌词数据）';
  if (m.includes('未获取到 YouTube 字幕')) return 'YouTube 视频无可用字幕（自动字幕可能未生成）';
  if (m.includes('歌词解析为空')) return '歌词文件为空或格式无法解析';
  if (m.includes('未找到歌词文件')) return '未找到歌词文件（需与音频同目录同名的 .lrc）';
  if (m.includes('ENOTFOUND') || m.includes('ECONNRESET') || m.includes('ETIMEDOUT')) return '网络错误，请稍后重试';
  if (m.includes('封面') && m.includes('下载')) return '封面下载失败（不影响生成，已用纯色背景）';
  return m;
}

// 清理完成的旧任务（限制 tasks Map 大小，避免长期运行内存累积）
function cleanupTasks() {
  while (tasks.size > 100) {
    const oldestKey = tasks.keys().next().value;
    tasks.delete(oldestKey);
  }
}

function runNext() {
  while (running < MAX_CONCURRENT && queue.length > 0) {
    const { id, input, options } = queue.shift();
    const t = tasks.get(id);
    t.status = 'running';
    t.progress = 0;
    running++;
    options.onProgress = (event) => {
      const p = event && typeof event === 'object' ? event : { phase: 'assemble', progress: event };
      if (p.phase === 'download') {
        t.phase = 'download';
        t.downloadProgress = p.progress;
      } else {
        t.phase = 'assemble';
        if (p.segIdx !== undefined) {
          if (!Array.isArray(t.progress)) t.progress = [];
          t.progress[p.segIdx] = p.progress;
        } else {
          t.progress = p.progress;
        }
      }
    };
    options.onSpawn = (proc) => {
      if (!t.procs) t.procs = [];
      t.procs.push(proc);
    };
    generateVideo(input, options)
      .then(result => {
        if (t.status === 'cancelled') return;
        t.status = 'done';
        t.result = result;
        t.title = result.meta.title;
        appendHistory({ input, title: result.meta.title, source: result.meta.source, outPath: result.outPath, url: result.url, time: Date.now() });
      })
      .catch(err => {
        if (t.status === 'cancelled') return;
        t.status = 'failed'; t.error = friendlyError(err.message);
      })
      .finally(() => { running--; cleanupTasks(); runNext(); });
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
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  } catch (e) {}
}

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

// 登录暴力破解防护：每 IP 连续 5 次失败锁定 5 分钟（公网暴露安全）
const loginFails = new Map(); // ip -> { count, lockUntil }
app.post('/api/login', (req, res) => {
  const cfg = readConfig();
  if (!cfg.adminPassword) return res.json({ ok: true, needAuth: false, token: null });
  const ip = req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const rec = loginFails.get(ip);
  if (rec && rec.lockUntil > now) {
    const waitMin = Math.ceil((rec.lockUntil - now) / 60000);
    return res.json({ ok: false, error: `尝试过于频繁，请 ${waitMin} 分钟后再试` });
  }
  const { password } = req.body || {};
  if (sha256(password) === cfg.adminPassword) {
    loginFails.delete(ip);
    const token = crypto.randomBytes(32).toString('hex');
    tokens.set(token, now);
    // 种 cookie，供 GET / 判断已登录（登录后直接进主应用）
    res.setHeader('Set-Cookie', `vrc_auth=${token}; Path=/; Max-Age=86400; HttpOnly; SameSite=Lax`);
    return res.json({ ok: true, needAuth: true, token });
  }
  const count = (rec && rec.count || 0) + 1;
  if (count >= 5) {
    loginFails.set(ip, { count: 0, lockUntil: now + 5 * 60 * 1000 });  // 锁定 5 分钟
    return res.json({ ok: false, error: '密码错误次数过多，已锁定 5 分钟' });
  }
  loginFails.set(ip, { count, lockUntil: 0 });
  res.json({ ok: false, error: '密码错误' });
});

// 查询是否需要登录
app.get('/api/auth-status', (req, res) => {
  res.json({ ok: true, needAuth: !!readConfig().adminPassword });
});

// 鉴权中间件（未启用密码时放行；启用后需 token，token 24 小时过期）
const TOKEN_TTL = 24 * 60 * 60 * 1000;
function requireAuth(req, res, next) {
  const cfg = readConfig();
  if (!cfg.adminPassword) return next();
  const token = req.headers['x-auth-token'] || req.query.token || '';
  const ts = tokens.get(token);
  if (ts && Date.now() - ts < TOKEN_TTL) return next();
  if (ts) tokens.delete(token);  // 清理过期 token，避免内存累积
  return res.status(401).json({ ok: false, error: '未登录或登录已过期', needAuth: true });
}
app.use('/api', requireAuth);

// 设置/修改访问密码（需已登录；改密码需验证原密码；空密码=取消保护）
app.post('/api/set-password', (req, res) => {
  const { password, oldPassword } = req.body || {};
  const cfg = readConfig();
  // 已设置密码时，改密码必须验证原密码
  if (cfg.adminPassword && sha256(oldPassword || '') !== cfg.adminPassword) {
    return res.json({ ok: false, error: '原密码错误' });
  }
  if (password) {
    writeConfig({ ...cfg, adminPassword: sha256(password) });
  } else {
    const { adminPassword, ...rest } = cfg;
    writeConfig(rest);
  }
  res.json({ ok: true });
});

// 搜索（网易云 / QQ音乐 / 酷我）
app.post('/api/search', async (req, res) => {
  try {
    const { query, platform: platformId, offset = 0 } = req.body || {};
    if (!query) return res.json({ ok: false, error: '缺少关键词' });
    const platform = platforms.find(p => p.id === platformId) || platforms[0];
    if (!platform.search) return res.json({ ok: false, error: `${platform.name} 不支持关键词搜索` });
    const songs = await platform.search(query, offset);
    const urlFor = (p, s) => {
      if (p === 'netease') return `https://music.163.com/song?id=${s.id}`;
      if (p === 'qqmusic') return `https://y.qq.com/n/ryqq/songDetail/${s.id}`;
      if (p === 'kuwo') return `http://www.kuwo.cn/play_detail/${s.id}`;
      if (p === 'youtube') return `https://www.youtube.com/watch?v=${s.id}`;
      return s.id;
    };
    res.json({
      ok: true,
      songs: songs.slice(0, 20).map(s => ({
        id: s.id,
        name: s.name,
        artists: s.artists,
        duration: s.duration || 0,
        fee: s.fee,
        url: urlFor(platform.id, s),
      })),
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// 网易云试听（30s 预览确认选歌）
app.post('/api/trial', async (req, res) => {
  try {
    const { input, cookie } = req.body || {};
    const m = String(input || '').match(/[?&]id=(\d+)/);
    if (!m) return res.json({ ok: false, error: '无法识别歌曲链接' });
    const cfg = readConfig();
    const { url } = await getSongUrl(Number(m[1]), cookie || cfg.cookie || '', 'standard');
    if (!url) return res.json({ ok: false, error: '试听不可用（可能无版权）' });
    res.json({ ok: true, url });
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

// 歌词预览（生成前确认歌词）
app.post('/api/lyric', async (req, res) => {
  try {
    const { input } = req.body || {};
    const m = String(input || '').match(/[?&]id=(\d+)/);
    if (!m) return res.json({ ok: false, error: '无法识别歌曲链接' });
    const { lrc, tlyric } = await getLyric(Number(m[1]));
    res.json({ ok: true, lrc: lrc || '', tlyric: tlyric || '' });
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

// 配置：读 cookie 状态 + 账户详情
app.get('/api/config', async (req, res) => {
  const cfg = readConfig();
  let info = {};
  if (cfg.cookie) {
    info = await getUserInfo(cfg.cookie);
  }
  res.json({ ok: true, hasCookie: !!cfg.cookie, nickname: info.nickname || '', avatarUrl: info.avatarUrl || '', vipType: info.vipType || 0, level: info.level || 0 });
});

// 配置：保存 cookie
app.post('/api/config', (req, res) => {
  const { cookie } = req.body || {};
  writeConfig({ cookie: cookie || '' });
  res.json({ ok: true, hasCookie: !!cookie });
});

// 生成（异步任务）
app.post('/api/generate', (req, res) => {
  const { input, highlight, bilingual, background, backgroundBottom, upload, cookie, cover, coverMask, coverMaskLevel, segCount, resolution, codec, preset, crf, fps, audioBitrate, currentColor, nextColor, titleColor, progressColor, introText, audioLevel, flacAudio, subtitleLang } = req.body || {};
  if (!input) return res.json({ ok: false, error: '缺少输入' });
  const taskId = 't' + (++taskSeq);
  const cfg = readConfig();
  const finalCookie = cookie || cfg.cookie || '';
  tasks.set(taskId, { id: taskId, status: 'pending', result: null, error: null, phase: 'download', downloadProgress: 0, procs: [], title: input });
  queue.push({
    id: taskId,
    input,
    options: {
      highlight: highlight || undefined,
      bilingual: !!bilingual,
      background: background || '0x1a1a2e',
      backgroundBottom: backgroundBottom || '',
      upload: !!upload,
      cover: !!cover,
      coverMask: coverMask !== false,
      coverMaskLevel: Math.min(90, Number(coverMaskLevel) || 30),
      cookie: finalCookie,
      segCount: Number(segCount) || 8,
      resolution: resolution || '1080p',
      codec: codec || 'libx264',
      preset: preset || 'veryfast',
      crf: Number(crf) || 23,
      fps: Number(fps) || 24,
      audioBitrate: audioBitrate || 'auto',
      currentColor: currentColor || '#FFFFFF',
      nextColor: nextColor || '#969696',
      titleColor: titleColor || '#FFFFFF',
      progressColor: progressColor || '#FFFFFF',
      introText: introText || '',
      audioLevel: audioLevel || 'higher',
      flacAudio: !!flacAudio,
      subtitleLang: subtitleLang || 'auto',
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

// 删除单条历史（同时删除输出文件）
app.post('/api/history/delete', (req, res) => {
  const { filename } = req.body || {};
  if (!filename) return res.json({ ok: false, error: '缺少文件名' });
  const h = readHistory();
  const newH = h.filter(item => item.outPath.split('/').pop() !== filename);
  try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(newH, null, 2)); } catch (e) {}
  const filePath = path.join(ROOT, 'output', filename);
  try { fs.unlinkSync(filePath); } catch (e) {}
  res.json({ ok: true });
});

// 计算目录文件总大小
function dirSize(dir) {
  let total = 0;
  let count = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      try {
        const st = fs.statSync(path.join(dir, f));
        if (st.isFile()) { total += st.size; count++; }
      } catch (e) {}
    }
  } catch (e) {}
  return { total, count };
}

// 本地文件上传（浏览器直传 mp3 + 可选同名 .lrc，生成用）——存 tmp/uploads/
const multer = require('multer');
const uploadDir = path.join(ROOT, 'tmp', 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, cb) => {
      const safe = Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '-' + (file.originalname || '').replace(/[^\w.\-]/g, '_');
      cb(null, safe);
    },
  }),
  limits: { fileSize: 200 * 1024 * 1024 },  // 200MB 上限（无损音频够用）
});
// 上传：字段 audio（音频）+ 可选 lrc（歌词），返回服务端路径
// 顺带清理 24h 前的旧上传文件（上传是一次性的，用完即弃，防目录膨胀）
app.post('/api/upload', upload.fields([{ name: 'audio', maxCount: 1 }, { name: 'lrc', maxCount: 1 }]), (req, res) => {
  try {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const f of fs.readdirSync(uploadDir)) {
      try {
        const st = fs.statSync(path.join(uploadDir, f));
        if (st.isFile() && st.mtimeMs < cutoff) fs.unlinkSync(path.join(uploadDir, f));
      } catch (e) {}
    }
  } catch (e) {}
  const files = req.files || {};
  const audio = files.audio && files.audio[0];
  if (!audio) return res.json({ ok: false, error: '缺少音频文件' });
  const audioPath = path.join(uploadDir, audio.filename);
  const audioBase = audio.filename.replace(/\.[^.]+$/, '');
  // 歌词：上传了 lrc 则用（统一 base 名，让本地平台的"同名 .lrc"规则能找到）
  let lrcPath = null;
  if (files.lrc && files.lrc[0]) {
    lrcPath = path.join(uploadDir, files.lrc[0].filename);
    if (files.lrc[0].filename.replace(/\.[^.]+$/, '') !== audioBase) {
      const newLrc = path.join(uploadDir, audioBase + '.lrc');
      fs.renameSync(lrcPath, newLrc);
      lrcPath = newLrc;
    }
  } else {
    const lrcCand = path.join(uploadDir, audioBase + '.lrc');
    if (fs.existsSync(lrcCand)) lrcPath = lrcCand;
  }
  res.json({ ok: true, path: audioPath, lrcPath });
});

// 磁盘占用（output 成品 + tmp 缓存）
app.get('/api/stats', (req, res) => {
  const out = dirSize(path.join(ROOT, 'output'));
  const tmp = dirSize(path.join(ROOT, 'tmp'));
  // 磁盘剩余空间（df 解析，字节）
  let diskFree = 0;
  try {
    const dfOut = execFileSync('df', ['-k', path.join(ROOT, 'output')], { encoding: 'utf8' });
    const line = dfOut.trim().split('\n').pop();
    const parts = line.split(/\s+/);
    diskFree = (parseInt(parts[3], 10) || 0) * 1024;  // 可用 KB → 字节
  } catch (e) {}
  res.json({ ok: true, outputSize: out.total, outputCount: out.count, tmpSize: tmp.total, tmpCount: tmp.count, diskFree });
});

// 清理 tmp 缓存（释放磁盘，下次生成重新下载）
app.post('/api/cache/clean', (req, res) => {
  const tmpDir = path.join(ROOT, 'tmp');
  let removed = 0;
  let freed = 0;
  try {
    for (const f of fs.readdirSync(tmpDir)) {
      const p = path.join(tmpDir, f);
      try {
        const st = fs.statSync(p);
        if (st.isFile()) { freed += st.size; fs.unlinkSync(p); removed++; }
      } catch (e) {}
    }
  } catch (e) {}
  res.json({ ok: true, removed, freed });
});

// 清理孤儿文件（output 目录里历史记录没有的 mp4）
app.post('/api/output/clean', (req, res) => {
  const outputDir = path.join(ROOT, 'output');
  const h = readHistory();
  const known = new Set(h.map(item => item.outPath.split('/').pop()));
  // 跳过最近 30 分钟内生成的文件（可能是正在生成的任务输出，避免误删导致生成报错）
  const recentMs = 30 * 60 * 1000;
  const now = Date.now();
  let removed = 0;
  try {
    for (const f of fs.readdirSync(outputDir)) {
      if (!f.endsWith('.mp4') || known.has(f)) continue;
      try {
        const st = fs.statSync(path.join(outputDir, f));
        if (now - st.mtimeMs < recentMs) continue;
        fs.unlinkSync(path.join(outputDir, f));
        removed++;
      } catch (e) {}
    }
  } catch (e) {}
  res.json({ ok: true, removed });
});

// 查询任务状态
app.get('/api/task/:id', (req, res) => {
  const t = tasks.get(req.params.id);
  if (!t) return res.json({ ok: false, error: '任务不存在' });
  res.json({ ok: true, status: t.status, title: t.title, result: t.result, error: t.error, progress: t.progress, phase: t.phase, downloadProgress: t.downloadProgress });
});

// 队列状态（运行中 + 排队中）
app.get('/api/queue', (req, res) => {
  const runningList = [...tasks.values()].filter(t => t.status === 'running').map(t => ({
    id: t.id, title: t.title, status: t.status,
    phase: t.phase, downloadProgress: t.downloadProgress, progress: t.progress,
  }));
  const pendingList = queue.map(q => ({ id: q.id, title: tasks.get(q.id)?.title || q.input, status: 'pending' }));
  res.json({ ok: true, running: runningList, pending: pendingList });
});

// 取消任务（pending 移出队列 / running 中断 ffmpeg）
app.post('/api/task/:id/cancel', (req, res) => {
  const t = tasks.get(req.params.id);
  if (!t) return res.json({ ok: false, error: '任务不存在' });
  if (t.status === 'pending') {
    const idx = queue.findIndex(q => q.id === t.id);
    if (idx >= 0) queue.splice(idx, 1);
    t.status = 'cancelled';
  } else if (t.status === 'running') {
    (t.procs || []).forEach(p => { try { p.kill('SIGKILL'); } catch (e) {} });
    t.status = 'cancelled';
  }
  res.json({ ok: true });
});

// 插队（pending 任务移到队首）
app.post('/api/task/:id/top', (req, res) => {
  const t = tasks.get(req.params.id);
  if (!t || t.status !== 'pending') return res.json({ ok: false, error: '仅排队中的任务可插队' });
  const idx = queue.findIndex(q => q.id === t.id);
  if (idx > 0) {
    const [item] = queue.splice(idx, 1);
    queue.unshift(item);
  }
  res.json({ ok: true });
});

// 全局错误处理（兜底，避免未捕获异常导致进程崩溃）
app.use((err, req, res, next) => {
  console.error('[错误]', err.message || err);
  if (res.headersSent) return next(err);
  res.status(500).json({ ok: false, error: '服务器内部错误' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`vrc-karaoke WebUI 运行在 http://127.0.0.1:${PORT}`);
});

// 进程级异常处理（常驻服务兜底，避免未处理异常导致进程崩溃）
process.on('unhandledRejection', (reason) => {
  console.error('[错误] 未处理的 Promise 拒绝:', reason?.message || reason);
});
process.on('uncaughtException', (err) => {
  console.error('[错误] 未捕获异常:', err.message || err);
});

// 优雅关闭（docker stop 时收到 SIGTERM）
process.on('SIGTERM', () => {
  console.log('[提示] 收到 SIGTERM，正在关闭...');
  process.exit(0);
});
