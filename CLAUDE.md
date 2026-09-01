# Lowertown Display Bridge — Claude Code Instructions

## What This Is

A Raspberry Pi bridge that syncs images from a Google Drive folder (`pete@lowertowna2.com`) and pushes them to a Samsung EM32DX e-paper display at Lowertown Bar & Cafe over local WiFi. Fully headless and remotely managed via SSH + Tailscale.

## Architecture

### Filename-based scheduling cascade (4 tiers, highest priority first)

| Tier | Format | Example | When it fires |
|------|--------|---------|---------------|
| 1 | `YYYY-MM-DDTHHMM[-desc].ext` | `2026-04-09T1800-jazz-night.jpg` | Once, on that exact date+time |
| 2 | `DOW-THHMM[-desc].ext` | `MON-T1100-lunch.jpg` | Every matching weekday at that time |
| 3 | `THHMM[-desc].ext` | `T1100-daily-lunch.jpg` | Every day at that time |
| 4 | *(anything else)* | `spring-menu.jpg` | Pushed immediately on arrival |

DOW: `MON TUE WED THU FRI SAT SUN` (case-insensitive in filename).

**Separator**: the character between the time token and description can be `-` or a space — `T1100-lunch.jpg` and `T1100 lunch.jpg` parse identically.

**Tie-breaking**: when multiple files compete for the same tier+slot, alphabetically first filename wins.

### Core modules

- `lib/filename.js` — 4-tier regex parser; `parseFilename`, `nextFireTime`, `wasApplicableAt`, `slotKey`, `dateStr`, `todayDow`, `hhmmOf`
- `lib/registry.js` — file registry; `Registry` class with `add/remove`, `resolveSlot`, `resolveCurrentDisplay`, `allHHMMs`, `filesInSlot`, `expiredDatedFiles`
- `lib/scheduler.js` — daemon; one `setTimeout` per HHMM slot, gap enforcement (10 min), retry logic (10 min window), midnight rollover, chokidar file watcher
- `lib/reachability.js` — offline gate; `createReachabilityGate` defers pushes while the display is unpowered and pushes a catch-up the moment TCP 1515 answers
- `lib/power-probe-gate.js` — self-disables the post-push MDC power probe after 3 consecutive failures (the EM32DX never answers it)
- `lib/display.js` — `samsung-emdx` + `samsung-mdc` wrappers (already complete)
- `lib/process-image.js` — `sharp` resize to 1440×2560 portrait with white letterbox (already complete)

### Key behaviors

- **One timer per HHMM slot** — cascade resolution (`resolveSlot`) happens at fire time, so late-arriving files compete correctly
- **10-minute gap** — scheduled pushes must be 10+ minutes apart (enforced at fire time); tier-4 immediate files bypass this
- **Startup catch-up** — on daemon start, pushes whichever past slot's winner is most recent (handles Pi reboots)
- **Power-aware pushes** — the wall display is on a power schedule (off overnight, back ~07:45) while slots start at 07:30. A failed send is probed against TCP 1515; if the panel doesn't answer, the bridge enters offline mode, defers pushes instead of hanging 120s on each, and polls every 30s. The first answer triggers an immediate `resolveCurrentDisplay()` push, so the wall updates at power-on, not at the next slot
- **Midnight rollover** — deletes expired tier-1 files from Pi, adds them to `.expired` so rclone doesn't re-download, rebuilds timers
- **`--dry-run`** — full pipeline except display send; use for home testing

## CLI

```bash
node bridge.js                          # start daemon
node bridge.js start [--dry-run]        # start daemon (dry-run skips display send)
node bridge.js push <image> [--dry-run] # push one image immediately
node bridge.js schedule [--date YYYY-MM-DD]  # print resolved schedule
node bridge.js status                   # display device status
node bridge.js discover                 # find displays on network
node bridge.js network-standby [on|off] # get/set Network Standby
```

## Running Tests

```bash
npm test
# or
node --test test/*.test.js
```

Tests use Node.js built-in test runner (`node:test` + `node:assert/strict`). No external test framework. All tests use fixed reference dates (not `new Date()`) to avoid flakiness.

## Development Setup

```bash
npm ci        # install deps (use ci, not install, to respect lockfile)
cp config.json.example config.json
# Edit config.json: set display.host and display.pin
```

## Files to Never Commit

- `config.json` — contains display IP and PIN
- `.expired` — daemon-managed exclude list for rclone
- Image files (`*.jpg`, `*.jpeg`, `*.png`, `*.bmp`)

## Timezone

All scheduling uses local `America/Detroit` time. The systemd service sets `TZ=America/Detroit`. When constructing dates in JS, always use `new Date(yr, mo-1, dy, hh, mm)` (local time constructor) — never `new Date(isoString)` which would be UTC.

## Pi Deployment

1. Run `setup/setup.sh` as root
2. Configure rclone (`gdrive` remote, service account key)
3. Copy `config.json.example` → `config.json`, set display IP + PIN
4. `sudo systemctl start display-bridge`
5. Verify: `node bridge.js network-standby on && node bridge.js status`

## Deploying from Mac

```bash
./deploy.sh    # git pull + systemctl restart display-bridge, single SSH connection
```

## Remote Access

- SSH: `ssh lowertown-pi` or `ssh lt-pi` — both work (configured as aliases in `~/.ssh/config`)
- Hard reboot: TP-Link Kasa smart plug app (if SSH unreachable)
- If Tailscale offline: power-cycle via Kasa app; Tailscale auto-reconnects
- If prompted for key passphrase: run `ssh-add --apple-load-keychain` to load from macOS Keychain

## Operational Commands

```bash
# From anywhere
ssh lt-pi
journalctl -u display-bridge -n 50      # last 50 log lines
systemctl status display-bridge         # is daemon running?
systemctl status rclone-sync.timer      # is sync running?
node bridge.js schedule                 # today's resolved schedule
node bridge.js discover                 # find display IP if changed
sudo systemctl restart display-bridge   # restart after config change
```
