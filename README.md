# Lowertown Display Bridge

Raspberry Pi bridge that syncs images from Google Drive and pushes them to the Samsung EM32DX e-paper display at Lowertown Bar & Cafe on a filename-based schedule. Fully headless — managed remotely via SSH over Tailscale from anywhere.

---

## How It Works

Drop an image file into the **"Lowertown Display"** Google Drive folder (`pete@lowertowna2.com`). Within 60 seconds, the Pi picks it up and either pushes it immediately or schedules it based on the filename.

### Filename scheduling

| Tier | Filename format | Example | When it fires |
|------|----------------|---------|---------------|
| 1 — One-time | `YYYY-MM-DDTHHMM[-desc].ext` | `2026-04-09T1800-jazz-night.jpg` | Once, on that exact date at that time |
| 2 — Weekly | `DOW-THHMM[-desc].ext` | `MON-T1100-lunch-special.jpg` | Every Monday at 11:00 AM |
| 3 — Daily | `THHMM[-desc].ext` | `T1100-standard-lunch.jpg` | Every day at 11:00 AM |
| 4 — Immediate | *(anything else)* | `spring-menu.jpg` | Pushed the moment it arrives |

**Priority cascade**: Tier 1 > Tier 2 > Tier 3 at any given time slot. Same-tier ties go to the alphabetically first filename.

**DOW values**: `MON TUE WED THU FRI SAT SUN` (case-insensitive in filename)

**10-minute gap rule**: Scheduled pushes (tiers 1–3) must be at least 10 minutes apart — the e-paper display takes up to a minute to refresh. Tier-4 immediate pushes bypass this rule.

---

## Part 1 — Flash the SD Card (Mac)

You'll need a **high-endurance** microSD card (32GB+). Standard cards degrade quickly under continuous writes — use Samsung Pro Endurance or SanDisk MAX ENDURANCE.

### Step 1: Download Raspberry Pi Imager

Download from **raspberrypi.com/software** and install it on your Mac. It's a free GUI app — no command line needed for flashing.

### Step 2: Configure and write the card

1. Insert the SD card into your Mac
2. Open Raspberry Pi Imager
3. **Raspberry Pi Device** → choose your Pi model (Pi 4 or Pi 5)
4. **Operating System** → scroll down to "Raspberry Pi OS (other)" → choose **Raspberry Pi OS Lite (64-bit)** — no desktop needed
5. **Storage** → select your SD card
6. Click **Next**, then when asked about customisation settings click **Edit Settings**

In the customisation dialog:

| Setting | Value |
|---------|-------|
| Set hostname | `lowertown-pi` |
| Username | `pi` |
| Password | *(choose a strong one — write it down)* |
| Configure wireless LAN | Enter bar WiFi SSID + password (fallback; prefer Ethernet at bar) |
| Wireless LAN country | US |
| Set locale / timezone | `America/Detroit` |
| Keyboard layout | `us` |

Switch to the **Services** tab → Enable SSH → **Use password authentication**

Click **Save** → **Yes** → **Yes** to write. Takes ~3–5 minutes. Eject and insert into Pi.

---

## Part 2 — First Boot & Remote Access

### Power on and SSH in

Connect the Pi to Ethernet if possible. Power it on. Wait 60–90 seconds, then from your Mac:

```bash
ssh pi@lowertown-pi.local
# Enter the password you set in Imager
```

If `lowertown-pi.local` doesn't resolve, find the Pi's IP in your router's DHCP table.

### Install Tailscale (remote SSH from anywhere)

```bash
# On the Pi
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

Open the printed URL on your Mac/phone to authenticate. Once joined, SSH works from anywhere — no `.local`, no port forwarding needed.

### Set up a dedicated SSH key for the Pi (no passphrase)

Create a key specifically for the Pi on your Mac:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_pi -N "" -C "pete@lowertown-pi"
ssh-copy-id -i ~/.ssh/id_ed25519_pi.pub pi@lowertown-pi
```

Add to `~/.ssh/config` on your Mac:

```
Host lt-pi
    HostName lowertown-pi
    User pi
    IdentityFile ~/.ssh/id_ed25519_pi
```

Verify it works with no prompts:
```bash
ssh lt-pi
```

### Disable password auth on the Pi

Once key login is confirmed working:

```bash
# On the Pi
sudo sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo systemctl restart sshd
```

### DHCP reservations

In your router, reserve fixed IPs for both devices by MAC address:
- **Pi** — `ip link show eth0` on the Pi
- **Display** — found in the Samsung E-Paper app settings

Without reservations, a router reboot could silently break `config.json`.

---

## Part 3 — Google Drive Setup

The Pi syncs from a Google Drive folder using a **Service Account** — credentials that never expire and need no human interaction to renew.

### Create the Drive folder

In Google Drive (`pete@lowertowna2.com`): New → Folder → **"Lowertown Display"**. This is where you'll drop images from your Mac.

### Create a Service Account

1. Go to [console.cloud.google.com](https://console.cloud.google.com) signed in as `pete@lowertowna2.com`
2. Create a project → name it **"Lowertown Display Bridge"**
3. Search "Google Drive API" → Enable it
4. IAM & Admin → Service Accounts → Create Service Account → name: `display-bridge`
5. On the service account → Keys tab → Add Key → Create new key → **JSON** → downloads automatically

> **Google Workspace org policy note**: If key creation is blocked by an org policy, go to IAM & Admin → Organization policies → search `iam.disableServiceAccountKeyCreation` → override it for this project as "Not enforced". You'll need the Organization Policy Administrator role — grant it to yourself at the organization level in IAM first.

### Share the Drive folder with the service account

- Copy the service account email (looks like `display-bridge@your-project.iam.gserviceaccount.com`)
- In Google Drive, right-click "Lowertown Display" → Share → paste that email → **Viewer** → Share

### Copy the key to the Pi

```bash
# From your Mac (adjust filename to match what Google downloaded)
scp ~/Downloads/display-bridge-*.json lt-pi:/home/pi/display-bridge/gdrive-key.json
```

Then on the Pi:
```bash
chmod 600 /home/pi/display-bridge/gdrive-key.json
```

---

## Part 4 — Install the Bridge Software

### Clone and run setup

```bash
# On the Pi
sudo apt install -y git
git clone https://github.com/peterbaker/lowertown-display-bridge.git /home/pi/display-bridge
cd /home/pi/display-bridge
sudo bash setup/setup.sh
```

The setup script installs Node 20, Python tools, samsung-emdx, rclone, creates the drop directory, runs `npm ci`, and installs the systemd services.

### Configure rclone

Run as the `pi` user (not root):

```bash
rclone config
# n) New remote
# name: gdrive
# Storage: Google Drive
# client_id: (leave blank)
# client_secret: (leave blank)
# scope: 1 (full access)
# service_account_file: /home/pi/display-bridge/gdrive-key.json
# Edit advanced config? n
# Use auto config? n  (headless — no browser)
# Team Drive? n
# Confirm with y
```

Test the connection. The Drive folder is shared *with* the service account, so it requires `--drive-shared-with-me`:

```bash
rclone lsd --drive-shared-with-me gdrive:
# Should list "Lowertown Display"
```

Test the sync:
```bash
touch /home/pi/display-bridge/.expired   # required before first sync
rclone sync "gdrive:Lowertown Display" /home/pi/display-drop --drive-shared-with-me --verbose
ls /home/pi/display-drop/
```

### Create config.json

```bash
cp /home/pi/display-bridge/config.json.example /home/pi/display-bridge/config.json
nano /home/pi/display-bridge/config.json
```

Set `display.host` to the display's IP and `display.pin` to its PIN. If you don't have those yet (display is at the bar), leave the placeholder values for now — the daemon won't connect but dry-run mode still works for all home testing.

---

## Part 5 — Home Testing Before Bar Deployment

Test everything at home first. Once the Pi is at the bar, it has to work.

### Phase A: Software-only test (no display required)

```bash
cd /home/pi/display-bridge

# 1. Force a Drive sync and verify files appear
sudo systemctl start rclone-sync
ls /home/pi/display-drop/

# 2. Check today's resolved schedule
node bridge.js schedule

# 3. Simulate a specific day (verify Monday DOW files fire correctly)
node bridge.js schedule --date 2026-04-13     # a Monday

# 4. Run daemon in dry-run mode — watch for "[DRY RUN] Would push X" at fire times
node bridge.js start --dry-run
# Ctrl+C when satisfied

# 5. Test a dry-run push of a specific image
node bridge.js push /home/pi/display-drop/some-image.jpg --dry-run

# 6. Test reboot recovery
sudo reboot
# SSH back in after ~90 seconds
journalctl -u display-bridge -n 30    # should show catch-up image identified

# 7. Verify all services survived the reboot
systemctl is-active display-bridge rclone-sync.timer tailscaled
# All three should say "active"
```

### Phase B: Live test (display on same network as Pi)

```bash
cd /home/pi/display-bridge

# 1. Find the display IP
node bridge.js discover

# 2. Update config.json with the home network display IP
nano config.json

# 3. Enable Network Standby (REQUIRED — cannot be fixed remotely if missed)
node bridge.js network-standby on
node bridge.js network-standby    # confirm returns "ON"

# 4. Test a manual push
node bridge.js push /home/pi/display-drop/some-image.jpg
# Display should refresh in 5–15 seconds

# 5. Run daemon live, watch a scheduled slot fire
#    (drop a file like T1430-test.jpg if it's currently 2:28 PM)
node bridge.js start

# 6. Reboot and verify the catch-up image appears on the physical display
sudo reboot
```

---

## Part 6 — Bar Installation

What changes from home → bar: **only the display IP**. Everything else is identical.

### Checklist

- [ ] Plug Pi into TP-Link Kasa smart plug → plug into power outlet
- [ ] Connect Pi to bar Ethernet (preferred) or confirm bar WiFi credentials are set
- [ ] Power on Pi, wait 90 seconds
- [ ] `ssh lt-pi` from Mac (Tailscale connects automatically)
- [ ] `cd /home/pi/display-bridge && node bridge.js discover` — find display IP
- [ ] Reserve display IP in bar router DHCP (MAC → IP)
- [ ] Reserve Pi IP in bar router DHCP (`ip link show eth0` for MAC)
- [ ] `nano config.json` — update `display.host`
- [ ] `sudo systemctl restart display-bridge`
- [ ] `node bridge.js network-standby on` then `node bridge.js network-standby` → confirm "ON"
- [ ] `node bridge.js push /home/pi/display-drop/<any-image>` — test push
- [ ] Confirm image appears on display
- [ ] `systemctl is-active display-bridge rclone-sync.timer tailscaled` — all "active"
- [ ] Leave bar; verify Tailscale still shows `lowertown-pi` online from your Mac

**Network Standby** is the one thing that cannot be fixed remotely. Do not leave the bar without confirming it is ON.

**On-site time**: ~15–20 minutes.

---

## Managing Content

Drop images into **"Lowertown Display"** in Google Drive. The Pi picks them up within 60 seconds.

```
spring-menu.jpg                    → shows immediately on arrival
T1100-lunch.jpg                    → every day at 11:00 AM
MON-T1100-monday-special.jpg       → every Monday at 11:00 AM (overrides daily)
2026-05-17T1800-trivia-night.jpg   → May 17 at 6:00 PM only (overrides both)
```

Tier-1 dated files are automatically deleted from the Pi at midnight after their date passes. The Drive copy is untouched.

---

## CLI Reference

```bash
node bridge.js                              # start daemon
node bridge.js start --dry-run             # start daemon, skip actual display send
node bridge.js push <image>                # push one image immediately
node bridge.js push <image> --dry-run      # process but don't send
node bridge.js schedule                    # print today's resolved schedule
node bridge.js schedule --date 2026-05-12  # simulate a specific date
node bridge.js status                      # display power/status
node bridge.js discover                    # find displays on local network
node bridge.js network-standby             # get Network Standby state
node bridge.js network-standby on         # enable Network Standby
```

---

## Operational Runbook

### Check system health

```bash
ssh lt-pi
systemctl status display-bridge           # is daemon running?
systemctl status rclone-sync.timer        # is sync running?
journalctl -u display-bridge -n 50        # last 50 log lines
journalctl -u rclone-sync --since today   # sync history
```

### Is the Pi online? (without SSH)

`tailscale status` on your Mac — if `lowertown-pi` shows connected, the Pi is up. If offline, power-cycle via Kasa app.

### Pi completely unreachable (Tailscale offline)

1. Open Kasa app → toggle smart plug off → wait 10 seconds → toggle on
2. Wait 60–90 seconds
3. Tailscale reconnects automatically

### Force immediate Drive sync

```bash
ssh lt-pi
sudo systemctl start rclone-sync
```

### Display IP changed

```bash
ssh lt-pi
cd /home/pi/display-bridge
node bridge.js discover
nano config.json                          # update "host"
sudo systemctl restart display-bridge
```

### Update bridge software

```bash
ssh lt-pi
cd /home/pi/display-bridge
git pull
npm ci
sudo systemctl restart display-bridge
```

---

## Development

```bash
npm test     # 59 unit tests, ~40ms, no external framework
npm ci       # install from lockfile
```

---

## File Structure

```
├── bridge.js                     CLI entry point
├── package.json
├── package-lock.json
├── config.json.example
├── config.json                   (gitignored — display IP + PIN)
├── .expired                      (gitignored — daemon-managed rclone exclude list)
├── CLAUDE.md                     Instructions for AI coding assistants
├── lib/
│   ├── filename.js               4-tier filename parser
│   ├── registry.js               file registry + cascade resolution
│   ├── scheduler.js              daemon: timers, gap rule, retry, midnight rollover
│   ├── display.js                samsung-emdx/mdc wrappers
│   └── process-image.js          sharp resize → 1440×2560 portrait
├── setup/
│   ├── setup.sh                  Pi bootstrap script (run as root)
│   ├── display-bridge.service    systemd: bridge daemon
│   ├── rclone-sync.service       systemd: one-shot Drive sync
│   └── rclone-sync.timer         systemd: 60-second polling timer
└── test/
    ├── filename.test.js
    └── registry.test.js
```
