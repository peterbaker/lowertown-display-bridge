import { basename, extname } from 'node:path';

const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

// Tier 1: YYYY-MM-DDTHHMM at start, followed by separator or end
// e.g. 2026-04-09T1800-jazz-night.jpg  or  2026-04-09T1800.jpg
const DATED_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})(?:[-\s]|$)/;

// Tier 2: DOW-THHMM at start, case-insensitive
// e.g. MON-T1100-monday-specials.jpg  or  mon-T1100.jpg
const WEEKLY_RE = /^(MON|TUE|WED|THU|FRI|SAT|SUN)-T(\d{2})(\d{2})(?:[-\s]|$)/i;

// Tier 3: THHMM at start (no date/DOW prefix), followed by separator or end
// e.g. T1800-happy-hour.jpg  or  T0900.png
const DAILY_RE = /^T(\d{2})(\d{2})(?:[-\s]|$)/;

/**
 * Parse a filename into a scheduling descriptor.
 *
 * @returns one of:
 *   { tier: 1, date: Date, dateStr: 'YYYY-MM-DD', hhmm: 'HHMM' }
 *   { tier: 2, dow: 'MON', hhmm: 'HHMM' }
 *   { tier: 3, hhmm: 'HHMM' }
 *   { tier: 4 }   ← immediate, no schedule
 */
export function parseFilename(filePath) {
  const stem = basename(filePath, extname(filePath));
  let m;

  // Tier 1 — specific date + time (highest priority)
  m = stem.match(DATED_RE);
  if (m) {
    const [, yr, mo, dy, hh, mm] = m.map(Number);
    // Use Date(y, m-1, d, h, min) — always local time.
    // Correct when TZ=America/Detroit is set in the systemd service.
    const date = new Date(yr, mo - 1, dy, hh, mm, 0, 0);
    return {
      tier: 1,
      date,
      dateStr: `${yr}-${pad(mo)}-${pad(dy)}`,
      hhmm: `${pad(hh)}${pad(mm)}`,
    };
  }

  // Tier 2 — day-of-week + time
  m = stem.match(WEEKLY_RE);
  if (m) {
    return {
      tier: 2,
      dow: m[1].toUpperCase(),
      hhmm: `${pad(parseInt(m[2], 10))}${pad(parseInt(m[3], 10))}`,
    };
  }

  // Tier 3 — daily recurring time
  m = stem.match(DAILY_RE);
  if (m) {
    return {
      tier: 3,
      hhmm: `${pad(parseInt(m[1], 10))}${pad(parseInt(m[2], 10))}`,
    };
  }

  // Tier 4 — immediate
  return { tier: 4 };
}

/**
 * The next Date this file should fire, relative to `from`.
 * Returns null for tier 1 if already past, or for tier 4 (no schedule).
 */
export function nextFireTime(meta, from = new Date()) {
  if (meta.tier === 1) {
    return meta.date > from ? meta.date : null;
  }
  if (meta.tier === 2) {
    const [hh, mm] = splitHHMM(meta.hhmm);
    const targetDayIdx = DAYS.indexOf(meta.dow);
    const t = new Date(from);
    t.setHours(hh, mm, 0, 0);
    let daysAhead = targetDayIdx - t.getDay();
    if (daysAhead < 0 || (daysAhead === 0 && t <= from)) daysAhead += 7;
    t.setDate(t.getDate() + daysAhead);
    return t;
  }
  if (meta.tier === 3) {
    const [hh, mm] = splitHHMM(meta.hhmm);
    const t = new Date(from);
    t.setHours(hh, mm, 0, 0);
    if (t <= from) t.setDate(t.getDate() + 1);
    return t;
  }
  return null; // tier 4
}

/**
 * True if this file's scheduled time has already passed as of `at`,
 * making it a candidate for the startup catch-up push.
 * Always false for tier 4 (immediate files are not catch-up candidates).
 */
export function wasApplicableAt(meta, at = new Date()) {
  const atHHMM = hhmmOf(at);
  if (meta.tier === 1) return meta.dateStr === dateStr(at) && meta.hhmm <= atHHMM;
  if (meta.tier === 2) return DAYS[at.getDay()] === meta.dow && meta.hhmm <= atHHMM;
  if (meta.tier === 3) return meta.hhmm <= atHHMM;
  return false;
}

/**
 * Slot key used to group files competing for the same time slot.
 * Returns null for tier 4 (not slotted).
 */
export function slotKey(meta) {
  if (meta.tier === 1) return `dated:${meta.dateStr}:${meta.hhmm}`;
  if (meta.tier === 2) return `weekly:${meta.dow}:${meta.hhmm}`;
  if (meta.tier === 3) return `daily:${meta.hhmm}`;
  return null;
}

/** Human-readable schedule description for log output. */
export function describeSchedule(meta, from = new Date()) {
  const t = nextFireTime(meta, from);
  if (!t) return 'no future fire time';
  const diff = t - from;
  const mins = Math.round(diff / 60_000);
  if (mins < 60) return `in ${mins}m (${t.toLocaleTimeString()})`;
  return `in ${(diff / 3_600_000).toFixed(1)}h (${t.toLocaleString()})`;
}

/** 'YYYY-MM-DD' string for a Date in local time. */
export function dateStr(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 'MON'...'SUN' for a Date's local day-of-week. */
export function todayDow(d = new Date()) {
  return DAYS[d.getDay()];
}

/** 'HHMM' string for a Date's local hours+minutes. */
export function hhmmOf(d = new Date()) {
  return `${pad(d.getHours())}${pad(d.getMinutes())}`;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function pad(n) {
  return String(n).padStart(2, '0');
}

function splitHHMM(hhmm) {
  return [parseInt(hhmm.slice(0, 2), 10), parseInt(hhmm.slice(2), 10)];
}
