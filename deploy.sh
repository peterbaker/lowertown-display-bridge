#!/usr/bin/env bash
# Deploy latest changes to the Pi: git pull + restart the service.
set -euo pipefail

PI="lowertown-pi"
REMOTE_DIR="~/display-bridge"

ssh "$PI" "
  set -e
  echo '→ Pulling latest...'
  cd $REMOTE_DIR && git pull

  echo '→ Restarting display-bridge...'
  sudo systemctl restart display-bridge

  echo '→ Status:'
  systemctl is-active display-bridge rclone-sync.timer tailscaled
"
