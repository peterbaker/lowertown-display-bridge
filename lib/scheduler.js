import chokidar from 'chokidar';
import { readdir, unlink, appendFile, readFile, writeFile, stat, rename } from 'node:fs/promises';
import { join, basename, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Registry, isSupported } from './registry.js';
import { wasApplicableAt, hhmmOf, dateStr } from './filename.js';
import { processImage } from './process-image.js';
import { sendImage, probeHost, findDisplayOnLan } from './display.js';
import { persistDisplayHost } from './config-store.js';
import { createReachabilityGate } from './reachability.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const EXPIRED_FILE = join(PROJECT_ROOT, '.expired');
const LAST_PUSH_FILE = join(PROJECT_ROOT, '.last-push.json');

/**
 * Tracks what's currently on the display across daemon restarts.
 * Used to skip pushes that would show the same image that's already up.
 */
async function readLastPush() {
  try {
    return JSON.parse(await readFile(LAST_PUSH_FILE, 'utf8'));
  } catch {
    return null;
  }
}

async function writeLastPush(state) {
  const tmp = `${LAST_PUSH_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2) + '\n');
  await rename(tmp, LAST_PUSH_FILE);
}

/** Is the source file identical (by name + mtime + size) to what's currently on the display? */
async function alreadyOnDisplay(filePath) {
  const last = await readLastPush();
  if (!last) return false;
  if (last.filename !== basename(filePath)) return false;
  try {
    const st = await stat(filePath);
    return st.mtimeMs === last.mtimeMs && st.size === last.size;
  } catch {
    return false;
  }
}

const GAP_MS = 2 * 60 * 1000;              // 2-minute minimum between scheduled pushes
const MAX_RETRY_MS = 10 * 60 * 1000;       // keep retrying for up to 10 minutes
const RETRY_DELAYS = [30_000, 60_000, 120_000]; // backoff steps in ms
const OFFLINE_POLL_MS = 30 * 1000;         // probe cadence while the display has no power

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
  let bootUnreachable = false;

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
        console.warn('[bridge] No display found on LAN; proceeding — waiting for it to come back.');
        // Almost always an overnight/early-morning restart while the wall's
        // power is still off. Start in offline mode so the startup catch-up
        // below doesn't burn a 120s samsung-emdx timeout on a dead panel.
        bootUnreachable = true;
      }
    }
  }

  const registry = new Registry();

  // Tracks whether the wall display currently has power. While offline the
  // bridge defers pushes instead of hanging 120s per attempt, and pushes the
  // current-display image the moment the panel answers again.
  const reachability = createReachabilityGate({
    probe: () => probeHost(display.host),
    onBackOnline: async () => {
      const winner = registry.resolveCurrentDisplay(new Date());
      if (!winner) {
        console.log('[bridge] Power-on catch-up: no slot applies yet today');
        return;
      }
      console.log(`[bridge] Power-on catch-up: ${basename(winner)}`);
      await sendNow(winner, { isScheduled: false });
    },
    pollMs: OFFLINE_POLL_MS,
    log: (msg) => console.log(msg),
  });
  if (bootUnreachable) reachability.markOffline();

  // Active timers: Map<hhmm, NodeJS.Timeout>
  const timers = new Map();
  let sending = false;
  let lastScheduledPushMs = 0;
  let midnightTimer = null;

  // Per-filename push cooldown — when rclone re-delivers a file whose slot
  // has already passed today (common during 20-min Orchestrator lookahead
  // cycles), chokidar emits an `add` event. Without this guard, the Bridge
  // would re-push as a "late arrival" every time rclone refreshes content.
  // Reset at midnight so files can re-fire the next day.
  const REPUSH_COOLDOWN_MS = 10 * 60 * 1000;
  const lastPushedAtMs = new Map(); // basename -> timestamp

  // ── Send helpers ───────────────────────────────────────────────────────────

  async function sendNow(filePath, { isScheduled = false } = {}) {
    if (sending) {
      console.log(`[bridge] Busy — skipping: ${basename(filePath)}`);
      return;
    }
    // Display has no power — don't hang 120s per attempt. The reachability
    // gate is already polling and will push the right image on power-on.
    if (!dryRun && reachability.isOffline()) {
      console.log(`[bridge] Display offline — deferring: ${basename(filePath)}`);
      return;
    }
    // Skip if the display is already showing this exact file (same name + mtime + size).
    // Persisted across daemon restarts, so deploys don't trigger gratuitous refreshes.
    if (!dryRun && await alreadyOnDisplay(filePath)) {
      console.log(`[bridge] ${basename(filePath)} already on display — skipping`);
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
        try {
          const st = await stat(filePath);
          await writeLastPush({
            filename: basename(filePath),
            mtimeMs: st.mtimeMs,
            size: st.size,
            pushedAt: new Date().toISOString(),
          });
        } catch (err) {
          console.warn(`[bridge] Failed to record last-push state: ${err.message}`);
        }
      }
      if (isScheduled) lastScheduledPushMs = Date.now();
      lastPushedAtMs.set(basename(filePath), Date.now());
      if (!dryRun) reachability.markOnline();
    } catch (err) {
      console.error(`[bridge] Send failed (${basename(filePath)}): ${err.message}`);
      // Distinguish "panel is unplugged" from a genuine push error. A dead
      // panel surfaces only as samsung-emdx's 120s execFile timeout — the
      // message carries no ENETUNREACH/ETIMEDOUT for display.js to key on —
      // so ask the socket directly instead of parsing the error.
      if (!dryRun && !(await probeHost(display.host))) {
        reachability.markOffline();
      }
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
        // The display is powered off; retrying just costs another 120s
        // timeout each. The reachability gate takes it from here and will
        // push the current-display winner as soon as power returns.
        if (reachability.isOffline()) {
          console.log(`[bridge] Display offline — power-on watcher will catch up: ${basename(filePath)}`);
          return;
        }
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

    // Reset the per-file push cooldown so today's files can fire again tomorrow
    lastPushedAtMs.clear();

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
      // Rclone re-delivery guard — don't re-push something we already pushed recently
      const lastPush = lastPushedAtMs.get(name);
      if (lastPush && Date.now() - lastPush < REPUSH_COOLDOWN_MS) {
        const secsAgo = Math.round((Date.now() - lastPush) / 1000);
        console.log(`[bridge] Re-sync of ${name} (pushed ${secsAgo}s ago) — skipping duplicate push`);
        return;
      }
      // Only push if this file is what SHOULD currently be on the display —
      // i.e. the winner of the most recent past slot, not just any past slot.
      // This guards against rclone delivering a stale past-slot file (e.g. a
      // T1320 image arriving at 15:55) that lost the race to the Orchestrator's
      // own stale cleanup. Without this check, the Bridge would push a 2-hour-
      // old image to the wall.
      const currentDisplay = registry.resolveCurrentDisplay(rightNow);
      if (currentDisplay === filePath) {
        console.log(`[bridge] Late arrival is the current display — pushing: ${name}`);
        await sendNow(filePath, { isScheduled: true });
      } else {
        console.log(`[bridge] ${name}: past slot ${meta.hhmm}, not the current display — no push`);
      }
    } else if (!timers.has(meta.hhmm)) {
      // Future slot with no timer yet — create one
      scheduleSlot(meta.hhmm, rightNow);
    }
    // If a timer already exists for this hhmm, it will call resolveSlot() at
    // fire time and automatically pick the right winner.
  });

  watcher.on('change', async (filePath) => {
    if (!isSupported(filePath)) return;
    console.log(`[bridge] File updated (content change): ${basename(filePath)}`);
    // Re-register same filename — parse is unchanged but ensures clean state
    registry.remove(filePath);
    registry.add(filePath);
    // If the changed file is what should currently be on the display, push
    // the new content. alreadyOnDisplay() compares mtime+size against
    // .last-push.json, so a real content change won't be filtered out.
    // This catches the case where the Orchestrator regenerates a slot file
    // (same THHMM filename, different bytes) — without this re-push, the
    // wall keeps showing the stale content until the next slot fires.
    const currentDisplay = registry.resolveCurrentDisplay(new Date());
    if (currentDisplay === filePath) {
      console.log(`[bridge] Current display content changed — re-pushing: ${basename(filePath)}`);
      try {
        await sendNow(filePath, { isScheduled: false });
      } catch (err) {
        console.error(`[bridge] Re-push on content change failed: ${err.message}`);
      }
    }
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
    reachability.stop();
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
