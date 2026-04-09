import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseFilename,
  nextFireTime,
  wasApplicableAt,
  slotKey,
  dateStr,
  hhmmOf,
} from '../lib/filename.js';

// ── parseFilename ─────────────────────────────────────────────────────────────

test('tier 1: parses dated file with description', () => {
  const m = parseFilename('2026-04-09T1800-jazz-night.jpg');
  assert.equal(m.tier, 1);
  assert.equal(m.dateStr, '2026-04-09');
  assert.equal(m.hhmm, '1800');
  assert.ok(m.date instanceof Date);
});

test('tier 1: parses dated file without description', () => {
  const m = parseFilename('2026-04-09T1800.jpg');
  assert.equal(m.tier, 1);
  assert.equal(m.hhmm, '1800');
});

test('tier 1: parses zero-padded times', () => {
  const m = parseFilename('2026-04-09T0900.png');
  assert.equal(m.tier, 1);
  assert.equal(m.hhmm, '0900');
});

test('tier 2: parses DOW file with description', () => {
  const m = parseFilename('MON-T1100-monday-specials.jpg');
  assert.equal(m.tier, 2);
  assert.equal(m.dow, 'MON');
  assert.equal(m.hhmm, '1100');
});

test('tier 2: DOW is case-insensitive', () => {
  const m = parseFilename('mon-T1100.jpg');
  assert.equal(m.tier, 2);
  assert.equal(m.dow, 'MON');
});

test('tier 2: all DOW values parse correctly', () => {
  for (const dow of ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']) {
    const m = parseFilename(`${dow}-T1200.jpg`);
    assert.equal(m.tier, 2, `${dow} should be tier 2`);
    assert.equal(m.dow, dow);
  }
});

test('tier 3: parses daily file with description', () => {
  const m = parseFilename('T1800-happy-hour.jpg');
  assert.equal(m.tier, 3);
  assert.equal(m.hhmm, '1800');
});

test('tier 3: parses daily file without description', () => {
  const m = parseFilename('T0900.png');
  assert.equal(m.tier, 3);
  assert.equal(m.hhmm, '0900');
});

test('tier 3: parses .bmp', () => {
  const m = parseFilename('T1200.bmp');
  assert.equal(m.tier, 3);
});

test('tier 4: no timestamp prefix', () => {
  const m = parseFilename('spring-menu.jpg');
  assert.equal(m.tier, 4);
});

test('tier 4: T in middle of name does not trigger tier 3', () => {
  const m = parseFilename('great-T-shirt.jpg');
  assert.equal(m.tier, 4);
});

test('tier 4: MONDAY (full word) does not trigger tier 2', () => {
  const m = parseFilename('MONDAY-special.jpg');
  assert.equal(m.tier, 4);
});

test('tier 4: T18001 (5 digits after T) does not trigger tier 3', () => {
  const m = parseFilename('T18001-ambiguous.jpg');
  assert.equal(m.tier, 4);
});

test('tier 1 takes priority over tier 3 prefix match', () => {
  // Make sure dated regex wins — T1800 is not a prefix of a dated filename
  const m = parseFilename('2026-04-09T1800.jpg');
  assert.equal(m.tier, 1);
});

// ── slotKey ───────────────────────────────────────────────────────────────────

test('slotKey: tier 1', () => {
  const m = parseFilename('2026-04-09T1800.jpg');
  assert.equal(slotKey(m), 'dated:2026-04-09:1800');
});

test('slotKey: tier 2', () => {
  const m = parseFilename('MON-T1100.jpg');
  assert.equal(slotKey(m), 'weekly:MON:1100');
});

test('slotKey: tier 3', () => {
  const m = parseFilename('T1800.jpg');
  assert.equal(slotKey(m), 'daily:1800');
});

test('slotKey: tier 4 returns null', () => {
  const m = parseFilename('immediate.jpg');
  assert.equal(slotKey(m), null);
});

// ── nextFireTime ──────────────────────────────────────────────────────────────

test('nextFireTime: tier 1 future date returns that date', () => {
  const m = parseFilename('2099-12-31T2359.jpg');
  const t = nextFireTime(m, new Date('2026-01-01T00:00:00'));
  assert.ok(t instanceof Date);
  assert.ok(t > new Date('2026-01-01'));
});

test('nextFireTime: tier 1 past date returns null', () => {
  const m = parseFilename('2020-01-01T1200.jpg');
  const t = nextFireTime(m, new Date('2026-01-01'));
  assert.equal(t, null);
});

test('nextFireTime: tier 3 returns today if not yet passed', () => {
  const from = new Date(2026, 3, 9, 9, 0, 0); // 9am April 9
  const m = parseFilename('T1800.jpg');
  const t = nextFireTime(m, from);
  assert.equal(t.getHours(), 18);
  assert.equal(t.getDate(), 9);
  assert.equal(t.getMonth(), 3); // April
});

test('nextFireTime: tier 3 returns tomorrow if already passed', () => {
  const from = new Date(2026, 3, 9, 20, 0, 0); // 8pm April 9
  const m = parseFilename('T1800.jpg');
  const t = nextFireTime(m, from);
  assert.equal(t.getHours(), 18);
  assert.equal(t.getDate(), 10); // April 10
});

test('nextFireTime: tier 2 returns next Monday from a Tuesday', () => {
  // April 14 2026 is a Tuesday
  const from = new Date(2026, 3, 14, 12, 0, 0);
  const m = parseFilename('MON-T1100.jpg');
  const t = nextFireTime(m, from);
  // Next Monday should be April 20 2026
  assert.equal(t.getDay(), 1); // Monday
  assert.ok(t > from);
});

test('nextFireTime: tier 2 returns today if it is the right DOW and time is future', () => {
  // April 13 2026 is a Monday, 9am
  const from = new Date(2026, 3, 13, 9, 0, 0);
  const m = parseFilename('MON-T1100.jpg');
  const t = nextFireTime(m, from);
  assert.equal(t.getDay(), 1); // Monday
  assert.equal(t.getDate(), 13); // same day
});

test('nextFireTime: tier 4 returns null', () => {
  const m = parseFilename('immediate.jpg');
  assert.equal(nextFireTime(m), null);
});

// ── wasApplicableAt ───────────────────────────────────────────────────────────

// April 9 2026 = Thursday
const THU_9_PM = new Date(2026, 3, 9, 21, 0, 0);  // 9pm Thu Apr 9
const THU_5_PM = new Date(2026, 3, 9, 17, 0, 0);  // 5pm Thu Apr 9

test('wasApplicableAt: tier 1 same date, time passed → true', () => {
  const m = parseFilename('2026-04-09T1800.jpg');
  assert.equal(wasApplicableAt(m, THU_9_PM), true);
});

test('wasApplicableAt: tier 1 same date, time not yet passed → false', () => {
  const m = parseFilename('2026-04-09T1800.jpg');
  assert.equal(wasApplicableAt(m, THU_5_PM), false);
});

test('wasApplicableAt: tier 1 different date → false', () => {
  const m = parseFilename('2026-04-09T1800.jpg');
  const nextDay = new Date(2026, 3, 10, 21, 0, 0);
  assert.equal(wasApplicableAt(m, nextDay), false);
});

test('wasApplicableAt: tier 2 matching DOW and time passed → true', () => {
  // April 9 is Thursday
  const m = parseFilename('THU-T1800.jpg');
  assert.equal(wasApplicableAt(m, THU_9_PM), true);
});

test('wasApplicableAt: tier 2 non-matching DOW → false', () => {
  const m = parseFilename('MON-T1800.jpg');
  assert.equal(wasApplicableAt(m, THU_9_PM), false);
});

test('wasApplicableAt: tier 3 time passed → true', () => {
  const m = parseFilename('T1800.jpg');
  assert.equal(wasApplicableAt(m, THU_9_PM), true);
});

test('wasApplicableAt: tier 3 time not yet passed → false', () => {
  const m = parseFilename('T1800.jpg');
  assert.equal(wasApplicableAt(m, THU_5_PM), false);
});

test('wasApplicableAt: tier 4 → always false', () => {
  const m = parseFilename('immediate.jpg');
  assert.equal(wasApplicableAt(m, THU_9_PM), false);
});

// ── helpers ───────────────────────────────────────────────────────────────────

test('dateStr returns correct format', () => {
  const d = new Date(2026, 3, 9); // April 9 2026
  assert.equal(dateStr(d), '2026-04-09');
});

test('hhmmOf returns correct format', () => {
  const d = new Date(2026, 3, 9, 18, 30, 0);
  assert.equal(hhmmOf(d), '1830');
});

test('hhmmOf pads single-digit hours', () => {
  const d = new Date(2026, 3, 9, 9, 5, 0);
  assert.equal(hhmmOf(d), '0905');
});
