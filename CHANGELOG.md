# Changelog

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
