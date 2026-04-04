#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_SRC="$REPO_DIR/systemd/youtube-live-translate.service"
UNIT_DST="/etc/systemd/system/youtube-live-translate.service"
SERVICE_NAME="youtube-live-translate"

cd "$REPO_DIR"

echo "[youtube-live-translate] building project"
npm run build

echo "[youtube-live-translate] installing systemd unit"
sudo cp "$UNIT_SRC" "$UNIT_DST"
sudo systemctl daemon-reload

echo "[youtube-live-translate] enabling service"
sudo systemctl enable "$SERVICE_NAME" >/dev/null

echo "[youtube-live-translate] restarting service"
sudo systemctl restart "$SERVICE_NAME"

echo "[youtube-live-translate] current status"
systemctl --no-pager --full status "$SERVICE_NAME"
