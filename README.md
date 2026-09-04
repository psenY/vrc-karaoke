# vrc-karaoke

VRChat 卡拉OK歌词视频生成器 —— 自动生成带「下一句预览」的唱歌视频。

解决 VRChat KTV 房曲库视频「看不到下一句歌词、要背歌词」的痛点:当前句高亮 + 下一句提前显示,歌者不用背歌词。

## 特性

- **下一句预览 + AB切换**:两个固定槽位原地交替,歌词不做上下滚动/瞬跳
- **逐字高亮**:YouTube 真词级时间戳(精确) / 网易云估算逐字
- **双语歌词**:网易云 tlyric 翻译,原文下方小字显示翻译
- **模块化平台插件**:加新音乐平台只需写一个文件实现接口
- **时长验证**:下载后 ffprobe 对比时长,试听片段自动重试并提示配 cookie

## 架构

```
src/
├── core/              # 通用模块(平台无关)
│   ├── ass.js         #   ASS 字幕生成(AB切换 + 逐字 + 双语)
│   ├── ffmpeg.js      #   ffmpeg 合成
│   ├── lyrics.js      #   LRC 解析
│   └── netease-api.js #   网易云 API 封装
├── platforms/         # 平台插件(实现统一接口)
│   ├── index.js       #   注册表 + 平台自动识别
│   ├── netease.js     #   网易云
│   ├── youtube.js     #   YouTube
│   └── qqmusic.js     #   QQ音乐
└── index.js           # CLI 入口(只调平台接口)
```

## 使用

```bash
# 网易云:关键词搜索
node src/index.js --keywords "打上花火"

# 网易云:链接 / 歌曲ID
node src/index.js --id 496869422

# YouTube(默认真逐字)
node src/index.js --url "https://www.youtube.com/watch?v=..."

# QQ音乐(链接)
node src/index.js --url "https://y.qq.com/n/ryqq/songDetail/<songmid>"

# 双语歌词(外文歌显示中文翻译)
node src/index.js --id 496869422 --bilingual

# 其他参数
--highlight line|word   高亮方式(网易云默认 line,YouTube 默认 word)
--background 0x1a1a2e   背景色
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
# 构建 + 启动
docker compose up -d --build

# 访问 WebUI
# http://192.168.100.1:3000
```

镜像内含:Node 22 + ffmpeg(libass) + Noto Sans CJK 字体 + yt-dlp + curl。

关键点:
- **代理**:YouTube/catbox 需翻墙,compose 里已配 `YTDLP_PROXY`/`CATBOX_PROXY` 指向本机 mihomo(`192.168.100.1:7890`)
- **字体**:构建时从系统复制 Noto Sans CJK 到 `fonts/`
- **输出**:`output/` 挂载到宿主机,成品 mp4 和直链都在这里

本地运行(非 Docker):
1. **字体**:复制 Noto Sans CJK(`NotoSansCJK-Regular.ttc` / `-Bold.ttc`)到 `fonts/`
2. **依赖**:装 ffmpeg(含 libass) + yt-dlp
3. `node src/server.js`

## 输出

- MP4(H.264+AAC,1080p30),纯色背景码率极低,一首 4 分钟歌约 8MB
- 下一步计划:catbox 直链托管、QQ音乐等更多平台、WebUI
