# Lowertown Display Bridge — Claude Code Instructions

## What This Is

A Raspberry Pi bridge that syncs images from a Google Drive folder (`pete@lowertowna2.com`) and pushes them to a Samsung EM32DX e-paper display at Lowertown Bar & Cafe over local WiFi. Fully headless and remotely managed via SSH + Tailscale.

## Architecture

### Filename-based scheduling cascade (4 tiers, highest priority first)

| Tier | Format | Example | Fires |
|------|--------|---------|-------|
| 1 | `YYYY-MM-DDTHHMM[-desc].ext` | `2026-04-09T1800-jazz-night.jpg` | Once, on that exact date+time |
| 2 | `DOW-THHMM[-desc].ext` | `MON-T1100-lunch.jpg` | Every matching weekday at that time |
| 3 | `THHMM[-desc].ext` | `T1100-daily-lunch.jpg` | Every day at that time |
| 4 | `NOW-[desc].ext` | `NOW-snow-day-closed.jpg` | **IMMEDIATELY on arrival** — full-screen, needs Pete's approval |
| — | *anything else* | `spring-menu.jpg` | **Ignored. Never pushed.** Logged with the fix |

DOW: `MON TUE WED THU FRI SAT SUN` (case-insensitive in filename). `NOW-` / `NOW ` is also case-insensitive.

**An unrecognised filename is ignored, not pushed.** An immediate takeover is opt-in: the name must start with `NOW-`. Anything else that matches no tier is registered and logged, never sent to the screen. `parseFilename` returns `{ tier: null, ignored: true }` for those, and both the `add` and the `change` watcher paths bail out before `sendNow` — a Drive re-upload of the same name fires `change`, not `add`, so both have to hold the line. Before this (LOW-716) any unrecognised name was tier 4 and took the wall over on arrival; six posters each did it, one for ~7 minutes during cafe hours (LOW-703).

**If your image never appeared, run `node bridge.js schedule` on the Pi and read the Ignored section** before re-uploading.

**`Lowertown Display` is a trigger directory, not storage. Nothing goes inside it, at any depth, unless it is meant to appear on the wall.** The Pi syncs that one folder as the `display-bridge` service account with `--drive-shared-with-me`, and a subfolder inherits the parent's share while sitting under the synced path — so a subfolder is exactly as live as the top level. A poster you are not putting on the wall goes to the Drive folder `Lowertown Event Posters` (`1aLCPW0rnJWAcwF0rsil-Pu2V-W2_domn`), which is inert because that service account cannot see it and it is not on the sync path. Never share it with that account.

**The remedy string is load-bearing.** The daemon log line and the CLI Ignored section must both contain the literal substring `rename with T####/NOW- to schedule it` — otherwise a misnamed file is a silent no-op for whoever uploaded it. It lives in one place (`IGNORE_REMEDY` in `lib/filename.js`) and is asserted literally in `test/filename.test.js`, `test/registry.test.js`, and `test/ignore-unscheduled.test.js`. Do not reword it.

```
[bridge] Ignored (unscheduled filename): spring-menu.jpg — rename with T####/NOW- to schedule it
```

**Separator**: the character between the time token and description can be `-` or a space — `T1100-lunch.jpg` and `T1100 lunch.jpg` parse identically.

**Tie-breaking**: when multiple files compete for the same tier+slot, alphabetically first filename wins.

### Core modules

- `lib/filename.js` — 4-tier regex parser; `parseFilename`, `nextFireTime`, `wasApplicableAt`, `slotKey`, `dateStr`, `todayDow`, `hhmmOf`, plus the ignore surface: `isIgnored`, `ignoreMessage`, `IGNORE_REMEDY`
- `lib/registry.js` — file registry; `Registry` class with `add/remove`, `resolveSlot`, `resolveCurrentDisplay`, `allHHMMs`, `filesInSlot`, `immediateFiles`, `ignoredFiles`, `expiredDatedFiles`; plus `formatIgnoredSection` for the CLI
- `lib/scheduler.js` — daemon; one `setTimeout` per HHMM slot, gap enforcement (10 min), retry logic (10 min window), midnight rollover, chokidar file watcher
- `lib/reachability.js` — offline gate; `createReachabilityGate` defers pushes while the display is unpowered and pushes a catch-up the moment TCP 1515 answers
- `lib/power-probe-gate.js` — self-disables the post-push MDC power probe after 3 consecutive failures (the EM32DX never answers it)
- `lib/display.js` — `samsung-emdx` + `samsung-mdc` wrappers (already complete)
- `lib/process-image.js` — `sharp` resize to 1440×2560 portrait with white letterbox (already complete)

### Key behaviors

- **One timer per HHMM slot** — cascade resolution (`resolveSlot`) happens at fire time, so late-arriving files compete correctly
- **10-minute gap** — scheduled pushes must be 10+ minutes apart (enforced at fire time); tier-4 `NOW-` files bypass this
- **Fails closed on unknown names** — an unrecognised filename is registered, logged with the remedy, and never pushed, on `add` and on `change` alike
- **Startup catch-up** — on daemon start, pushes whichever past slot's winner is most recent (handles Pi reboots)
- **Power-aware pushes** — the wall display is on a power schedule (off overnight, back ~07:45) while slots start at 07:30. A failed send is probed against TCP 1515; if the panel doesn't answer, the bridge enters offline mode, defers pushes instead of hanging 120s on each, and polls every 30s. The first answer triggers an immediate `resolveCurrentDisplay()` push, so the wall updates at power-on, not at the next slot
- **Midnight rollover** — deletes expired tier-1 files from Pi, adds them to `.expired` so rclone doesn't re-download, rebuilds timers
- **`--dry-run`** — full pipeline except display send; use for home testing

## CLI

```bash
node bridge.js                          # start daemon
node bridge.js start [--dry-run]        # start daemon (dry-run skips display send)
node bridge.js push <image> [--dry-run] # push one image immediately
node bridge.js schedule [--date YYYY-MM-DD]  # print resolved schedule + the Ignored section
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

`test/ignore-unscheduled.test.js` is the exception to "unit tests only": it boots the real daemon in `--dry-run` against a scratch drop directory and drives chokidar with real files, because the thing under test is the wiring between the watcher and `sendNow`, not the parser. It takes ~20s (chokidar's `awaitWriteFinish` is 2s per file) and needs `sharp`. `startBridge()` returns `{ watcher, registry, stop() }` so those tests can shut it down without signalling the process.

## Development Setup

```bash
npm ci        # install deps (use ci, not install, to respect lockfile)
cp config.json.example config.json
# Edit config.json: set display.host and display.pin
```

`DISPLAY_BRIDGE_CONFIG=/path/to/config.json` overrides the config location for a single run — useful for a scratch dry-run on the Mac without touching the Pi's real `config.json`.

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
