#!/bin/bash
# ============================================================
# acme-panel 一键安装脚本（宝塔面板环境）
# 用法: sudo bash install.sh
# 可选环境变量: PORT（默认 16789）
# ============================================================
set -e

APP_DIR="${APP_DIR:-/opt/acme-panel}"
PORT="${PORT:-16789}"
SERVICE_NAME="acme-panel"

# 彩色输出
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[✗]${NC} $1"; exit 1; }

echo ""
echo "=============================================="
echo "  🔐 acme-panel 安装脚本"
echo "=============================================="
echo ""

# 1. 检查 root
[ "$(id -u)" = "0" ] || error "请使用 root 运行: sudo bash install.sh"

# 2. 检查依赖
command -v node >/dev/null 2>&1 || error "未检测到 Node.js，请先在宝塔「软件商店」安装 Node 版本管理器"
command -v npm  >/dev/null 2>&1 || error "未检测到 npm"
command -v openssl >/dev/null 2>&1 || error "未检测到 openssl"
command -v nginx >/dev/null 2>&1 || warn "未检测到 nginx（宝塔环境会自动安装，若已装可忽略）"

# 3. 部署文件（脚本需在项目根目录运行）
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ ! -f "$SCRIPT_DIR/server.js" ]; then
  error "未找到 server.js，请在项目根目录运行本脚本"
fi

echo "📁 部署文件到 $APP_DIR"
mkdir -p "$APP_DIR/src" "$APP_DIR/public"
cp -f "$SCRIPT_DIR/server.js" "$SCRIPT_DIR/package.json" "$SCRIPT_DIR/package-lock.json" "$APP_DIR/" 2>/dev/null || cp -f "$SCRIPT_DIR/server.js" "$SCRIPT_DIR/package.json" "$APP_DIR/"
cp -f "$SCRIPT_DIR/src"/*.js "$APP_DIR/src/"
cp -f "$SCRIPT_DIR/public"/* "$APP_DIR/public/"

# 4. 安装依赖
echo "📦 安装 npm 依赖..."
cd "$APP_DIR"
npm install --omit=dev --no-audit --no-fund
info "依赖安装完成"

# 5. 安装 acme.sh（若不存在）
if [ ! -f "$HOME/.acme.sh/acme.sh" ]; then
  echo "🌐 安装 acme.sh..."
  curl https://get.acme.sh | sh || warn "acme.sh 自动安装失败，面板首次申请证书时会重试"
else
  info "acme.sh 已存在"
fi

# 6. 创建 systemd 服务
echo "🛠  创建 systemd 服务 $SERVICE_NAME"
NODE_BIN="$(command -v node)"
cat > /etc/systemd/system/${SERVICE_NAME}.service <<EOF
[Unit]
Description=SSL 证书自动管理面板（宝塔环境）
After=network.target nginx.service

[Service]
Type=simple
User=root
WorkingDirectory=${APP_DIR}
ExecStart=${NODE_BIN} server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=PORT=${PORT}
StandardOutput=append:/var/log/acme-panel.log
StandardError=append:/var/log/acme-panel.log

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable ${SERVICE_NAME} >/dev/null 2>&1
systemctl restart ${SERVICE_NAME}
sleep 2

# 7. 健康检查
if systemctl is-active --quiet ${SERVICE_NAME}; then
  info "服务运行正常"
else
  error "服务启动失败，请查看: journalctl -u ${SERVICE_NAME} -n 50"
fi

echo ""
echo "=============================================="
echo "  ✅ 安装完成！"
echo ""
echo "  面板地址 : http://<服务器IP>:${PORT}"
echo "  服务状态 : systemctl status ${SERVICE_NAME}"
echo "  查看日志 : journalctl -u ${SERVICE_NAME} -f"
echo ""
echo "  安全提示 : 面板默认无鉴权，请勿直接暴露公网！"
echo "             建议用防火墙限制来源 IP，或使用宝塔反向代理 + 面板登录"
echo "=============================================="
