/**
 * Post-push power probe suppression.
 *
 * After a successful `show-image`, display.js asks the panel over MDC whether
 * it is actually powered on — the send can succeed (image accepted into the
 * buffer) while the panel sits in standby showing nothing. That check is worth
 * having on hardware that answers it.
 *
 * The EM32DX does not. Every `samsung-mdc ... power` call against it returns
 * NAKError, so the probe emitted one failure line per push, forever — roughly
 * 90 lines a day in the journal, none of them actionable. Commit e98a261 tried
 * to quiet it by switching `console.warn` to `console.debug`, but Node's
 * `console.debug` writes to stdout exactly like `console.log`, and the unit
 * sets `StandardOutput=journal`, so nothing changed.
 *
 * Volume is the actual problem, not level. This gate logs the first few
 * failures (so a genuine regression is still visible after a restart), then
 * disables the probe for the life of the process with one line saying why.
 * A success resets the streak, so an intermittent failure never disables it.
 *
 * @param {object}   [opts]
 * @param {number}   [opts.maxFailures=3] - consecutive failures before giving up
 * @param {Function} [opts.log=console.warn]
 */
export function createPowerProbeGate({ maxFailures = 3, log = console.warn } = {}) {
  let consecutiveFailures = 0;
  let disabled = false;

  return {
    /** False once the panel has proven it doesn't answer power queries. */
    shouldProbe: () => !disabled,

    /** The panel answered — clear the streak. */
    recordSuccess() {
      consecutiveFailures = 0;
    },

    /**
     * The probe failed. Logs while under the limit, then disables itself and
     * explains once. Silent thereafter.
     */
    recordFailure(reason) {
      if (disabled) return;
      consecutiveFailures++;
      if (consecutiveFailures < maxFailures) {
        log(`[display] Post-push power probe failed: ${reason}`);
        return;
      }
      disabled = true;
      log(
        `[display] Post-push power probe failed: ${reason} — ` +
        `disabling post-push power probe for this process after ` +
        `${consecutiveFailures} consecutive failures (this display does not ` +
        `answer MDC power queries). Pushes are unaffected; restart the service ` +
        `to re-enable.`
      );
    },

    /** Introspection for tests and diagnostics. */
    stats: () => ({ consecutiveFailures, disabled }),
  };
}
