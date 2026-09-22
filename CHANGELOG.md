# Changelog

## 2026-09-22

### Changed
- **An unrecognised filename is now ignored instead of taking the wall over.**
  `parseFilename` returned `{ tier: 4 }` for any name matching none of tiers 1–3,
  and the watcher's `add` handler pushed tier 4 to the whole display the moment
  the file landed — so dragging a poster into the `Lowertown Display` Drive
  folder, the safest-looking action available, was the most destructive one. Six
  posters had each done it on arrival; one held the wall for ~7 minutes during
  cafe hours on 2026-09-22 (LOW-703).

  Tier 4 is now opt-in: only a `NOW-` / `NOW ` prefix (case-insensitive) gets an
  immediate full-screen push. Everything else parses as
  `{ tier: null, ignored: true }` — registered so it can be listed, never sent to
  the display, on `add` and on `change` alike (a Drive re-upload of the same name
  fires `change`, not `add`). Tiers 1–3, the 10-minute gap rule, and midnight
  cleanup are untouched. `node bridge.js push <image>` still pushes anything on
  purpose.

  The cost of failing closed is that a misnamed file becomes a silent no-op for
  whoever uploaded it, so both the daemon log line and a new **Ignored** section
  in `bridge.js schedule` carry the fix, not just the state:

  ```
  [bridge] Ignored (unscheduled filename): spring-menu.jpg — rename with T####/NOW- to schedule it
  ```

  The startup scan reports a count rather than staying silent, so the
  post-reboot case — a stray file already in the drop dir, someone reading
  `journalctl` wondering why nothing is showing — isn't the one case the log
  can't explain:

  ```
  [bridge] Startup: 2 files ignored (unscheduled filenames) — rename with T####/NOW- to schedule it; 'node bridge.js schedule' lists them
  ```

  That substring lives in one place (`IGNORE_REMEDY`) and is asserted literally
  in three test files. `test/ignore-unscheduled.test.js` boots the real daemon in
  dry-run against a scratch drop dir and drives chokidar with real files, so the
  guard is covered end to end rather than at the parser only; `startBridge()`
  now returns `{ watcher, registry, stop() }` to make that possible, and
  `DISPLAY_BRIDGE_CONFIG` can point the CLI at a throwaway config.

## 2026-08-31

### Fixed
- **Bridge waits for display power instead of pushing into a dead panel.** The
  wall display's power comes on at ~07:45, but LOW-473 moved the Orchestrator's
  operating window open to 07:30, so slots T0730/T0740 fired while the panel was
  unpowered. Each attempt cost a flat 120s — `samsung-emdx` has no fast-fail for
  an unplugged display, and the resulting error carries no `ENETUNREACH`/
  `ETIMEDOUT` marker for `display.js`'s rediscovery path to recognise. Because a
  send holds the `sending` lock for that whole window, the 07:40 slot landed on
  `Busy — skipping` and was lost, and the first real push of the day slipped to
  07:50.

  New `lib/reachability.js` gate: on a send failure the bridge probes TCP 1515
  directly (1.5s connect), and if the display doesn't answer it enters offline
  mode — deferring pushes rather than hanging on them — while polling every 30s.
  The first successful probe pushes `resolveCurrentDisplay()` immediately, so the
  wall updates at power-on rather than at the next slot boundary. `sendWithRetry`
  hands off to the gate instead of burning its 10-minute retry window, and a
  boot-time probe that finds nothing on the LAN now starts the daemon offline so
  a restart during the overnight power-off doesn't stall on the startup catch-up.

  Side effect: this also clears the daily ~07:45 "Pi: no display push in NNNm"
  alert from `display-scheduler/lib/pi-health.js`, which was a true reading of a
  structurally guaranteed failure.

- **Post-push power probe stops flooding the journal.** The EM32DX NAKs every
  `samsung-mdc ... power` call (confirmed directly against the panel), so the
  probe logged one failure line per push — ~90/day, none actionable. Commit
  e98a261 tried to quiet it by switching `console.warn` to `console.debug`,
  but Node's `console.debug` writes to stdout exactly like `console.log` and the
  unit sets `StandardOutput=journal`, so nothing changed. Volume was the problem,
  not level. New `lib/power-probe-gate.js` logs the first 3 consecutive failures,
  then disables the probe for the life of the process with one line explaining
  why. A success resets the streak, so an intermittent failure never disables it,
  and hardware that does answer power queries keeps the check. The genuine
  "sent but panel is in standby" signal is now a real `console.warn` again.

## 2026-05-02

Pi-side hardening paired with the orchestrator's reliability work and Mac→Pi
deadman's-switch.

### Added
- **rclone-sync `flock`.** `rclone-sync.service` now wraps `ExecStart` in
  `flock -n -E 75 /tmp/rclone-sync.lock`. The 60s timer can't fire a second rclone
  while a slow sync is still running, eliminating two-writer races on the drop dir.
  Exit code 75 (lock held) is declared a clean success so systemd doesn't log it
  as a failure.
- **Post-push MDC power probe.** After `samsung-emdx show-image` succeeds, briefly
  query MDC power state. If not "on", emit a warning to the journal — surfaces
  "image accepted into buffer but display is in standby" cases that previously
  looked healthy from the bridge's vantage point. Probe is non-fatal and can fail
  intermittently without affecting the push pipeline.

### Changed
- **`deploy.sh` reinstalls systemd units when they differ.** Previously `.service`
  edits in `setup/` stayed dormant on the Pi until manual re-run of `setup.sh`. Now
  `display-bridge.service`, `rclone-sync.service`, and `rclone-sync.timer` are
  diffed against `/etc/systemd/system`, copied if changed, then `daemon-reload` and
  timer restart run automatically.

### Fixed
- **Bridge re-pushes when the current-display file's content changes.** When the
  orchestrator regenerates a slot file (same `THHMM` filename, new bytes),
  chokidar's `change` handler used to update the registry and stop. The wall kept
  showing the stale content until the next 10-min slot fired — sometimes hours of
  broken content. The change handler now checks if the changed file is what should
  currently be displayed and calls `sendNow()` if so. The existing
  `alreadyOnDisplay()` mtime+size guard prevents spurious re-pushes when content
  didn't actually change.
