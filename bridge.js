#!/usr/bin/env node
/**
 * Lowertown Display Bridge — CLI
 *
 * Usage:
 *   node bridge.js                          Start the daemon
 *   node bridge.js start [--dry-run]        Start the daemon (dry-run skips display send)
 *   node bridge.js push <image> [--dry-run] Push one image immediately
 *   node bridge.js schedule [--date DATE]   Print today's (or DATE's) resolved schedule
 *   node bridge.js status                   Show display device status
 *   node bridge.js discover                 Find displays on local network
 *   node bridge.js network-standby [on|off] Get or set Network Standby on the display
 */

import { readFileSync, existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { resolve, dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadConfig() {
  const configPath = join(__dirname, 'config.json');
  if (!existsSync(configPath)) {
    console.error('Error: config.json not found.');
    console.error('Copy config.json.example → config.json and fill in your display IP and PIN.');
    process.exit(1);
  }
  try {
    return JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (err) {
    console.error(`Error parsing config.json: ${err.message}`);
    process.exit(1);
  }
}

const [, , command = 'start', ...args] = process.argv;
const dryRun = args.includes('--dry-run');
const config = loadConfig();

switch (command) {
  // ── start ───────────────────────────────────────────────────────────────

  case 'start': {
    const { startBridge } = await import('./lib/scheduler.js');
    await startBridge(config, { dryRun });
    break;
  }

  // ── push ────────────────────────────────────────────────────────────────

  case 'push': {
    const imagePath = args.find(a => !a.startsWith('--'));
    if (!imagePath) {
      console.error('Usage: bridge.js push <image-path> [--dry-run]');
      process.exit(1);
    }
    const absPath = resolve(imagePath);
    if (!existsSync(absPath)) {
      console.error(`File not found: ${absPath}`);
      process.exit(1);
    }
    const { processImage } = await import('./lib/process-image.js');
    const { sendImage } = await import('./lib/display.js');
    console.log(`Processing ${basename(absPath)}...`);
    const processed = await processImage(absPath, config.images);
    try {
      if (dryRun) {
        console.log(`[DRY RUN] Would push ${basename(absPath)} → ${config.display.host}`);
      } else {
        await sendImage(processed.path, config.display);
      }
    } finally {
      await processed.cleanup();
    }
    break;
  }

  // ── schedule ─────────────────────────────────────────────────────────────

  case 'schedule': {
    const dateIdx = args.indexOf('--date');
    const dateArg = dateIdx !== -1 ? args[dateIdx + 1] : null;

    let targetDate = new Date();
    if (dateArg) {
      const [yr, mo, dy] = dateArg.split('-').map(Number);
      if (!yr || !mo || !dy) {
        console.error('Invalid date format. Use: --date YYYY-MM-DD');
        process.exit(1);
      }
      targetDate = new Date(yr, mo - 1, dy, 12, 0, 0); // noon on that date
    }

    const { Registry, isSupported } = await import('./lib/registry.js');
    const { dateStr, todayDow, hhmmOf } = await import('./lib/filename.js');

    const dropDir = resolve(config.images.dir);
    const registry = new Registry();

    let entries;
    try {
      entries = await readdir(dropDir);
    } catch {
      console.error(`Drop directory not found: ${dropDir}`);
      process.exit(1);
    }

    for (const name of entries) {
      const fp = join(dropDir, name);
      if (isSupported(fp)) registry.add(fp);
    }

    const DAYS_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const TIER_LABEL = ['', 'dated', 'day-of-week', 'daily'];
    const dayName = DAYS_FULL[targetDate.getDay()];
    const dateLabel = targetDate.toLocaleDateString('en-US', {
      month: 'long', day: 'numeric', year: 'numeric',
    });

    console.log(`\nSchedule for ${dayName}, ${dateLabel}:\n`);

    const hhmms = registry.allHHMMs();

    if (hhmms.length === 0) {
      console.log('  (no scheduled files in drop directory)');
    }

    for (const hhmm of hhmms) {
      const timeStr = `${hhmm.slice(0, 2)}:${hhmm.slice(2)}`;
      const winner = registry.resolveSlot(hhmm, targetDate);

      if (!winner) {
        console.log(`  ${timeStr}   (no file applies on this date)`);
        continue;
      }

      const meta = registry.getMeta(winner);
      const tierLabel = TIER_LABEL[meta.tier] ?? '?';
      console.log(`  ${timeStr}   ${basename(winner).padEnd(48)} [${tierLabel}]`);

      // Show what was overridden at this slot
      const allInSlot = registry.filesInSlot(hhmm)
        .filter(p => p !== winner)
        .sort();
      for (const overridden of allInSlot) {
        const om = registry.getMeta(overridden);
        console.log(`           ↳ overrides: ${basename(overridden)} [${TIER_LABEL[om?.tier]}]`);
      }
    }

    // Show what's currently on the display (catch-up)
    const now = new Date();
    const current = registry.resolveCurrentDisplay(now);
    const isSimulated = dateArg !== null;

    if (!isSimulated) {
      console.log('');
      if (current) {
        console.log(`  Currently on display (catch-up): ${basename(current)}`);
      } else {
        console.log('  Nothing scheduled has fired yet today');
      }
    }

    // Warn about conflicting slots
    const sorted = [...hhmms].sort();
    for (let i = 0; i < sorted.length - 1; i++) {
      const aMin = parseInt(sorted[i].slice(0, 2), 10) * 60 + parseInt(sorted[i].slice(2), 10);
      const bMin = parseInt(sorted[i + 1].slice(0, 2), 10) * 60 + parseInt(sorted[i + 1].slice(2), 10);
      if (bMin - aMin < 2) {
        console.log(
          `\n  ⚠ Slots ${sorted[i]} and ${sorted[i + 1]} are < 2 min apart — ` +
          `${sorted[i + 1]} will be skipped by the gap rule`
        );
      }
    }

    console.log('');
    break;
  }

  // ── status ───────────────────────────────────────────────────────────────

  case 'status': {
    const { status } = await import('./lib/display.js');
    await status(config.display);
    break;
  }

  // ── discover ─────────────────────────────────────────────────────────────

  case 'discover': {
    const { discover } = await import('./lib/display.js');
    await discover();
    break;
  }

  // ── network-standby ───────────────────────────────────────────────────────

  case 'network-standby': {
    const { networkStandby } = await import('./lib/display.js');
    const state = args.find(a => a === 'on' || a === 'off')?.toUpperCase();
    await networkStandby(config.display, state);
    break;
  }

  // ── unknown ───────────────────────────────────────────────────────────────

  default:
    console.error(`Unknown command: ${command}`);
    console.error('Usage: bridge.js [start|push|schedule|status|discover|network-standby]');
    process.exit(1);
}
