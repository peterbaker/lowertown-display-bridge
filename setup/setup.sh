#!/usr/bin/env bash
# setup.sh — Lowertown Display Bridge — Pi bootstrap
#
# Run once (or re-run safely) after flashing Raspberry Pi OS Lite.
# Idempotent: safe to run multiple times.
#
# Usage (on the Pi, after cloning the repo):
#   bash /home/pi/display-bridge/setup/setup.sh

set -euo pipefail

REPO_DIR=/home/pi/display-bridge
DROP_DIR=/home/pi/display-drop
GDRIVE_KEY=$REPO_DIR/gdrive-key.json

log() { echo "[setup] $*"; }

# ── Root check ────────────────────────────────────────────────────────────────
if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo bash $0"
  exit 1
fi

# ── 1. System update ──────────────────────────────────────────────────────────
log "Updating system packages..."
apt-get update -y
apt-get full-upgrade -y
apt-get autoremove -y

# ── 2. Timezone ───────────────────────────────────────────────────────────────
log "Setting timezone to America/Detroit..."
timedatectl set-timezone America/Detroit

# ── 3. Node.js 20 LTS ────────────────────────────────────────────────────────
if ! command -v node &>/dev/null || [[ "$(node --version | cut -d. -f1)" != "v20" ]]; then
  log "Installing Node.js 20 LTS..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
else
  log "Node.js $(node --version) already installed — skipping"
fi

# ── 4. Python 3 + pip ────────────────────────────────────────────────────────
log "Ensuring Python 3 and pip are installed..."
apt-get install -y python3 python3-pip

# ── 5. python-samsung-mdc ────────────────────────────────────────────────────
log "Installing python-samsung-mdc..."
pip3 install --break-system-packages python-samsung-mdc 2>/dev/null \
  || pip3 install python-samsung-mdc

# ── 6. samsung-emdx ──────────────────────────────────────────────────────────
if ! command -v samsung-emdx &>/dev/null; then
  log "Installing @weejewel/samsung-emdx..."
  npm install -g @weejewel/samsung-emdx
else
  log "samsung-emdx already installed — skipping"
fi

# ── 7. rclone ────────────────────────────────────────────────────────────────
if ! command -v rclone &>/dev/null; then
  log "Installing rclone..."
  apt-get install -y rclone
  # If apt version is stale, prefer the official installer:
  # curl https://rclone.org/install.sh | bash
else
  log "rclone $(rclone --version | head -1) already installed — skipping"
fi

# ── 8. Drop directory ─────────────────────────────────────────────────────────
log "Creating drop directory: $DROP_DIR"
mkdir -p "$DROP_DIR"
chown pi:pi "$DROP_DIR"

# ── 9. Node dependencies ──────────────────────────────────────────────────────
log "Installing Node.js dependencies (npm ci)..."
cd "$REPO_DIR"
npm ci

# ── 10. Permissions on gdrive key (if already copied) ─────────────────────────
if [[ -f "$GDRIVE_KEY" ]]; then
  log "Locking down $GDRIVE_KEY..."
  chmod 600 "$GDRIVE_KEY"
  chown pi:pi "$GDRIVE_KEY"
else
  log "NOTE: $GDRIVE_KEY not found — copy it before starting the sync service."
  log "      scp ~/Downloads/display-bridge-key.json lt-pi:$GDRIVE_KEY"
fi

# ── 11. systemd units ─────────────────────────────────────────────────────────
log "Installing systemd units..."

UNITS_SRC="$REPO_DIR/setup"
UNITS_DST=/etc/systemd/system

for unit in display-bridge.service rclone-sync.service rclone-sync.timer; do
  cp "$UNITS_SRC/$unit" "$UNITS_DST/$unit"
  log "  Installed $unit"
done

systemctl daemon-reload
systemctl enable display-bridge
systemctl enable rclone-sync.timer

# Start the timer now (sync service starts automatically)
systemctl start rclone-sync.timer

# ── 12. rclone config reminder ───────────────────────────────────────────────
if ! rclone listremotes 2>/dev/null | grep -q "^gdrive:"; then
  log ""
  log "──────────────────────────────────────────────────────────"
  log "ACTION REQUIRED: Configure rclone for Google Drive."
  log ""
  log "  Run as the 'pi' user (not root):"
  log "  rclone config"
  log ""
  log "  Create a new remote named 'gdrive' using your service"
  log "  account key at $GDRIVE_KEY"
  log "  (scope: full access, service_account_file: path above)"
  log "──────────────────────────────────────────────────────────"
else
  log "rclone 'gdrive' remote already configured — skipping"
fi

# ── 13. config.json reminder ──────────────────────────────────────────────────
if [[ ! -f "$REPO_DIR/config.json" ]]; then
  log ""
  log "──────────────────────────────────────────────────────────"
  log "ACTION REQUIRED: Create config.json."
  log ""
  log "  cp $REPO_DIR/config.json.example $REPO_DIR/config.json"
  log "  nano $REPO_DIR/config.json"
  log "  (set display.host and display.pin)"
  log "──────────────────────────────────────────────────────────"
fi

# ── 14. Final status ──────────────────────────────────────────────────────────
log ""
log "Setup complete. Service status:"
systemctl is-active display-bridge    && log "  display-bridge:    active" \
                                       || log "  display-bridge:    NOT running (start after config.json is ready)"
systemctl is-active rclone-sync.timer && log "  rclone-sync.timer: active" \
                                       || log "  rclone-sync.timer: NOT running"

log ""
log "To start the bridge daemon after completing config:"
log "  sudo systemctl start display-bridge"
log "  journalctl -u display-bridge -f   # follow logs"
