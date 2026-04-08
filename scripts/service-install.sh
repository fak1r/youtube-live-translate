#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_DST="/etc/systemd/system/youtube-live-translate.service"
SERVICE_NAME="youtube-live-translate"
SERVICE_USER="${SUDO_USER:-$USER}"
NODE_BINARY="$(node -p 'process.execPath')"
ENV_FILE="$REPO_DIR/.env"

echo "[youtube-live-translate] installing systemd unit"
sudo tee "$UNIT_DST" >/dev/null <<EOF
[Unit]
Description=Local YouTube Live Translate Service
After=network.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$REPO_DIR
EnvironmentFile=-$ENV_FILE
ExecStart=$NODE_BINARY $REPO_DIR/dist/server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME" >/dev/null

echo "[youtube-live-translate] unit installed"
systemctl cat "$SERVICE_NAME"
