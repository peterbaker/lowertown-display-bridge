import { extname } from 'node:path';
import { parseFilename, slotKey, dateStr, todayDow } from './filename.js';

const SUPPORTED_EXT = new Set(['.jpg', '.jpeg', '.png', '.bmp']);

export function isSupported(filePath) {
  return SUPPORTED_EXT.has(extname(filePath).toLowerCase());
}

/**
 * Central registry of all tracked files in the drop directory.
 *
 * Groups files by time slot (HHMM) and implements cascade resolution:
 *   Tier 1 (dated for today) > Tier 2 (DOW matching today) > Tier 3 (daily)
 *   Same-tier ties broken alphabetically (first filename wins).
 */
export class Registry {
  // Map<absolutePath, parsedMeta>
  #files = new Map();

  // Map<slotKey, Set<absolutePath>>
  // Keys: 'dated:YYYY-MM-DD:HHMM' | 'weekly:DOW:HHMM' | 'daily:HHMM'
  #slots = new Map();

  /** Register a file. Safe to call multiple times (idempotent). */
  add(filePath) {
    if (!isSupported(filePath)) return null;
    this.remove(filePath); // clear stale entry if re-adding
    const meta = parseFilename(filePath);
    this.#files.set(filePath, meta);
    const key = slotKey(meta);
    if (key) {
      if (!this.#slots.has(key)) this.#slots.set(key, new Set());
      this.#slots.get(key).add(filePath);
    }
    return meta;
  }

  /** Unregister a file. Safe to call on unknown paths. */
  remove(filePath) {
    const meta = this.#files.get(filePath);
    if (!meta) return;
    this.#files.delete(filePath);
    const key = slotKey(meta);
    if (key) {
      const slot = this.#slots.get(key);
      if (slot) {
        slot.delete(filePath);
        if (slot.size === 0) this.#slots.delete(key);
      }
    }
  }

  /** Get parsed metadata for a file path. Returns undefined if not registered. */
  getMeta(filePath) {
    return this.#files.get(filePath);
  }

  /** Total number of registered files. */
  get size() {
    return this.#files.size;
  }

  /** All [filePath, meta] pairs. */
  entries() {
    return this.#files.entries();
  }

  /**
   * All distinct HHMM values across all slots (sorted ascending).
   * E.g. ['0900', '1100', '1800']
   */
  allHHMMs() {
    const hhmms = new Set();
    for (const key of this.#slots.keys()) {
      hhmms.add(key.split(':').pop()); // last segment of 'tier:...:HHMM'
    }
    return [...hhmms].sort();
  }

  /**
   * All files in a given HHMM slot across all tiers.
   * Used by the schedule command to show overrides.
   */
  filesInSlot(hhmm) {
    const result = [];
    for (const [key, paths] of this.#slots) {
      if (key.split(':').pop() !== hhmm) continue;
      for (const p of paths) result.push(p);
    }
    return result;
  }

  /** All tier-4 (immediate) file paths. */
  immediateFiles() {
    return [...this.#files.entries()]
      .filter(([, m]) => m.tier === 4)
      .map(([p]) => p);
  }

  /**
   * Tier-1 files whose date is strictly before today (i.e., expired).
   * Deleted from Pi at midnight rollover.
   */
  expiredDatedFiles(asOf = new Date()) {
    const today = dateStr(asOf);
    return [...this.#files.entries()]
      .filter(([, m]) => m.tier === 1 && m.dateStr < today)
      .map(([p]) => p);
  }

  /**
   * Cascade resolution for a given HHMM slot.
   *
   * Priority order:
   *   1. Tier 1 files whose dateStr matches today
   *   2. Tier 2 files whose dow matches today's day-of-week
   *   3. Tier 3 files (always applicable)
   *
   * Within a tier, alphabetically first file path wins.
   *
   * @param {string} hhmm   - e.g. '1800'
   * @param {Date}   today  - reference date (defaults to now; pass a specific
   *                          date for schedule simulation or testing)
   * @returns {string|null} winning absolute file path, or null if nothing applies
   */
  resolveSlot(hhmm, today = new Date()) {
    const todayStr = dateStr(today);
    const todayDOW = todayDow(today);

    const byTier = { 1: [], 2: [], 3: [] };

    for (const [key, paths] of this.#slots) {
      if (key.split(':').pop() !== hhmm) continue;
      for (const filePath of paths) {
        const meta = this.#files.get(filePath);
        if (!meta) continue;
        if (meta.tier === 1 && meta.dateStr === todayStr) byTier[1].push(filePath);
        else if (meta.tier === 2 && meta.dow === todayDOW) byTier[2].push(filePath);
        else if (meta.tier === 3) byTier[3].push(filePath);
      }
    }

    for (const tier of [1, 2, 3]) {
      if (byTier[tier].length > 0) return byTier[tier].sort()[0];
    }

    return null;
  }

  /**
   * Find the file that should currently be on the display.
   *
   * Walks all HHMM slots that have already passed today, resolves each via
   * the cascade, returns the winner from the latest (most recent) slot.
   * Used by startup catch-up after a Pi reboot.
   *
   * @param {Date} now - reference time (defaults to current time)
   * @returns {string|null} file path, or null if nothing has fired today yet
   */
  resolveCurrentDisplay(now = new Date()) {
    const nowHHMM = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
    let latestHHMM = null;
    let latestWinner = null;

    for (const hhmm of this.allHHMMs()) {
      if (hhmm > nowHHMM) continue; // hasn't fired yet today
      const winner = this.resolveSlot(hhmm, now);
      if (winner && (!latestHHMM || hhmm > latestHHMM)) {
        latestHHMM = hhmm;
        latestWinner = winner;
      }
    }

    return latestWinner;
  }
}
