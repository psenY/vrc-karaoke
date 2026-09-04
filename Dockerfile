FROM node:22-bookworm-slim

# 依赖: ffmpeg(含 libass) + curl(catbox 上传) + CJK 字体 + python3(yt-dlp 运行)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg curl fonts-noto-cjk python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# yt-dlp(YouTube 平台)
RUN curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod +x /usr/local/bin/yt-dlp

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY src/ ./src/
COPY public/ ./public/

# 字体: 从系统复制 Noto Sans CJK 到项目 fonts/(libass 烧字幕用)
RUN mkdir -p fonts \
    && cp /usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc fonts/ 2>/dev/null || true \
    && cp /usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc fonts/ 2>/dev/null || true

RUN mkdir -p output tmp

EXPOSE 3000

CMD ["node", "src/server.js"]
