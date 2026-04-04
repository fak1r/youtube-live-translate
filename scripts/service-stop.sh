#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="youtube-live-translate"

echo "[youtube-live-translate] stopping service"
sudo systemctl stop "$SERVICE_NAME"

echo "[youtube-live-translate] current status"
systemctl --no-pager --full status "$SERVICE_NAME" || true
