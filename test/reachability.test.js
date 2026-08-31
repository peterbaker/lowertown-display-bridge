import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReachabilityGate } from '../lib/reachability.js';

/**
 * Test harness: a fake timer queue so polls fire on demand instead of on a
 * wall clock. `fire()` runs the pending callback and returns its promise, so
 * tests can await the async poll body.
 */
function makeHarness({ probeResults = [], onBackOnline } = {}) {
  const pending = [];
  const logs = [];
  const probeCalls = [];
  let backOnlineCalls = 0;

  const gate = createReachabilityGate({
    probe: async () => {
      probeCalls.push(Date.now());
      const next = probeResults.shift();
      if (next instanceof Error) throw next;
      return next ?? false;
    },
    onBackOnline: async () => {
      backOnlineCalls++;
      if (onBackOnline) await onBackOnline();
    },
    pollMs: 30_000,
    setTimer: (fn) => { const t = { fn }; pending.push(t); return t; },
    clearTimer: (t) => { const i = pending.indexOf(t); if (i >= 0) pending.splice(i, 1); },
    log: (msg) => logs.push(msg),
  });

  return {
    gate,
    logs,
    get pendingCount() { return pending.length; },
    get probeCount() { return probeCalls.length; },
    get backOnlineCalls() { return backOnlineCalls; },
    /** Run the oldest scheduled poll callback and await it. */
    async fire() {
      assert.ok(pending.length > 0, 'expected a scheduled poll');
      const t = pending.shift();
      await t.fn();
    },
  };
}

// ── Basic state ──────────────────────────────────────────────────────────────

test('starts online with nothing scheduled', () => {
  const h = makeHarness();
  assert.equal(h.gate.isOffline(), false);
  assert.equal(h.pendingCount, 0);
});

test('markOffline flips state and schedules a poll', () => {
  const h = makeHarness();
  assert.equal(h.gate.markOffline(), true);
  assert.equal(h.gate.isOffline(), true);
  assert.equal(h.pendingCount, 1);
});

test('markOffline is idempotent — no duplicate pollers', () => {
  const h = makeHarness();
  h.gate.markOffline();
  assert.equal(h.gate.markOffline(), false);
  assert.equal(h.pendingCount, 1);
});

// ── Polling ──────────────────────────────────────────────────────────────────

test('poll finding the display still down stays offline and reschedules', async () => {
  const h = makeHarness({ probeResults: [false] });
  h.gate.markOffline();
  await h.fire();
  assert.equal(h.gate.isOffline(), true);
  assert.equal(h.pendingCount, 1, 'should have queued the next poll');
  assert.equal(h.backOnlineCalls, 0);
});

test('poll finding the display back up goes online and pushes catch-up once', async () => {
  const h = makeHarness({ probeResults: [false, false, true] });
  h.gate.markOffline();
  await h.fire();   // down
  await h.fire();   // down
  await h.fire();   // up
  assert.equal(h.gate.isOffline(), false);
  assert.equal(h.backOnlineCalls, 1);
  assert.equal(h.pendingCount, 0, 'polling should stop once back online');
  assert.equal(h.probeCount, 3);
});

test('a probe that throws counts as unreachable, not a crash', async () => {
  const h = makeHarness({ probeResults: [new Error('ENETUNREACH')] });
  h.gate.markOffline();
  await h.fire();
  assert.equal(h.gate.isOffline(), true);
  assert.equal(h.pendingCount, 1);
});

// ── Interaction with successful sends ────────────────────────────────────────

test('markOnline cancels the pending poll', () => {
  const h = makeHarness();
  h.gate.markOffline();
  assert.equal(h.gate.markOnline(), true);
  assert.equal(h.gate.isOffline(), false);
  assert.equal(h.pendingCount, 0);
});

test('markOnline while already online is a no-op', () => {
  const h = makeHarness();
  assert.equal(h.gate.markOnline(), false);
  assert.equal(h.pendingCount, 0);
});

test('markOnline racing an in-flight poll suppresses the catch-up push', async () => {
  // A scheduled slot can succeed on its own between the poll firing and the
  // probe resolving. The gate must not then push a redundant catch-up.
  const h = makeHarness({ probeResults: [true] });
  h.gate.markOffline();
  const t = h.gate; // capture
  const pollDone = (async () => { await h.fire(); })();
  t.markOnline();
  await pollDone;
  assert.equal(h.backOnlineCalls, 0, 'catch-up must be skipped when already back online');
});

// ── Failure isolation ────────────────────────────────────────────────────────

test('a catch-up push that throws still leaves the gate online', async () => {
  const h = makeHarness({
    probeResults: [true],
    onBackOnline: () => { throw new Error('samsung-emdx failed'); },
  });
  h.gate.markOffline();
  await h.fire();
  assert.equal(h.gate.isOffline(), false);
  assert.equal(h.pendingCount, 0);
  assert.ok(h.logs.some(l => /samsung-emdx failed/.test(l)), 'failure should be logged');
});

test('stop() clears state and pending polls', () => {
  const h = makeHarness();
  h.gate.markOffline();
  h.gate.stop();
  assert.equal(h.gate.isOffline(), false);
  assert.equal(h.pendingCount, 0);
});
