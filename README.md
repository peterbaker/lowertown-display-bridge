# Lowertown Display Bridge

Raspberry Pi bridge that syncs images from Google Drive and pushes them to the Samsung EM32DX e-paper display at Lowertown Bar & Cafe on a filename-based schedule. Fully headless — managed remotely via SSH over Tailscale from anywhere.

---

## How It Works

Drop an image file into the **"Lowertown Display"** Google Drive folder. Within 60 seconds, the Pi picks it up and either pushes it immediately or schedules it based on the filename.

### Filename scheduling

| Tier | Filename format | Example | When it fires |
|------|----------------|---------|---------------|
| 1 — One-time | `YYYY-MM-DDTHHMM[-desc].ext` | `2026-04-09T1800-jazz-night.jpg` | Once, on that exact date at that time |
| 2 — Weekly | `DOW-THHMM[-desc].ext` | `MON-T1100-lunch-special.jpg` | Every Monday at 11:00 AM |
| 3 — Daily | `THHMM[-desc].ext` | `T1100-standard-lunch.jpg` | Every day at 11:00 AM |
| 4 — Immediate | *(anything else)* | `spring-menu.jpg` | Pushed the moment it arrives |

**Priority cascade**: Tier 1 > Tier 2 > Tier 3 at any given time slot. If two files compete in the same tier, the alphabetically first filename wins.

**DOW values**: `MON TUE WED THU FRI SAT SUN` (case-insensitive in filename)

**10-minute gap rule**: Scheduled pushes (tiers 1–3) must be at least 10 minutes apart — the e-paper display takes up to a minute to refresh. Immediate (tier 4) pushes bypass this rule.

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
6. Click **Next**, then when asked "Would you like to apply OS customisation settings?" click **Edit Settings**

In the customisation dialog, fill in:

| Setting | Value |
|---------|-------|
| Set hostname | `lowertown-pi` |
| Username | `pi` |
| Password | *(choose a strong one — write it down)* |
| Configure wireless LAN | Enter bar WiFi SSID + password (fallback; prefer Ethernet at bar) |
| Wireless LAN country | US |
| Set locale / timezone | `America/Detroit` |
| Keyboard layout | `us` |

Switch to the **Services** tab:
- Enable SSH: **Use password authentication** (switch to key-only after first boot)

Click **Save**, then **Yes** to apply settings. Click **Yes** to confirm writing (this erases the card). Wait for it to finish — about 3–5 minutes.

Eject the card and insert it into the Pi.

---

## Part 2 — First Boot & Remote Access

### Power on and connect

Connect the Pi to Ethernet if possible (strongly preferred over WiFi — immune to password changes). Power it on. Wait 60–90 seconds.

From your Mac:
```bash
ssh pi@lowertown-pi.local
# Enter the password you set in Imager
```

If `lowertown-pi.local` doesn't resolve, find the Pi's IP in your router's DHCP table and use that directly.

### DHCP reservations (do this now, before the bar)

In your router's admin page, reserve fixed IPs for both devices by MAC address:
- **Pi** — run `ip link show eth0` on the Pi to get its MAC
- **Display** — find its MAC in the Samsung E-Paper app settings

Without reservations, a router reboot could silently break `config.json`.

### Install Tailscale (remote SSH from anywhere)

```bash
# On the Pi
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

Open the printed URL on your Mac/phone to authenticate the Pi into your tailnet. Once joined, you can SSH from anywhere:

```bash
ssh pi@lowertown-pi       # via Tailscale — no .local needed, no port forwarding
```

Add this to `~/.ssh/config` on your Mac for convenience:
```
Host lt-pi
    HostName lowertown-pi
    User pi
    IdentityFile ~/.ssh/id_ed25519
```

Then `ssh lt-pi` gets you in.

### Set up SSH key auth (disable password login)

```bash
# On your Mac
ssh-keygen -t ed25519 -C "pete@lowertown-pi"   # skip if you already have a key
ssh-copy-id pi@lowertown-pi

# Verify key login works (should not prompt for password)
ssh lt-pi

# On the Pi — disable password auth
sudo sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo systemctl restart sshd
```

---

## Part 3 — Install the Bridge Software

```bash
# On the Pi (SSH'd in)
git clone https://github.com/peterbaker/lowertown-display-bridge.git /home/pi/display-bridge
cd /home/pi/display-bridge
sudo bash setup/setup.sh
```

The setup script is idempotent — safe to re-run. It installs Node 20, Python tools, samsung-emdx, rclone, creates the drop directory, runs `npm ci`, and installs the systemd services.

After it finishes, two manual steps remain (instructions are printed at the end):

### Manual step A: Configure rclone

First, get the Google Service Account JSON key onto the Pi:
```bash
# From your Mac
scp ~/Downloads/display-bridge-key.json lt-pi:/home/pi/display-bridge/gdrive-key.json
```

Then configure rclone **as the `pi` user** (not root):
```bash
rclone config
# n) New remote
# name: gdrive
# Storage: Google Drive (option number varies — search for "drive")
# client_id: (leave blank)
# client_secret: (leave blank)
# scope: 1 (full access)
# service_account_file: /home/pi/display-bridge/gdrive-key.json
# Edit advanced config? n
# Use auto config? n  (headless Pi can't open a browser)
# Team Drive? n
# Confirm with y
```

Test it:
```bash
rclone lsd gdrive:
# Should list folders in Drive including "Lowertown Display"

mkdir -p /home/pi/display-drop
rclone sync gdrive:"Lowertown Display" /home/pi/display-drop --verbose
ls /home/pi/display-drop/
```

### Manual step B: Create config.json

```bash
cp /home/pi/display-bridge/config.json.example /home/pi/display-bridge/config.json
nano /home/pi/display-bridge/config.json
```

Set `display.host` to the display's IP address and `display.pin` to its PIN. The display IP can be found with:
```bash
node bridge.js discover
```

---

## Part 4 — Home Testing Before Bar Deployment

Test everything at home first. Once it's at the bar, it has to work.

### Phase A: Software-only test (no display required)

```bash
# 1. Force a Drive sync and verify files appear
sudo systemctl start rclone-sync
ls /home/pi/display-drop/

# 2. Check today's resolved schedule
cd /home/pi/display-bridge
node bridge.js schedule

# 3. Simulate a specific day (e.g., verify Monday DOW files)
node bridge.js schedule --date 2026-04-13     # a Monday

# 4. Run daemon in dry-run mode — watch logs
node bridge.js start --dry-run
# You should see timers set, and "[DRY RUN] Would push X" at fire times
# Ctrl+C when satisfied

# 5. Test a dry-run push of a specific image
node bridge.js push /home/pi/display-drop/some-image.jpg --dry-run

# 6. Test reboot recovery
sudo reboot
# SSH back in after ~90 seconds
journalctl -u display-bridge -n 30    # should show catch-up image identified

# 7. Verify Tailscale survived the reboot
tailscale status    # lowertown-pi should show as connected (from your Mac)

# 8. Verify all services are running
systemctl is-active display-bridge rclone-sync.timer tailscaled
# All three should say "active"
```

### Phase B: Live test (display on same network as Pi)

```bash
# 1. Discover the display on your home network
node bridge.js discover       # note the IP

# 2. Update config.json with home network IP
nano config.json

# 3. Enable Network Standby on the display (REQUIRED — cannot fix remotely)
node bridge.js network-standby on
node bridge.js network-standby    # should return "ON"

# 4. Test a manual push
node bridge.js push /home/pi/display-drop/some-image.jpg
# Display should refresh (5–15 seconds)

# 5. Verify status
node bridge.js status

# 6. Run daemon in live mode, watch a scheduled slot fire
#    (drop a file like T1430-test.jpg if it's currently 2:28 PM)
node bridge.js start

# 7. Reboot and verify catch-up appears on the physical display
sudo reboot
```

---

## Part 5 — Bar Installation

What changes from home → bar: **only the display IP**. Everything else is identical.

### Checklist

- [ ] Plug Pi into smart plug (TP-Link Kasa), smart plug into power outlet
- [ ] Connect Pi to bar Ethernet (preferred) or confirm WiFi creds are set
- [ ] Power on Pi, wait 90 seconds
- [ ] `ssh lt-pi` from Mac (Tailscale should connect automatically)
- [ ] `node bridge.js discover` — find display IP on bar network
- [ ] Reserve display IP in bar router DHCP (MAC → IP)
- [ ] Reserve Pi IP in bar router DHCP (`ip link show eth0` for MAC)
- [ ] `nano /home/pi/display-bridge/config.json` — update display IP
- [ ] `sudo systemctl restart display-bridge`
- [ ] `node bridge.js network-standby on` — enable Network Standby
- [ ] `node bridge.js network-standby` — confirm returns "ON"
- [ ] `node bridge.js push /home/pi/display-drop/<any-image>` — test push
- [ ] Confirm image appears on display
- [ ] `systemctl is-active display-bridge rclone-sync.timer tailscaled` — all "active"
- [ ] Leave bar; verify Tailscale still shows `lowertown-pi` online

**Network Standby** is the one setting that cannot be fixed remotely. Do not leave the bar without confirming it is ON.

**On-site time**: ~15–20 minutes.

---

## Managing Content

Drop images into the **"Lowertown Display"** folder in Google Drive (`pete@lowertowna2.com`). The Pi picks them up within 60 seconds.

### Filename examples

```
spring-menu.jpg                        → shows immediately on arrival
T1100-lunch.jpg                        → shows every day at 11:00 AM
MON-T1100-monday-special.jpg           → shows every Monday at 11:00 AM (overrides daily)
2026-05-17T1800-trivia-night.jpg       → shows May 17 at 6:00 PM only (overrides both)
```

Tier-1 dated files are automatically deleted from the Pi at midnight after their date passes. They remain in Google Drive as an archive.

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

### Is the Pi online without SSH?

Check Tailscale on your Mac: `tailscale status`. If `lowertown-pi` shows as connected, the Pi's OS is running. If offline, use the Kasa app to power-cycle it.

### Pi completely unreachable (Tailscale offline)

1. Open Kasa app on phone
2. Toggle the smart plug off → wait 10 seconds → toggle on
3. Wait 60–90 seconds for Pi to boot
4. Tailscale reconnects automatically — verify in the Kasa/Tailscale apps

### Force immediate Drive sync

```bash
ssh lt-pi
sudo systemctl start rclone-sync
```

### Display IP changed (after router reboot)

```bash
ssh lt-pi
cd /home/pi/display-bridge
node bridge.js discover          # find new IP
nano config.json                 # update "host"
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

### Check tonight's schedule

```bash
ssh lt-pi && cd /home/pi/display-bridge && node bridge.js schedule
```

---

## Development

```bash
npm test          # run unit tests (59 tests, ~40ms)
npm ci            # install deps from lockfile
```

Tests use Node.js built-in runner — no external framework. All use fixed reference dates so they never flake based on the current day.

---

## File Structure

```
├── bridge.js                     CLI entry point
├── package.json
├── package-lock.json
├── config.json.example
├── config.json                   (gitignored — contains display IP + PIN)
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
