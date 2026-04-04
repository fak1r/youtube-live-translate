#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_SRC="$REPO_DIR/systemd/youtube-live-translate.service"
UNIT_DST="/etc/systemd/system/youtube-live-translate.service"
SERVICE_NAME="youtube-live-translate"

echo "[youtube-live-translate] installing systemd unit"
sudo cp "$UNIT_SRC" "$UNIT_DST"
sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME" >/dev/null

echo "[youtube-live-translate] unit installed"
systemctl cat "$SERVICE_NAME"
