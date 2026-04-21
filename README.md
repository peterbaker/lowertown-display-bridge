# Lowertown Display Bridge

Raspberry Pi daemon that syncs images from Google Drive and pushes them to the Samsung EM32DX e-paper display at Lowertown Bar & Cafe on a filename-based schedule. Headless; managed remotely via SSH over Tailscale.

> This README is ordered for daily use. If you're rebuilding the Pi from scratch, skip to the [Initial Install appendix](#appendix--initial-install-disaster-recovery) at the bottom.

---

## Managing Content

Drop an image into the **"Lowertown Display"** Google Drive folder (account `pete@lowertowna2.com`). Within 60 seconds the Pi picks it up and either pushes it immediately or schedules it based on the filename.

### Filename scheduling

| Tier | Filename format | Example | When it fires |
|------|-----------------|---------|---------------|
| 1 — One-time | `YYYY-MM-DDTHHMM[-desc].ext` | `2026-05-17T1800-trivia-night.jpg` | Once, on that exact date+time |
| 2 — Weekly | `DOW-THHMM[-desc].ext` | `MON-T1100-lunch.jpg` | Every Monday at 11:00 AM |
| 3 — Daily | `THHMM[-desc].ext` | `T1100-lunch.jpg` | Every day at 11:00 AM |
| 4 — Immediate | *(anything else)* | `spring-menu.jpg` | Pushed the moment it arrives |

- **Priority cascade**: Tier 1 > Tier 2 > Tier 3 at any given slot. Same-tier ties go to the alphabetically first filename.
- **DOW values**: `MON TUE WED THU FRI SAT SUN` (case-insensitive).
- **Separator**: dash or space — `T1100-lunch.jpg` and `T1100 lunch.jpg` are equivalent.
- **10-minute gap**: scheduled pushes (tiers 1–3) must be 10+ min apart (e-paper refresh takes up to a minute). Tier-4 immediate pushes bypass this.
- **Midnight cleanup**: tier-1 dated files are deleted from the Pi after their date passes. The Drive copy is untouched.

```
spring-menu.jpg                    → shows immediately on arrival
T1100-lunch.jpg                    → every day at 11:00 AM
MON-T1100-monday-special.jpg       → every Monday at 11:00 AM (overrides daily)
2026-05-17T1800-trivia-night.jpg   → May 17 at 6:00 PM only (overrides both)
```

---

## CLI Reference

Run from `/home/pi/display-bridge` on the Pi.

```bash
node bridge.js                              # start daemon (normally via systemd)
node bridge.js start --dry-run              # daemon, skip display send
node bridge.js push <image>                 # push one image immediately
node bridge.js push <image> --dry-run       # process but don't send
node bridge.js schedule                     # today's resolved schedule
node bridge.js schedule --date 2026-05-12   # simulate a specific date
node bridge.js status                       # display power/status
node bridge.js discover                     # find displays on local network
node bridge.js network-standby              # get Network Standby state
node bridge.js network-standby on           # enable Network Standby
```

---

## Operational Runbook

### Remote access

- SSH: `ssh lt-pi` or `ssh lowertown-pi` — both aliases resolve to the Tailscale hostname.
- If prompted for key passphrase: `ssh-add --apple-load-keychain`.
- Hard reboot (SSH unreachable): toggle TP-Link Kasa smart plug off/on; Tailscale auto-reconnects.

### Check system health

```bash
ssh lt-pi
systemctl status display-bridge                                       # daemon running?
systemctl status rclone-sync.timer                                    # sync running?
journalctl -u display-bridge -n 50                                    # last 50 log lines
journalctl -u rclone-sync --since today                               # sync history
systemctl is-active display-bridge rclone-sync.timer tailscaled       # all "active"?
```

### Is the Pi online?

`tailscale status` on your Mac — if `lowertown-pi` shows connected, the Pi is up.

### Pi unreachable (Tailscale offline)

1. Kasa app → toggle smart plug off → wait 10 s → toggle on.
2. Wait 60–90 s. Tailscale reconnects automatically.

### Force immediate Drive sync

```bash
ssh lt-pi
sudo systemctl start rclone-sync
```

### Display IP changed (router reboot, etc.)

Usually no action needed — the daemon rediscovers on startup and on send failures, and persists the new IP to `config.json`. If you want to nudge it:

```bash
ssh lt-pi
sudo systemctl restart display-bridge
journalctl -u display-bridge -n 20        # look for "Found display at …"
```

### Update bridge software

From your Mac (one command):
```bash
./deploy.sh                               # git pull + restart, single SSH connection
```

Or manually:
```bash
ssh lt-pi
cd /home/pi/display-bridge
git pull && npm ci && sudo systemctl restart display-bridge
```

---

## Migrating to a New Network

When the Pi + display move to a different WiFi network (location change, router replacement).

### Devices & MAC addresses

Use for DHCP reservations on the new router:

| Device | MAC |
|--------|-----|
| Pi eth0 | `dc:a6:32:8f:fd:07` |
| Pi wlan0 | `dc:a6:32:8f:fd:08` |
| Display (EM32DX) | `74:6d:fa:52:43:7a` |

### Step 1 — Add the new WiFi to the Pi (before moving)

The Pi uses NetworkManager (via netplan). Add the destination network with higher autoconnect-priority than existing fallbacks; keep the old networks configured.

```bash
ssh lt-pi
sudo nmcli connection add type wifi con-name "NewSSID" ifname wlan0 ssid "NewSSID" \
  wifi-sec.key-mgmt wpa-psk wifi-sec.psk "PASSWORD" \
  connection.autoconnect yes connection.autoconnect-priority 10

# Optionally lower priority of existing fallback:
sudo nmcli connection modify "netplan-wlan0-Baker's Acres" connection.autoconnect-priority 5
```

Ethernet always wins via route metric — priorities only matter in WiFi-only scenarios.

### Step 2 — Change the display's WiFi

The EM32DX has **no on-screen UI** (it's pure e-paper signage — no menus, no keyboard input possible). Three paths:

**A. MDC `network_ap_config` from the Pi (most reliable when display is on-network)**

If the display is currently on any WiFi network the Pi can reach, push credentials remotely:

```bash
ssh lt-pi
/usr/local/bin/samsung-mdc -p <PIN> 0@<display-ip> network_ap_config "NewSSID" "PASSWORD"
```

Known quirks (observed 2026-04-20):
- The command **always returns a timeout error** — the display disconnects to switch before it can ACK. That's normal; credentials may still have been accepted.
- After sending, the display drops its current network and takes **4–5 minutes** to settle (either onto the new SSID, or back onto the old one if the new one isn't reachable).
- Credentials only persist if the display successfully authenticates at least once. If the target SSID isn't broadcasting at the moment you run the command, or auth fails, the display silently discards them.
- There's no MDC command to list saved networks, so you can't verify storage without making the display actually use them.

**B. Samsung E-Paper phone app (often unavailable)**

1. Phone on the same WiFi as the display.
2. App → tap display → Settings → Network → Wi-Fi.
3. Forget current → select new SSID → enter password.

Caveat: the app requires the display to be **fully awake**, not in Network Standby. On e-paper displays the wake window closes fast and the hardware power button is unreliable for reopening it. Expect this to sometimes just not work — the app will show "display unavailable, press power button." When that happens, fall back to A or C.

**C. Factory reset on-site (last resort)**

If A and B both fail:

1. Factory reset the display via the physical reset procedure (see EM32DX manual).
2. **Network Standby defaults to OFF after reset** — critical. Re-enable during setup or before leaving (`node bridge.js network-standby on`), or the display becomes remotely inaccessible on next sleep.
3. The E-Paper app discovers factory-reset displays via Bluetooth LE (no network needed), so this works even when the app can't reach an already-configured display. Run first-time setup pointing at the real target network.
4. PIN resets to default (`000000`). If you change it during setup, update `config.json`.

### Step 3 — (Optional) Pre-verify at home via SSID cloning

Create a phone/tablet hotspot with the **exact SSID and password** of the destination network, then try method A above. The Pi auto-joins (we configured it in Step 1); if the display also hops onto the hotspot, credentials are proven.

- **iPhone/iPad**: Settings → General → About → Name → target SSID. Settings → Personal Hotspot → Wi-Fi Password → target password. **Maximize Compatibility ON** (EM32DX is 2.4 GHz only).
- **Android**: Settings → Hotspot → set name and password directly.

Heads up: **iOS Personal Hotspot sometimes negotiates WPA in a way the e-paper firmware can't auth against, even with correct credentials** (observed 2026-04-20). A successful home test is proof-positive; a failed home test is inconclusive — the display may still work fine against the real destination router. Bring the hotspot-capable device to install day as a safety net regardless.

### Step 4 — On-site at the new location

The daemon self-heals the display IP: on start, if `config.json`'s host is unreachable, it scans the /24, finds the display, and persists the new IP. You don't need to edit `config.json` manually.

```bash
ssh lt-pi                                                  # Tailscale works on any network
cd /home/pi/display-bridge
sudo systemctl restart display-bridge
journalctl -u display-bridge -n 20 -f                      # watch for "Found display at …"
# Ctrl+C once you see it settle
node bridge.js network-standby on                          # REQUIRED before leaving
node bridge.js network-standby                             # confirm "ON"
node bridge.js push /home/pi/display-drop/<any-image>      # verify
systemctl is-active display-bridge rclone-sync.timer tailscaled
```

Add DHCP reservations for Pi and display on the new router — rediscovery handles day-to-day IP drift, but a fixed IP is still cleaner.

**Network Standby is the one thing that cannot be fixed remotely. Do not leave without confirming `ON`.**

#### If the display doesn't auto-join on arrival

1. Give it 5 full minutes — e-paper displays are slow to reconnect after a location change.
2. Check `nmcli device status` on the Pi; the Pi itself should have joined the new network via Step 1's preconfigured entry. If the Pi joined but the display didn't, the display's saved credentials didn't persist (see Step 2 quirks).
3. Plug in the hotspot-capable device you brought as safety net; broadcast the target SSID on it. This gives you a mobile WiFi the Pi is also configured for, so you can push credentials via MDC method A to the display.
4. If that also fails, do the on-site factory reset (Step 2, method C), which pairs the display with the real router via the app's Bluetooth-LE setup flow. Re-enable Network Standby before leaving.

---

## Development

```bash
npm test      # 59 unit tests via node:test, no external framework, ~40 ms
npm ci        # install from lockfile (respects package-lock.json)
```

Tests use fixed reference dates rather than `new Date()` to avoid flakiness. Timezone is always `America/Detroit` — construct dates with `new Date(yr, mo-1, dy, hh, mm)`, never `new Date(isoString)`.

---

## File Structure

```
├── bridge.js                     CLI entry point
├── deploy.sh                     One-command deploy from Mac (git pull + restart)
├── package.json
├── package-lock.json
├── config.json.example
├── config.json                   (gitignored — display IP + PIN)
├── .expired                      (gitignored — daemon-managed rclone exclude list)
├── CLAUDE.md                     Instructions for AI coding assistants
├── README.md
├── lib/
│   ├── config-store.js           config.json load/save
│   ├── display.js                samsung-emdx/mdc wrappers
│   ├── filename.js               4-tier filename parser
│   ├── process-image.js          sharp resize → 1440×2560 portrait
│   ├── registry.js               file registry + cascade resolution
│   └── scheduler.js              daemon: timers, gap rule, retry, midnight rollover
├── setup/
│   ├── setup.sh                  Pi bootstrap script (run as root)
│   ├── display-bridge.service    systemd: bridge daemon
│   ├── rclone-sync.service       systemd: one-shot Drive sync
│   └── rclone-sync.timer         systemd: 60-second polling timer
└── test/
    ├── filename.test.js
    └── registry.test.js
```

---

# Appendix — Initial Install (disaster recovery)

These steps rebuild the Pi from scratch. Follow them only if the current Pi is dead or you're provisioning a replacement. For everyday ops, the sections above have what you need.

## A1. Hardware

- Raspberry Pi 4 or 5
- **High-endurance** microSD card, 32 GB+ (Samsung Pro Endurance or SanDisk MAX ENDURANCE — standard cards burn out under the continuous writes)
- TP-Link Kasa smart plug (for remote power-cycle)
- Ethernet cable; WiFi is fallback only

## A2. Flash the SD card

Download Raspberry Pi Imager from **raspberrypi.com/software**. In the customisation dialog:

| Setting | Value |
|---------|-------|
| Hostname | `lowertown-pi` |
| Username | `pi` |
| Password | (strong, save somewhere) |
| Configure wireless LAN | Any WiFi with internet (initial; runtime WiFi is managed via nmcli) |
| Wireless LAN country | US |
| Locale / timezone | `America/Detroit` |
| Keyboard layout | `us` |
| Services → SSH | Enable with password auth |

Eject, insert into Pi.

## A3. First boot, Tailscale, SSH key

Connect Pi to Ethernet, power on, wait 90 s.

```bash
# From Mac
ssh pi@lowertown-pi.local                           # use Imager password

# On Pi — install Tailscale first so you can SSH by hostname from anywhere
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
# Open the printed URL on your Mac or phone to authenticate
```

Back on the Mac:
```bash
ssh-copy-id -i ~/.ssh/id_ed25519 pi@lowertown-pi.local
ssh-add --apple-use-keychain ~/.ssh/id_ed25519
```

Add to `~/.ssh/config`:
```
Host lt-pi lowertown-pi
    HostName lowertown-pi
    User pi
    IdentityFile ~/.ssh/id_ed25519
```

Verify `ssh lowertown-pi` works (uses Tailscale MagicDNS). Then disable password auth:
```bash
ssh lt-pi 'sudo sed -i "s/^#*PasswordAuthentication.*/PasswordAuthentication no/" /etc/ssh/sshd_config && sudo systemctl restart sshd'
```

## A4. Google Drive service account

Credentials never expire and need no human renewal.

1. Drive as `pete@lowertowna2.com`: create folder **"Lowertown Display"**.
2. [console.cloud.google.com](https://console.cloud.google.com) (same account): create project "Lowertown Display Bridge".
3. Enable **Google Drive API**.
4. IAM & Admin → Service Accounts → create `display-bridge`.
5. Keys tab → Add Key → Create → **JSON** → downloads locally.
6. In Drive: share "Lowertown Display" folder with the service-account email (Viewer).

> **Org-policy block**: if key creation is forbidden, override `iam.disableServiceAccountKeyCreation` at the project level. Needs the Organization Policy Administrator role (grant it to yourself at the org level first).

Copy key to the Pi:
```bash
scp ~/Downloads/display-bridge-*.json lt-pi:/home/pi/display-bridge/gdrive-key.json
ssh lt-pi 'chmod 600 /home/pi/display-bridge/gdrive-key.json'
```

## A5. Install the bridge software

```bash
ssh lt-pi
sudo apt install -y git
git clone https://github.com/peterbaker/lowertown-display-bridge.git /home/pi/display-bridge
cd /home/pi/display-bridge
sudo bash setup/setup.sh
```

Setup installs Node 20, Python tools, samsung-emdx, rclone; creates `/home/pi/display-drop`; runs `npm ci`; installs systemd services.

Configure rclone (as `pi`, not root):
```bash
rclone config
# n) New → name: gdrive → Storage: Google Drive
# client_id + secret: blank
# scope: 1 (full access)
# service_account_file: /home/pi/display-bridge/gdrive-key.json
# advanced: n, auto config: n, team drive: n
```

Verify:
```bash
rclone lsd --drive-shared-with-me gdrive:                # should list "Lowertown Display"
touch /home/pi/display-bridge/.expired                    # required before first sync
rclone sync "gdrive:Lowertown Display" /home/pi/display-drop --drive-shared-with-me --verbose
```

Create `config.json`:
```bash
cp config.json.example config.json
nano config.json                                          # display.host + display.pin
```

## A6. Pre-deployment test

```bash
cd /home/pi/display-bridge
sudo systemctl start rclone-sync                          # 1. force sync
node bridge.js schedule                                   # 2. today's schedule
node bridge.js schedule --date 2026-04-13                 # 3. specific day (Monday)
node bridge.js start --dry-run                            # 4. dry-run daemon; Ctrl+C
sudo reboot                                               # 5. reboot recovery
# SSH back in after 90 s
journalctl -u display-bridge -n 30                        # should show catch-up
systemctl is-active display-bridge rclone-sync.timer tailscaled    # all "active"
```

If the display is on the same network, also:
```bash
node bridge.js discover
nano config.json                                          # set display IP
node bridge.js network-standby on                         # REQUIRED
node bridge.js push /home/pi/display-drop/<any-image>     # verify physical push
```

## A7. Install on-site

Follow [Migrating to a New Network → Step 4](#step-4--on-site-at-the-new-location) above — an initial install and a network migration look identical on-site.
