import chokidar from 'chokidar';
import { readdir, stat } from 'node:fs/promises';
import { join, extname, basename, resolve } from 'node:path';
import { parseScheduledTime, describeSchedule } from './filename.js';
import { processImage } from './process-image.js';
import { sendImage } from './display.js';

const SUPPORTED_EXT = new Set(['.jpg', '.jpeg', '.png', '.bmp']);

function isSupported(filePath) {
  return SUPPORTED_EXT.has(extname(filePath).toLowerCase());
}

export async function startBridge(config) {
  const { display, images: imgConfig } = config;
  const dropDir = resolve(imgConfig.dir);

  // filePath → setTimeout handle for future-scheduled images
  const scheduled = new Map();
  let sending = false;

  // ── Core send ────────────────────────────────────────────────────────────

  async function sendNow(filePath) {
    if (sending) {
      // Simple skip: the display holds the previous image, so losing one
      // scheduled push is acceptable. Log it so it's visible in journalctl.
      console.log(`[bridge] Send in progress — skipped: ${basename(filePath)}`);
      return;
    }
    sending = true;
    let processed;
    try {
      console.log(`[bridge] Pushing: ${basename(filePath)}`);
      processed = await processImage(filePath, imgConfig);
      await sendImage(processed.path, display);
    } catch (err) {
      console.error(`[bridge] Error: ${err.message}`);
    } finally {
      if (processed) await processed.cleanup();
      sending = false;
    }
  }

  // ── Scheduling ───────────────────────────────────────────────────────────

  function cancelSchedule(filePath) {
    if (scheduled.has(filePath)) {
      clearTimeout(scheduled.get(filePath));
      scheduled.delete(filePath);
    }
  }

  function scheduleFile(filePath) {
    cancelSchedule(filePath);

    const scheduledTime = parseScheduledTime(filePath);
    const now = new Date();

    if (!scheduledTime || scheduledTime <= now) {
      console.log(`[bridge] Queuing immediately: ${basename(filePath)}`);
      sendNow(filePath);
      return;
    }

    const delay = scheduledTime - now;
    console.log(`[bridge] Scheduled: ${basename(filePath)} — ${describeSchedule(filePath)}`);

    const timer = setTimeout(() => {
      scheduled.delete(filePath);
      console.log(`[bridge] Timer fired: ${basename(filePath)}`);
      sendNow(filePath);
    }, delay);

    // unref() lets the process exit naturally if nothing else keeps it alive
    timer.unref();
    scheduled.set(filePath, timer);
  }

  // ── Startup scan ─────────────────────────────────────────────────────────

  let entries;
  try {
    entries = await readdir(dropDir);
  } catch {
    console.error(`[bridge] Drop dir not found: ${dropDir}`);
    console.error(`         Create it with: mkdir -p ${dropDir}`);
    process.exit(1);
  }

  const images = entries
    .filter(isSupported)
    .map((f) => join(dropDir, f));

  console.log(`[bridge] Found ${images.length} image(s) in ${dropDir}`);

  // Split into past (display now) and future (schedule)
  const past = [];
  for (const img of images) {
    const t = parseScheduledTime(img);
    if (!t || t <= new Date()) {
      const s = await stat(img);
      past.push({ path: img, scheduledTime: t, mtime: s.mtimeMs });
    } else {
      scheduleFile(img); // schedule future images
    }
  }

  // Display the most recent past image (by scheduled time, then by mtime)
  if (past.length > 0) {
    past.sort((a, b) => {
      if (a.scheduledTime && b.scheduledTime) return b.scheduledTime - a.scheduledTime;
      if (a.scheduledTime) return -1;
      if (b.scheduledTime) return 1;
      return b.mtime - a.mtime;
    });
    await sendNow(past[0].path);
  }

  // ── File watcher ─────────────────────────────────────────────────────────

  const watcher = chokidar.watch(dropDir, {
    ignoreInitial: true,
    // Wait for writes to settle before triggering (important for large files
    // transferred via rclone or scp — file appears before it's fully written)
    awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 200 },
  });

  watcher.on('add', (filePath) => {
    if (!isSupported(filePath)) return;
    console.log(`[bridge] New file: ${basename(filePath)}`);
    scheduleFile(filePath);
  });

  watcher.on('change', (filePath) => {
    if (!isSupported(filePath)) return;
    console.log(`[bridge] File updated: ${basename(filePath)}`);
    // Re-evaluate: could be a content update or a rename/re-sync
    scheduleFile(filePath);
  });

  watcher.on('unlink', (filePath) => {
    if (!isSupported(filePath)) return;
    if (scheduled.has(filePath)) {
      cancelSchedule(filePath);
      console.log(`[bridge] Cancelled schedule for removed file: ${basename(filePath)}`);
    }
  });

  // ── Graceful shutdown ─────────────────────────────────────────────────────

  const shutdown = () => {
    console.log('\n[bridge] Shutting down...');
    for (const timer of scheduled.values()) clearTimeout(timer);
    watcher.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // ── Status heartbeat ──────────────────────────────────────────────────────

  const heartbeat = setInterval(() => {
    if (scheduled.size === 0) return;
    console.log(`[bridge] ${scheduled.size} image(s) scheduled:`);
    for (const [path] of scheduled) {
      console.log(`  ${basename(path)} — ${describeSchedule(path)}`);
    }
  }, 60 * 60 * 1000); // hourly
  heartbeat.unref();

  console.log(`[bridge] Watching ${dropDir} — ${scheduled.size} image(s) scheduled. Ready.`);
}
