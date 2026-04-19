import chokidar from 'chokidar';
import { readdir, unlink, appendFile, readFile } from 'node:fs/promises';
import { join, basename, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Registry, isSupported } from './registry.js';
import { wasApplicableAt, hhmmOf, dateStr } from './filename.js';
import { processImage } from './process-image.js';
import { sendImage, probeHost, findDisplayOnLan } from './display.js';
import { persistDisplayHost } from './config-store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const EXPIRED_FILE = join(PROJECT_ROOT, '.expired');

const GAP_MS = 2 * 60 * 1000;              // 2-minute minimum between scheduled pushes
const MAX_RETRY_MS = 10 * 60 * 1000;       // keep retrying for up to 10 minutes
const RETRY_DELAYS = [30_000, 60_000, 120_000]; // backoff steps in ms

/**
 * Start the bridge daemon.
 *
 * @param {object} config   - loaded from config.json
 * @param {object} options
 * @param {boolean} options.dryRun - if true, log pushes instead of sending to display
 */
export async function startBridge(config, { dryRun = false } = {}) {
  const { display, images: imgConfig } = config;
  const dropDir = resolve(imgConfig.dir);

  if (dryRun) {
    console.log('[bridge] *** DRY RUN MODE — nothing will be sent to the display ***');
  } else {
    // Boot-time reachability check — if the configured host is stale (e.g. DHCP
    // reassigned the display's IP while we were off), rediscover and persist
    // before we start scheduling anything.
    const reachable = await probeHost(display.host);
    if (reachable) {
      console.log(`[bridge] Display reachable at ${display.host}`);
    } else {
      console.warn(`[bridge] Display not reachable at ${display.host} — scanning LAN...`);
      const newHost = await findDisplayOnLan(display.host);
      if (newHost) {
        console.log(`[bridge] Found display at ${newHost} — updating config`);
        display.host = newHost;
        try { await persistDisplayHost(newHost); }
        catch (err) { console.warn(`[bridge] Could not persist new host: ${err.message}`); }
      } else {
        console.warn('[bridge] No display found on LAN; proceeding — send retries will try again.');
      }
    }
  }

  const registry = new Registry();

  // Active timers: Map<hhmm, NodeJS.Timeout>
  const timers = new Map();
  let sending = false;
  let lastScheduledPushMs = 0;
  let midnightTimer = null;

  // ── Send helpers ───────────────────────────────────────────────────────────

  async function sendNow(filePath, { isScheduled = false } = {}) {
    if (sending) {
      console.log(`[bridge] Busy — skipping: ${basename(filePath)}`);
      return;
    }
    sending = true;
    let processed;
    try {
      processed = await processImage(filePath, imgConfig);
      if (dryRun) {
        console.log(`[bridge] [DRY RUN] Would push ${basename(filePath)} → ${display.host}`);
      } else {
        console.log(`[bridge] Pushing: ${basename(filePath)}`);
        await sendImage(processed.path, display, { onHostChanged: persistDisplayHost });
        console.log(`[bridge] Done: ${basename(filePath)}`);
      }
      if (isScheduled) lastScheduledPushMs = Date.now();
    } catch (err) {
      console.error(`[bridge] Send failed (${basename(filePath)}): ${err.message}`);
      throw err;
    } finally {
      if (processed) await processed.cleanup();
      sending = false;
    }
  }

  async function sendWithRetry(filePath, scheduledAtMs) {
    const deadline = scheduledAtMs + MAX_RETRY_MS;
    let attempt = 0;
    while (true) {
      try {
        await sendNow(filePath, { isScheduled: true });
        return;
      } catch {
        const now = Date.now();
        if (now >= deadline) {
          console.error(`[bridge] Gave up after 10 min: ${basename(filePath)}`);
          return;
        }
        const delay = RETRY_DELAYS[Math.min(attempt, RETRY_DELAYS.length - 1)];
        if (now + delay >= deadline) {
          console.error(`[bridge] Retry window expired: ${basename(filePath)}`);
          return;
        }
        console.log(`[bridge] Retrying in ${delay / 1000}s...`);
        await sleep(delay);
        attempt++;
      }
    }
  }

  // ── Slot scheduling ────────────────────────────────────────────────────────

  function cancelSlot(hhmm) {
    if (timers.has(hhmm)) {
      clearTimeout(timers.get(hhmm));
      timers.delete(hhmm);
    }
  }

  function scheduleSlot(hhmm, from = new Date()) {
    cancelSlot(hhmm);
    const fireTime = dateAtHHMM(hhmm, from);
    if (fireTime <= from) return; // already passed today

    const delay = fireTime - from;
    const timer = setTimeout(async () => {
      timers.delete(hhmm);
      await fireSlot(hhmm, fireTime.getTime());
    }, delay);

    timer.unref();
    timers.set(hhmm, timer);

    const mins = Math.round(delay / 60_000);
    console.log(`[bridge] Scheduled slot ${hhmm} — fires in ${mins}m`);
  }

  async function fireSlot(hhmm, scheduledAtMs) {
    const winner = registry.resolveSlot(hhmm);
    if (!winner) {
      console.log(`[bridge] Slot ${hhmm}: no applicable file today — skipped`);
      return;
    }

    // 10-minute gap guard
    const msSinceLast = Date.now() - lastScheduledPushMs;
    if (lastScheduledPushMs > 0 && msSinceLast < GAP_MS) {
      console.warn(
        `[bridge] Slot ${hhmm}: skipped — only ${Math.round(msSinceLast / 1000)}s since last push ` +
        `(minimum gap: 10 min). File: ${basename(winner)}`
      );
      return;
    }

    console.log(`[bridge] Slot ${hhmm} → ${basename(winner)}`);
    await sendWithRetry(winner, scheduledAtMs);
  }

  // ── Slot conflict warnings ─────────────────────────────────────────────────

  function warnConflictingSlots(hhmms) {
    const sorted = [...hhmms].sort();
    for (let i = 0; i < sorted.length - 1; i++) {
      const aMin = hhmmToMinutes(sorted[i]);
      const bMin = hhmmToMinutes(sorted[i + 1]);
      if (bMin - aMin < 2) {
        console.warn(
          `[bridge] ⚠ Slots ${sorted[i]} and ${sorted[i + 1]} are < 2 min apart — ` +
          `slot ${sorted[i + 1]} will always be skipped by the gap rule`
        );
      }
    }
  }

  // ── Midnight rollover ──────────────────────────────────────────────────────

  function scheduleMidnightRollover() {
    if (midnightTimer) clearTimeout(midnightTimer);
    const now = new Date();
    const midnight = new Date(now);
    midnight.setDate(midnight.getDate() + 1);
    midnight.setHours(0, 0, 5, 0); // 00:00:05 — just into the new day
    const delay = midnight - now;
    midnightTimer = setTimeout(handleMidnightRollover, delay);
    midnightTimer.unref();
    console.log(`[bridge] Midnight rollover in ${Math.round(delay / 60_000)}m`);
  }

  async function handleMidnightRollover() {
    console.log('[bridge] Midnight rollover — rebuilding schedule');

    // Cancel all active slot timers
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();

    // Delete expired tier-1 files from Pi drop dir
    const expired = registry.expiredDatedFiles();
    for (const filePath of expired) {
      try {
        await appendFile(EXPIRED_FILE, `${basename(filePath)}\n`);
        await unlink(filePath);
        registry.remove(filePath);
        console.log(`[bridge] Expired + deleted: ${basename(filePath)}`);
      } catch (err) {
        console.error(`[bridge] Could not delete expired file ${basename(filePath)}: ${err.message}`);
      }
    }

    // Rebuild timers for the new day
    const now = new Date();
    const hhmms = registry.allHHMMs();
    warnConflictingSlots(hhmms);
    for (const hhmm of hhmms) scheduleSlot(hhmm, now);

    // Catch-up at rollover (handles edge cases like T0000 slots)
    const catchUp = registry.resolveCurrentDisplay(now);
    if (catchUp) {
      console.log(`[bridge] Rollover catch-up: ${basename(catchUp)}`);
      await sendNow(catchUp, { isScheduled: false });
    }

    scheduleMidnightRollover();
  }

  // ── Startup ────────────────────────────────────────────────────────────────

  // Load list of filenames the daemon has previously expired
  async function loadExpiredNames() {
    try {
      const text = await readFile(EXPIRED_FILE, 'utf8');
      return new Set(text.split('\n').map(l => l.trim()).filter(Boolean));
    } catch {
      return new Set();
    }
  }

  // Scan drop dir and register all eligible files
  let entries;
  try {
    entries = await readdir(dropDir);
  } catch {
    console.error(`[bridge] Drop directory not found: ${dropDir}`);
    console.error(`         Create it with: mkdir -p ${dropDir}`);
    process.exit(1);
  }

  const expiredNames = await loadExpiredNames();

  for (const name of entries) {
    if (expiredNames.has(name)) continue;
    const filePath = join(dropDir, name);
    if (isSupported(filePath)) registry.add(filePath);
  }

  console.log(`[bridge] ${registry.size} file(s) registered from ${dropDir}`);

  // Warn about conflicting slots
  const allHHMMs = registry.allHHMMs();
  warnConflictingSlots(allHHMMs);

  // Startup catch-up: push whatever should currently be on the display
  const now = new Date();
  const catchUp = registry.resolveCurrentDisplay(now);
  if (catchUp) {
    console.log(`[bridge] Startup catch-up: ${basename(catchUp)}`);
    await sendNow(catchUp, { isScheduled: false });
  } else {
    console.log('[bridge] No catch-up image (no past slot applies yet today)');
  }

  // Schedule timers for remaining future slots today
  for (const hhmm of allHHMMs) scheduleSlot(hhmm, now);

  // Schedule midnight rollover
  scheduleMidnightRollover();

  // ── Chokidar file watcher ──────────────────────────────────────────────────

  const watcher = chokidar.watch(dropDir, {
    ignoreInitial: true,
    // Wait for writes to fully settle — critical for rclone-synced files that
    // appear on disk before they are completely downloaded.
    awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 200 },
  });

  watcher.on('add', async (filePath) => {
    if (!isSupported(filePath)) return;
    const name = basename(filePath);
    if (expiredNames.has(name)) {
      console.log(`[bridge] Ignoring expired file: ${name}`);
      return;
    }
    console.log(`[bridge] New file: ${name}`);
    const meta = registry.add(filePath);
    if (!meta) return;

    if (meta.tier === 4) {
      // Immediate — push now, bypasses gap rule
      await sendNow(filePath, { isScheduled: false });
      return;
    }

    // Check if this file's slot has already passed today
    const rightNow = new Date();
    if (wasApplicableAt(meta, rightNow)) {
      // Slot has passed — push only if this is the cascade winner
      const winner = registry.resolveSlot(meta.hhmm, rightNow);
      if (winner === filePath) {
        console.log(`[bridge] Late arrival wins current slot — pushing: ${name}`);
        await sendNow(filePath, { isScheduled: true });
      }
    } else if (!timers.has(meta.hhmm)) {
      // Future slot with no timer yet — create one
      scheduleSlot(meta.hhmm, rightNow);
    }
    // If a timer already exists for this hhmm, it will call resolveSlot() at
    // fire time and automatically pick the right winner.
  });

  watcher.on('change', (filePath) => {
    if (!isSupported(filePath)) return;
    console.log(`[bridge] File updated (content change): ${basename(filePath)}`);
    // Re-register same filename — parse is unchanged but ensures clean state
    registry.remove(filePath);
    registry.add(filePath);
    // Don't re-push on content change; next scheduled slot will pick it up
  });

  watcher.on('unlink', (filePath) => {
    if (!isSupported(filePath)) return;
    const name = basename(filePath);
    console.log(`[bridge] File removed: ${name}`);
    const meta = registry.getMeta(filePath);
    registry.remove(filePath);

    // If this was the only file for a slot, cancel that slot's timer
    if (meta && meta.hhmm && timers.has(meta.hhmm)) {
      const winner = registry.resolveSlot(meta.hhmm);
      if (!winner) {
        cancelSlot(meta.hhmm);
        console.log(`[bridge] Cancelled empty slot timer: ${meta.hhmm}`);
      }
    }
  });

  // ── Graceful shutdown ──────────────────────────────────────────────────────

  const shutdown = () => {
    console.log('\n[bridge] Shutting down...');
    for (const t of timers.values()) clearTimeout(t);
    if (midnightTimer) clearTimeout(midnightTimer);
    watcher.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // ── Hourly heartbeat ───────────────────────────────────────────────────────

  const heartbeat = setInterval(() => {
    const slots = [...timers.keys()].sort();
    if (slots.length > 0) {
      console.log(`[bridge] Upcoming slots today: ${slots.join(', ')}`);
    } else {
      console.log('[bridge] No more slots scheduled today');
    }
  }, 60 * 60 * 1000);
  heartbeat.unref();

  console.log(`[bridge] Ready — ${timers.size} slot(s) scheduled today. Watching ${dropDir}`);
}

// ── Utility ────────────────────────────────────────────────────────────────

function dateAtHHMM(hhmm, from = new Date()) {
  const hh = parseInt(hhmm.slice(0, 2), 10);
  const mm = parseInt(hhmm.slice(2), 10);
  const t = new Date(from);
  t.setHours(hh, mm, 0, 0);
  return t;
}

function hhmmToMinutes(hhmm) {
  return parseInt(hhmm.slice(0, 2), 10) * 60 + parseInt(hhmm.slice(2), 10);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
