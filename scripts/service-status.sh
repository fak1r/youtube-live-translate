#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="youtube-live-translate"

systemctl --no-pager --full status "$SERVICE_NAME"
