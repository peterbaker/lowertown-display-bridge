import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPowerProbeGate } from '../lib/power-probe-gate.js';

function makeGate(opts = {}) {
  const logs = [];
  const gate = createPowerProbeGate({ log: (m) => logs.push(m), ...opts });
  return { gate, logs };
}

test('probes are enabled to start with', () => {
  const { gate } = makeGate();
  assert.equal(gate.shouldProbe(), true);
});

test('failures below the limit still log and keep probing', () => {
  const { gate, logs } = makeGate({ maxFailures: 3 });
  gate.recordFailure('NAKError');
  gate.recordFailure('NAKError');
  assert.equal(gate.shouldProbe(), true);
  assert.equal(logs.length, 2);
});

test('hitting the failure limit disables probing and says so once', () => {
  const { gate, logs } = makeGate({ maxFailures: 3 });
  gate.recordFailure('NAKError');
  gate.recordFailure('NAKError');
  gate.recordFailure('NAKError');
  assert.equal(gate.shouldProbe(), false);
  assert.equal(logs.length, 3);
  assert.match(logs[2], /disabling post-push power probe/i);
});

test('further failures after disabling are silent — this is the journal-noise fix', () => {
  const { gate, logs } = makeGate({ maxFailures: 3 });
  for (let i = 0; i < 50; i++) gate.recordFailure('NAKError');
  assert.equal(gate.shouldProbe(), false);
  assert.equal(logs.length, 3, 'must not log once per push forever');
});

test('a success resets the failure streak', () => {
  const { gate } = makeGate({ maxFailures: 3 });
  gate.recordFailure('blip');
  gate.recordFailure('blip');
  gate.recordSuccess();
  gate.recordFailure('blip');
  gate.recordFailure('blip');
  assert.equal(gate.shouldProbe(), true, 'intermittent failures must not disable the probe');
});

test('once disabled it stays disabled even if a success is later recorded', () => {
  const { gate } = makeGate({ maxFailures: 2 });
  gate.recordFailure('NAKError');
  gate.recordFailure('NAKError');
  assert.equal(gate.shouldProbe(), false);
  gate.recordSuccess();
  assert.equal(gate.shouldProbe(), false);
});

test('the disable message names the reason so the journal explains itself', () => {
  const { gate, logs } = makeGate({ maxFailures: 1 });
  gate.recordFailure('Display rejected command (may not support it while sleeping)');
  assert.match(logs[0], /Display rejected command/);
});
