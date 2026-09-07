# vrc-karaoke

VRChat 卡拉OK歌词视频生成器 —— 自动生成带「下一句预览」的唱歌视频。

解决 VRChat KTV 房曲库视频「看不到下一句歌词、要背歌词」的痛点:当前句高亮 + 下一句提前显示,歌者不用背歌词。

## 特性

**核心差异化**

- **下一句预览 + AB切换**:两个固定槽位原地交替,歌词不做上下滚动/瞬跳
- **逐字高亮**:YouTube 真词级时间戳(精确) / 网易云估算逐字
- **双语歌词**:网易云 tlyric 翻译,原文下方小字显示翻译
- **模块化平台插件**:加新音乐平台只需写一个文件实现接口
- **时长验证**:下载后 ffprobe 对比时长,试听片段自动重试并提示配 cookie

**性能**

- **分段并行编码**:单首歌切 8 段并行编码 + 无损合并,合成提速约 4.4 倍(4分钟→30秒)
- **音频单独编码**:音频不分段、一次性编码,避免拼接处停顿(AAC priming)
- **下载缓存**:同一首歌复用已下载音频,跳过重复下载
- **下载/DNS 自动重试**:网络错误自动重试 3 次

**歌词显示质量保障**

- **音画同步**:音频单次编码不分段(规避 AAC priming 间隙);视频分段合并用 filter concat + setpts 强制帧时间戳均匀(实测 6176 帧 0 异常,规避 concat demuxer 段边界 PTS 跳变导致的歌词越来越慢)
- **LRC 空行 = 上一句结束时间**:当前句唱完即隐藏,下一句提前预览,句间不空窗
- **长句适配**:优先缩字号保证单行(下限 fs90),超长才断两行;宽度估算按 libass+Noto CJK 渲染实测校准(全角 0.72em)
- **YouTube 滚动字幕处理**:event 时间重叠裁剪(下一句开始时上一句强制消失,防三行同屏);segs 内嵌换行清洗(防 Dialogue 被拆行);字幕 auto 模式原语言优先(防自动翻译字幕抢先)
- **元信息行不放大**:作词/作曲等 LRC 元信息段保持标准字号,避免开场字号闪跳

**WebUI(Vue 3 + Element Plus)**

- 黑白主题(浅色/深色/跟随系统)
- 5 平台搜索(网易云/QQ音乐/酷我/YouTube)+ 直接粘贴链接生成 + 搜索试听确认版本
- 网易云扫码登录(自动获取 cookie)+ 登录状态/账户信息(昵称/黑胶等级)+ 退出/刷新
- 歌单批量生成(勾选/全选/去重/排序/单项移除/跳过已生成/失败一键重试/复制全部直链)
- 本地文件 Web 上传生成(mp3 + 可选同名 lrc,浏览器直传)
- 任务队列管理(取消 / 插队 / 暂停恢复 / 全部取消)+ 实时进度(下载/分段/耗时/预计剩余)
- 历史记录(搜索 / 平台筛选 / 重做 / 批量删除 / 在线预览 / 复制直链)+ 磁盘占用与剩余空间预警
- 生成失败友好提示 + 错误详情(原始技术信息) + 浏览器完成通知
- 账号权限系统(可选访问密码 + token 鉴权,登录暴力破解防护) + 独立登录页
- 歌词预览(选歌后确认,双语显示) + 参数预设(保存/加载) + 恢复默认
- 移动端响应式(双端操作一致)
- 前端依赖本地化(无外部 CDN,国内加载快)

**可调参数**

高亮方式、双语、封面背景(模糊+遮罩强度)、背景色/渐变、并行分段数(1-16)、分辨率(1080p/720p/480p)、编码器(H.264/H.265)、编码预设、质量 CRF、帧率(15-60)、音频码率(自动跟随音源)、音质(网易云 9 档:标准→超清母带)、无损封装(FLAC)、片头信息卡(生成方/开发者/歌曲/音质/参数,3 秒)、YouTube 字幕语言、歌词当前句/下一句/标题/进度颜色。

## B站自动投稿

生成完成后可自动投稿到 B 站（也可在历史记录中手动补传）：

1. **扫码登录**：WebUI「B站投稿」卡 → 扫码登录（cookie 持久化）
2. **自动投稿**：高级设置勾选「生成完成自动投稿到B站」（或用历史记录的「投稿B站」按钮手动补传）
3. **投稿模板**：标题/简介/标签/分区全部可编辑，支持模板变量 `{歌名}` `{音质}` `{比特率}` `{分辨率}` `{日期}`
4. **自动加入合集**：选择创作中心的合集，投稿自动归档
5. **查重开关**：关闭 / 上传前查重 / 生成前查重（按历史投稿记录检测同歌，命中跳过，批量场景省编码时间）
6. **上传队列**：实时分片进度、阶段（准备→上传→合并→提交）、最近 50 条记录（含失败原因）
7. **健壮性**：投稿失败自动重试 3 次（指数退避）；投稿失败不影响视频生成本身

## 架构

```
src/
├── core/              # 通用模块(平台无关)
│   ├── ass.js         #   ASS 字幕生成(AB切换 + 逐字 + 双语 + 颜色)
│   ├── ffmpeg.js      #   ffmpeg 合成(分段并行 + 音频单独编码)
│   ├── lyrics.js      #   LRC 解析
│   ├── netease-api.js #   网易云 API 封装(搜索/歌词/音频/扫码登录)
│   └── catbox.js      #   直链托管(已停用,保留备用)
├── platforms/         # 平台插件(实现统一接口)
│   ├── index.js       #   注册表 + 平台自动识别
│   ├── netease.js     #   网易云
│   ├── youtube.js     #   YouTube
│   ├── qqmusic.js     #   QQ音乐
│   ├── kuwo.js        #   酷我音乐
│   └── local.js       #   本地文件
├── generate.js        # 核心生成流程(CLI/Web 共用)
├── server.js          # Express WebUI(队列/鉴权/登录)
├── index.js           # CLI 入口
└── public/            # 前端(Vue3 + Element Plus)
```

## 使用

### WebUI(推荐)

```bash
node src/server.js
# 浏览器打开 http://127.0.0.1:3000
```

### CLI

```bash
# 网易云:关键词搜索
node src/index.js --keywords "打上花火"

# 网易云:链接 / 歌曲ID
node src/index.js --id 496869422

# YouTube(默认真逐字)
node src/index.js --url "https://www.youtube.com/watch?v=..."

# QQ音乐(链接)
node src/index.js --url "https://y.qq.com/n/ryqq/songDetail/<songmid>"

# 酷我音乐(链接)
node src/index.js --url "http://www.kuwo.cn/play_detail/<musicid>"

# 本地文件(mp3 + 同目录同名 .lrc)
node src/index.js --url "/path/to/song.mp3"

# 双语歌词(外文歌显示中文翻译)
node src/index.js --id 496869422 --bilingual

# 主要参数
--highlight line|word   高亮方式(网易云默认 line,YouTube 默认 word)
--background 0x1a1a2e   背景色
--cover                 封面背景
--seg-count 8           分段并行数(线程数)
--cookie "..."          网易云 cookie(拿高音质 / 会员完整歌曲)
--out 名.mp4            输出文件名
```

## 平台接口

新平台只需实现统一接口,放到 `src/platforms/` 并在 `index.js` 注册:

```js
module.exports = {
  id: 'qqmusic',
  name: 'QQ音乐',
  matches(input) { return /y.qq.com/.test(input); },
  async fetch(input, opts) {
    // 返回统一结构
    return {
      meta: { id, title, source: 'qqmusic' },
      lines: [{ startMs, text, translation?, words? }], // 逐句(可含逐字/翻译)
      audioPath,
      audioMs,
    };
  },
};
```

## 依赖

- Node.js ≥ 18
- ffmpeg(含 libass)
- Noto Sans CJK 字体(放 `fonts/` 目录,SC/TC/JP/KR 全覆盖)
- yt-dlp(仅 YouTube 平台,需 node 作 JS runtime)

## 部署(iStoreOS 路由器, Docker)

```bash
# 一键部署
chmod +x deploy.sh && ./deploy.sh

# 或手动
docker compose up -d --build

# 访问 WebUI
# http://192.168.100.1:3000
```

镜像内含:Node 22 + ffmpeg(libass) + Noto Sans CJK 字体 + yt-dlp + curl。

关键点:
- **代理**:YouTube 需翻墙,compose 里已配 `YTDLP_PROXY` 指向本机 mihomo(`192.168.100.1:7890`)
- **字体**:构建时从系统复制 Noto Sans CJK 到 `fonts/`
- **输出**:`output/` 挂载到宿主机,成品 mp4 在这里
- **Docker 镜像源**:已从失效的 163 换成 `docker.m.daocloud.io`(`/etc/config/dockerd`)

本地运行(非 Docker):
1. **字体**:复制 Noto Sans CJK(`NotoSansCJK-Regular.ttc` / `-Bold.ttc`)到 `fonts/`
2. **依赖**:装 ffmpeg(含 libass) + yt-dlp
3. `node src/server.js`

## 输出

- MP4(H.264+AAC,默认 1080p/24fps,可调),纯色背景码率极低,一首 4 分钟歌约 8-10MB
- 分段并行编码,单首合成约 30 秒(8 段并行,D1581 16 核)
