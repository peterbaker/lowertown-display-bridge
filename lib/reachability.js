/**
 * Reachability gate — "is the display actually powered on right now?"
 *
 * The wall display at Lowertown is on a power schedule (off overnight, back
 * around 07:45). Slot timers, however, are driven by the Orchestrator's
 * business hours, which open at 07:30. That leaves a window every morning
 * where the bridge fires pushes into a display with no power.
 *
 * Left alone, each of those pushes costs a flat 120s: samsung-emdx has no
 * fast-fail path for an unplugged panel, it just hangs until execFile's
 * timeout kills it. The error that comes back carries no ENETUNREACH/ETIMEDOUT
 * marker, so display.js's rediscovery path doesn't recognise it either. Worse,
 * a push holds the bridge's `sending` lock for that entire window, so the next
 * slot lands on "Busy — skipping" and is lost outright.
 *
 * This gate replaces that with a cheap poll. Once a send fails against an
 * unreachable host, the bridge stops attempting sends and instead probes TCP
 * 1515 every `pollMs` (a 1.5s connect test). The first successful probe means
 * power is back, so it immediately pushes whatever *should* be on the wall —
 * rather than waiting out the rest of the slot grid.
 *
 * Kept free of I/O and real timers so it can be tested directly: `probe`,
 * `onBackOnline`, and the timer functions are all injected.
 *
 * @param {object}   opts
 * @param {() => Promise<boolean>} opts.probe        - resolves true when the display answers
 * @param {() => Promise<void>}    opts.onBackOnline - push the current-display image
 * @param {number}   [opts.pollMs=30000]             - gap between probes while offline
 * @param {Function} [opts.setTimer=setTimeout]
 * @param {Function} [opts.clearTimer=clearTimeout]
 * @param {Function} [opts.log=console.log]
 */
export function createReachabilityGate({
  probe,
  onBackOnline,
  pollMs = 30_000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  log = console.log,
} = {}) {
  if (typeof probe !== 'function') {
    throw new TypeError('createReachabilityGate: probe must be a function');
  }

  let offline = false;
  let timer = null;

  function schedulePoll() {
    timer = setTimer(() => { void poll(); }, pollMs);
    // Never hold the event loop open just to wait for a display to power on.
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  function cancelPoll() {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  }

  async function poll() {
    timer = null;
    let reachable = false;
    try {
      reachable = await probe();
    } catch {
      // A throwing probe is indistinguishable from an unreachable display.
      reachable = false;
    }

    // A scheduled slot may have succeeded on its own while the probe was in
    // flight, in which case markOnline() already ran and the catch-up would
    // be a redundant second push of the same image.
    if (!offline) return;

    if (!reachable) {
      schedulePoll();
      return;
    }

    offline = false;
    log('[bridge] Display reachable again — pushing catch-up image');
    try {
      await onBackOnline?.();
    } catch (err) {
      log(`[bridge] Catch-up push after power-on failed: ${err.message}`);
    }
  }

  return {
    /** True while the display is believed to be powered off / unreachable. */
    isOffline: () => offline,

    /**
     * Record that a send failed against an unreachable display and start
     * polling for its return. Returns false if already offline.
     */
    markOffline() {
      if (offline) return false;
      offline = true;
      log(`[bridge] Display unreachable — deferring pushes, probing every ${Math.round(pollMs / 1000)}s`);
      schedulePoll();
      return true;
    },

    /**
     * Record that the display answered (a send succeeded). Returns false if
     * already online.
     */
    markOnline() {
      if (!offline) return false;
      offline = false;
      cancelPoll();
      log('[bridge] Display responding again');
      return true;
    },

    /** Shutdown hook — drop any pending poll. */
    stop() {
      offline = false;
      cancelPoll();
    },
  };
}
