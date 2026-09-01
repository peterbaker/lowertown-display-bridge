# Changelog

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
