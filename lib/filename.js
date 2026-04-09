import { basename, extname } from 'node:path';

// Matches: YYYY-MM-DDTHHMM at the start of a filename
// Examples:
//   2026-04-09T1800-happy-hour.jpg      → April 9 at 6:00 PM
//   2026-04-09T0900.png                 → April 9 at 9:00 AM
//   spring-menu.jpg                     → no timestamp, display immediately
const TIMESTAMP_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})/;

/**
 * Parse a scheduled display time from a filename.
 * Returns a Date (local system time) or null if no timestamp is present.
 *
 * The Pi must have its system timezone set to America/Detroit for local times
 * to be interpreted correctly. The TZ env var in the systemd service handles this.
 *
 * Uses new Date(year, month, day, hour, minute) which always produces local time.
 */
export function parseScheduledTime(filePath) {
  const name = basename(filePath, extname(filePath));
  const m = name.match(TIMESTAMP_RE);
  if (!m) return null;

  const [, yr, mo, dy, hr, mn] = m.map(Number);
  return new Date(yr, mo - 1, dy, hr, mn, 0, 0);
}

/**
 * Returns true if the filename has a future timestamp (should be scheduled).
 * Returns false if timestamp is past/missing (display immediately).
 */
export function isFuture(filePath) {
  const t = parseScheduledTime(filePath);
  return t !== null && t > new Date();
}

/**
 * Human-readable label for logging.
 */
export function describeSchedule(filePath) {
  const t = parseScheduledTime(filePath);
  if (!t) return 'immediately';
  const diff = t - new Date();
  if (diff <= 0) return `overdue (${t.toLocaleString()})`;
  const mins = Math.round(diff / 60_000);
  if (mins < 60) return `in ${mins}m (${t.toLocaleTimeString()})`;
  const hrs = (diff / 3_600_000).toFixed(1);
  return `in ${hrs}h (${t.toLocaleString()})`;
}
