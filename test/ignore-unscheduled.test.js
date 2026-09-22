/**
 * LOW-716 — an unrecognised filename must be logged with the fix and never
 * reach the wall, on `add` and on `change` alike.
 *
 * These run the real daemon in --dry-run against a scratch drop directory, so
 * they fail if the guard is lost anywhere between chokidar and sendNow — not
 * just if parseFilename changes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const execFileP = promisify(execFile);
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const REMEDY = 'rename with T####/NOW- to schedule it';
const POSTER = '2026-10-11 - Lowertown Book Club.png';

// chokidar's awaitWriteFinish is 2s; give each expectation room on a loaded box.
const WAIT_MS = 20_000;

async function makeDropDir() {
  const dir = await mkdtemp(join(tmpdir(), 'display-bridge-test-'));
  return dir;
}

async function writeImage(dir, name, { tint = 40 } = {}) {
  const buf = await sharp({
    create: { width: 40, height: 60, channels: 3, background: { r: tint, g: tint, b: tint } },
  }).png().toBuffer();
  await writeFile(join(dir, name), buf);
}

function makeConfig(dropDir) {
  return {
    // 127.0.0.1 is never contacted: every test below runs in dry-run.
    display: { host: '127.0.0.1', pin: '000000', timezone: 'America/Detroit' },
    images: { dir: dropDir, width: 144, height: 256 },
  };
}

/**
 * Start the daemon in dry-run, capturing every console line it writes.
 * The capture stays installed until stop() — watcher events arrive long after
 * startBridge() resolves, and those are exactly the lines under test.
 */
async function startCapturing(dropDir) {
  const lines = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  const capture = (...a) => { lines.push(a.join(' ')); };
  console.log = capture; console.warn = capture; console.error = capture;

  const { startBridge } = await import('../lib/scheduler.js');
  let handle;
  try {
    handle = await startBridge(makeConfig(dropDir), { dryRun: true });
  } catch (err) {
    Object.assign(console, orig);
    throw err;
  }

  return {
    lines,
    text: () => lines.join('\n'),
    async stop() {
      try { await handle.stop(); } finally { Object.assign(console, orig); }
    },
  };
}

/** Resolve once `predicate(text)` holds, or throw after WAIT_MS. */
async function waitFor(bridge, predicate, what) {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    if (predicate(bridge.text())) return;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${what}. Log was:\n${bridge.text()}`);
}

async function settle(ms = 3500) {
  await new Promise(r => setTimeout(r, ms));
}

test('add: an unrecognised filename is logged with the remedy and never pushed', async (t) => {
  const dropDir = await makeDropDir();
  const bridge = await startCapturing(dropDir);
  t.after(async () => { await bridge.stop(); await rm(dropDir, { recursive: true, force: true }); });

  await writeImage(dropDir, POSTER);

  await waitFor(bridge, txt => txt.includes('Ignored (unscheduled filename)'), 'the ignore log line');

  const text = bridge.text();
  assert.ok(
    text.includes(`[bridge] Ignored (unscheduled filename): ${POSTER} — ${REMEDY}`),
    `exact ignore line missing. Log was:\n${text}`
  );
  assert.ok(text.includes(REMEDY), 'log line must carry the remedy, not just the state');
  assert.ok(!text.includes('Would push'), `nothing may be pushed. Log was:\n${text}`);
});

test('add: the six LOW-703 posters are all ignored and none is pushed', async (t) => {
  const posters = [
    '2026-10-11 - Lowertown Book Club.png',
    '2026-09-13 - Lowertown Book Club.png',
    '2026-10-02 - Fall Menu Launch.png',
    '2026-08-06 - Tour de France Femmes Stage 6 Watch Party.png',
    '2026-09-03 - Dont Tell Comedy.png',
    '2026-08-13 - Dont Tell Comedy.png',
  ];
  const dropDir = await makeDropDir();
  const bridge = await startCapturing(dropDir);
  t.after(async () => { await bridge.stop(); await rm(dropDir, { recursive: true, force: true }); });

  for (const name of posters) await writeImage(dropDir, name);

  await waitFor(
    bridge,
    txt => posters.every(n => txt.includes(`Ignored (unscheduled filename): ${n} — ${REMEDY}`)),
    'an ignore line for all six posters'
  );
  assert.ok(!bridge.text().includes('Would push'), `nothing may be pushed. Log was:\n${bridge.text()}`);
});

test('add: NOW- files still push immediately, in either case', async (t) => {
  const dropDir = await makeDropDir();
  const bridge = await startCapturing(dropDir);
  t.after(async () => { await bridge.stop(); await rm(dropDir, { recursive: true, force: true }); });

  await writeImage(dropDir, 'NOW-test.png');
  await waitFor(bridge, txt => txt.includes('Would push NOW-test.png'), 'the NOW-test.png dry-run push');

  // Distinct stem: macOS is case-insensitive, so 'now-test.png' would collide.
  await writeImage(dropDir, 'now-snow-day.png', { tint: 90 });
  await waitFor(bridge, txt => txt.includes('Would push now-snow-day.png'), 'the lowercase now- dry-run push');

  assert.ok(!bridge.text().includes('Ignored (unscheduled filename)'), 'NOW- files must not be ignored');
});

test('change: re-uploading an ignored file does not push it', async (t) => {
  const dropDir = await makeDropDir();
  // Present before the daemon starts, so the first event is `change`, not `add`
  // — this is what a Drive re-upload of the same name looks like on the Pi.
  await writeImage(dropDir, POSTER);
  const bridge = await startCapturing(dropDir);
  t.after(async () => { await bridge.stop(); await rm(dropDir, { recursive: true, force: true }); });

  assert.ok(!bridge.text().includes('Would push'), 'startup catch-up must not pick an ignored file');

  await writeImage(dropDir, POSTER, { tint: 200 }); // same name, new bytes
  await waitFor(bridge, txt => txt.includes('File updated (content change)'), 'the change event');
  await settle();

  const text = bridge.text();
  assert.ok(
    text.includes(`[bridge] Ignored (unscheduled filename): ${POSTER} — ${REMEDY}`),
    `change path must log the ignore with the remedy. Log was:\n${text}`
  );
  assert.ok(!text.includes('Would push'), `change path must not push. Log was:\n${text}`);
});

test('tier 1-3 filenames are unaffected — scheduled, not ignored', async (t) => {
  const dropDir = await makeDropDir();
  const bridge = await startCapturing(dropDir);
  t.after(async () => { await bridge.stop(); await rm(dropDir, { recursive: true, force: true }); });

  await writeImage(dropDir, 'T2359-menu.png');
  await waitFor(bridge, txt => txt.includes('New file: T2359-menu.png'), 'the T2359 add event');
  await settle();

  const text = bridge.text();
  assert.ok(!text.includes('Ignored (unscheduled filename)'), `T2359-menu.png must schedule. Log was:\n${text}`);
});

test('bridge.js schedule prints an Ignored section carrying the remedy', async (t) => {
  const dropDir = await makeDropDir();
  t.after(() => rm(dropDir, { recursive: true, force: true }));

  await writeImage(dropDir, POSTER);
  await writeImage(dropDir, 'T0830-menu.png');
  const configPath = join(dropDir, 'config.json');
  await writeFile(configPath, JSON.stringify(makeConfig(dropDir)));

  const { stdout } = await execFileP(process.execPath, ['bridge.js', 'schedule'], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, DISPLAY_BRIDGE_CONFIG: configPath },
  });

  assert.ok(
    stdout.includes(REMEDY),
    `schedule output must carry the remedy. Got:\n${stdout}`
  );
  assert.ok(stdout.includes(`Ignored (never pushed) — ${REMEDY}:`), `Got:\n${stdout}`);
  assert.ok(stdout.includes(POSTER), `ignored file must be listed. Got:\n${stdout}`);
  assert.ok(stdout.includes('08:30'), `scheduled file must still be listed. Got:\n${stdout}`);
});
