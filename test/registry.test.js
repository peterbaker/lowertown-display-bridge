import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Registry } from '../lib/registry.js';

// Helper: build a registry from bare filenames (prefixed with /drop/ to look like real paths)
function makeRegistry(...names) {
  const r = new Registry();
  for (const name of names) r.add(`/drop/${name}`);
  return r;
}

// Reference dates (avoid depending on "today" in tests)
// April 13 2026 = Monday
const MONDAY    = new Date(2026, 3, 13, 12, 0, 0);
// April 14 2026 = Tuesday
const TUESDAY   = new Date(2026, 3, 14, 12, 0, 0);
// April 9  2026 = Thursday
const THURSDAY  = new Date(2026, 3,  9, 12, 0, 0);

// ── resolveSlot — basic cascade ───────────────────────────────────────────────

test('tier 3 wins when alone', () => {
  const r = makeRegistry('T1100-lunch.jpg');
  const w = r.resolveSlot('1100', MONDAY);
  assert.ok(w?.endsWith('T1100-lunch.jpg'));
});

test('tier 2 beats tier 3 on matching DOW', () => {
  const r = makeRegistry('T1100-lunch.jpg', 'MON-T1100-monday.jpg');
  const w = r.resolveSlot('1100', MONDAY);
  assert.ok(w?.endsWith('MON-T1100-monday.jpg'), `got: ${w}`);
});

test('tier 2 does not beat tier 3 on non-matching DOW', () => {
  const r = makeRegistry('T1100-lunch.jpg', 'MON-T1100-monday.jpg');
  const w = r.resolveSlot('1100', TUESDAY);
  assert.ok(w?.endsWith('T1100-lunch.jpg'), `got: ${w}`);
});

test('tier 1 beats tier 2 and tier 3 on matching date', () => {
  const r = makeRegistry(
    'T1100-lunch.jpg',
    'MON-T1100-monday.jpg',
    '2026-04-13T1100-event.jpg',
  );
  const w = r.resolveSlot('1100', MONDAY);
  assert.ok(w?.endsWith('2026-04-13T1100-event.jpg'), `got: ${w}`);
});

test('tier 1 does not apply on wrong date', () => {
  const r = makeRegistry('T1100-lunch.jpg', '2026-04-13T1100-event.jpg');
  // April 13 event should not fire on April 14
  const w = r.resolveSlot('1100', TUESDAY);
  assert.ok(w?.endsWith('T1100-lunch.jpg'), `got: ${w}`);
});

test('tier 2 matches specific DOW correctly', () => {
  const r = makeRegistry('THU-T1200-thursday.jpg', 'T1200-daily.jpg');
  const w = r.resolveSlot('1200', THURSDAY);
  assert.ok(w?.endsWith('THU-T1200-thursday.jpg'), `got: ${w}`);
});

test('tier 2 does not match when wrong DOW', () => {
  const r = makeRegistry('THU-T1200-thursday.jpg', 'T1200-daily.jpg');
  const w = r.resolveSlot('1200', MONDAY); // Monday ≠ Thursday
  assert.ok(w?.endsWith('T1200-daily.jpg'), `got: ${w}`);
});

test('returns null when no file applies', () => {
  const r = makeRegistry('MON-T1100.jpg');
  const w = r.resolveSlot('1100', TUESDAY); // MON file on Tuesday
  assert.equal(w, null);
});

// ── resolveSlot — same-tier tie-breaking ──────────────────────────────────────

test('same-tier tier 3: alphabetically first filename wins', () => {
  const r = makeRegistry('T1800-aardvark.jpg', 'T1800-zebra.jpg');
  const w = r.resolveSlot('1800', MONDAY);
  assert.ok(w?.endsWith('T1800-aardvark.jpg'), `got: ${w}`);
});

test('same-tier tier 2: alphabetically first filename wins', () => {
  const r = makeRegistry('MON-T1100-aardvark.jpg', 'MON-T1100-zebra.jpg');
  const w = r.resolveSlot('1100', MONDAY);
  assert.ok(w?.endsWith('MON-T1100-aardvark.jpg'), `got: ${w}`);
});

test('same-tier tier 1: alphabetically first filename wins', () => {
  const r = makeRegistry('2026-04-13T1100-aardvark.jpg', '2026-04-13T1100-zebra.jpg');
  const w = r.resolveSlot('1100', MONDAY);
  assert.ok(w?.endsWith('2026-04-13T1100-aardvark.jpg'), `got: ${w}`);
});

// ── resolveCurrentDisplay (startup catch-up) ───────────────────────────────────

test('returns latest past slot winner', () => {
  const r = makeRegistry('T0900-morning.jpg', 'T1100-lunch.jpg', 'T1800-evening.jpg');
  // 2pm Monday — 09:00 and 11:00 have passed, 18:00 has not
  const now = new Date(2026, 3, 13, 14, 0, 0);
  const current = r.resolveCurrentDisplay(now);
  assert.ok(current?.endsWith('T1100-lunch.jpg'), `got: ${current}`);
});

test('returns null when no slot has fired yet today', () => {
  const r = makeRegistry('T1800-evening.jpg');
  const now = new Date(2026, 3, 13, 10, 0, 0); // 10am, before 18:00
  assert.equal(r.resolveCurrentDisplay(now), null);
});

test('catch-up respects cascade — tier 1 wins over tier 3 for past slot', () => {
  const r = makeRegistry('T1100-lunch.jpg', '2026-04-13T1100-event.jpg');
  const now = new Date(2026, 3, 13, 14, 0, 0); // 2pm, after 11am
  const current = r.resolveCurrentDisplay(now);
  assert.ok(current?.endsWith('2026-04-13T1100-event.jpg'), `got: ${current}`);
});

test('catch-up picks most recent of multiple past slots', () => {
  const r = makeRegistry('T0900-morning.jpg', 'T1300-afternoon.jpg');
  // 4pm — both 09:00 and 13:00 have passed; 13:00 is more recent
  const now = new Date(2026, 3, 13, 16, 0, 0);
  const current = r.resolveCurrentDisplay(now);
  assert.ok(current?.endsWith('T1300-afternoon.jpg'), `got: ${current}`);
});

// ── allHHMMs ──────────────────────────────────────────────────────────────────

test('allHHMMs returns sorted unique times across all tiers', () => {
  const r = makeRegistry(
    'T1800-daily.jpg',
    'MON-T1100.jpg',
    '2026-04-13T0900.jpg',
    'spring-menu.jpg', // tier 4, not slotted
  );
  const hhmms = r.allHHMMs();
  assert.deepEqual(hhmms, ['0900', '1100', '1800']);
});

test('allHHMMs: multiple files in same slot appear once', () => {
  const r = makeRegistry('T1800-a.jpg', 'T1800-b.jpg', 'MON-T1800-c.jpg');
  const hhmms = r.allHHMMs();
  assert.deepEqual(hhmms, ['1800']);
});

// ── add / remove ──────────────────────────────────────────────────────────────

test('remove cleans up slot when last file removed', () => {
  const r = makeRegistry('T1100-lunch.jpg');
  r.remove('/drop/T1100-lunch.jpg');
  assert.equal(r.resolveSlot('1100', MONDAY), null);
  assert.deepEqual(r.allHHMMs(), []);
});

test('add is idempotent — re-adding same path does not duplicate', () => {
  const r = new Registry();
  r.add('/drop/T1100.jpg');
  r.add('/drop/T1100.jpg');
  assert.equal(r.size, 1);
});

test('add returns null for unsupported extensions', () => {
  const r = new Registry();
  const result = r.add('/drop/video.mp4');
  assert.equal(result, null);
  assert.equal(r.size, 0);
});

// ── expiredDatedFiles ─────────────────────────────────────────────────────────

test('expiredDatedFiles returns only files with past dates', () => {
  const r = makeRegistry(
    '2020-01-01T1200-old.jpg',       // past
    '2099-12-31T1200-future.jpg',    // future
    'T1800-daily.jpg',               // no date
    '2026-04-13T1800-today.jpg',     // today (not expired)
  );
  const asOf = new Date(2026, 3, 13, 12, 0, 0); // April 13
  const expired = r.expiredDatedFiles(asOf);
  assert.equal(expired.length, 1);
  assert.ok(expired[0].endsWith('2020-01-01T1200-old.jpg'));
});

// ── filesInSlot ───────────────────────────────────────────────────────────────

test('filesInSlot returns all files competing for a slot', () => {
  const r = makeRegistry('T1100-a.jpg', 'MON-T1100-b.jpg', '2026-04-13T1100-c.jpg');
  const files = r.filesInSlot('1100');
  assert.equal(files.length, 3);
});

test('filesInSlot returns empty for unused slot', () => {
  const r = makeRegistry('T1800.jpg');
  assert.deepEqual(r.filesInSlot('1100'), []);
});
