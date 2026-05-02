#!/usr/bin/env bash
# Deploy latest changes to the Pi: git pull + restart the service.
set -euo pipefail

PI="lowertown-pi"
REMOTE_DIR="~/display-bridge"

ssh "$PI" "
  set -e
  echo '→ Pulling latest...'
  cd $REMOTE_DIR && git pull

  for unit in display-bridge.service rclone-sync.service rclone-sync.timer; do
    if ! sudo diff -q setup/\$unit /etc/systemd/system/\$unit >/dev/null 2>&1; then
      echo \"→ Updating systemd unit: \$unit\"
      sudo cp setup/\$unit /etc/systemd/system/
      reload=1
    fi
  done
  if [ -n \"\${reload:-}\" ]; then
    sudo systemctl daemon-reload
    sudo systemctl restart rclone-sync.timer
  fi

  echo '→ Restarting display-bridge...'
  sudo systemctl restart display-bridge

  echo '→ Status:'
  systemctl is-active display-bridge rclone-sync.timer tailscaled
"
