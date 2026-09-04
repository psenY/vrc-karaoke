#!/bin/bash
# vrc-karaoke 一键部署脚本（在 iStoreOS 路由器上执行）
# 依赖: docker + docker compose
set -e
cd "$(dirname "$0")"

echo "=== [1/3] 构建 Docker 镜像 ==="
docker compose build

echo "=== [2/3] 启动容器 ==="
docker compose up -d

echo "=== [3/3] 验证 ==="
sleep 5
if curl -s --max-time 5 http://127.0.0.1:3000/api/history >/dev/null 2>&1; then
  echo "✅ 部署成功，WebUI 访问: http://192.168.100.1:3000"
else
  echo "⚠️ 服务未响应，查看日志: docker compose logs -f"
fi
