import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import { networkInterfaces } from 'node:os';

const SAMSUNG_EMDX = 'samsung-emdx';

/** Find samsung-mdc binary at runtime (Pi-compatible, no hardcoded Mac path). */
function findSamsungMdc() {
  // Try PATH first
  try {
    const p = execFileSync('which', ['samsung-mdc'], { encoding: 'utf8' }).trim();
    if (p) return p;
  } catch {}

  // Common install locations (pip --user on Pi, global, etc.)
  const candidates = [
    `${process.env.HOME}/.local/bin/samsung-mdc`,
    '/usr/local/bin/samsung-mdc',
    '/usr/bin/samsung-mdc',
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }

  throw new Error(
    'samsung-mdc not found. Install with: pip3 install python-samsung-mdc'
  );
}

let SAMSUNG_MDC;
try {
  SAMSUNG_MDC = findSamsungMdc();
} catch (err) {
  // Defer error until mdc is actually called (push still works without it)
  SAMSUNG_MDC = null;
}

function exec(cmd, args, timeout = 120_000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout }, (error, stdout, stderr) => {
      if (error) {
        const msg = stderr?.includes('NAKError')
          ? 'Display rejected command (may not support it while sleeping)'
          : `${error.message}\n${stderr}`;
        reject(new Error(`${cmd} failed: ${msg}`));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

function mdcArgs({ host, pin }) {
  if (!SAMSUNG_MDC) throw new Error('samsung-mdc not found. Install with: pip3 install python-samsung-mdc');
  return [SAMSUNG_MDC, '-p', pin, `0@${host}`];
}

/** Error codes that suggest the display moved to a new IP (DHCP) or is unreachable. */
const NETWORK_ERROR_CODES = [
  'EHOSTUNREACH', 'EHOSTDOWN', 'ENETUNREACH',
  'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND',
];

function isNetworkError(err) {
  const msg = err?.message ?? '';
  return NETWORK_ERROR_CODES.some(code => msg.includes(code));
}

async function sendImageDirect(imagePath, host, pin) {
  const args = ['show-image', '--host', host, '--pin', pin, '--image', imagePath];
  console.log(`[display] Sending to ${host}...`);
  const start = Date.now();
  const output = await exec(SAMSUNG_EMDX, args);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`[display] Sent in ${elapsed}s`);
  if (output) console.log(`[display] ${output}`);
  // Soft post-push verification. The send command can succeed (image accepted
  // into the display's buffer) while the panel is in standby and showing
  // nothing visible. Surface that as a warning so a stale display gets
  // diagnosed in the journal instead of looking healthy.
  await verifyPowerOn({ host, pin }).catch(() => { /* non-fatal */ });
}

async function verifyPowerOn({ host, pin }) {
  if (!SAMSUNG_MDC) return;
  try {
    const [cmd, ...baseArgs] = mdcArgs({ host, pin });
    const output = await exec(cmd, [...baseArgs, 'power'], 8_000);
    if (!/\bon\b/i.test(output)) {
      console.warn(`[display] ⚠ Image sent but power state is "${output}" (expected ON) — display may be in standby`);
    }
  } catch (err) {
    // Don't escalate — sendImageDirect already succeeded and that's the
    // signal that matters most. Just leave a breadcrumb.
    console.warn(`[display] Post-push power probe failed: ${err.message.split('\n')[0]}`);
  }
}

/**
 * Send an image to the display. On network-level errors, auto-rediscover
 * the display's IP on the LAN and retry once. If the IP changed, mutates
 * `display.host` in place and invokes `onHostChanged(newHost)` so the caller
 * can persist the update.
 *
 * imagePath must be absolute.
 */
export async function sendImage(imagePath, display, { onHostChanged } = {}) {
  try {
    await sendImageDirect(imagePath, display.host, display.pin);
    return;
  } catch (err) {
    if (!isNetworkError(err)) throw err;

    console.warn(`[display] ${display.host} unreachable — attempting rediscovery...`);
    const newHost = await findDisplayOnLan(display.host);
    if (!newHost) {
      console.warn('[display] Rediscovery found no displays; giving up.');
      throw err;
    }

    console.log(`[display] Found display at ${newHost}; retrying push...`);
    display.host = newHost;
    if (onHostChanged) {
      try { await onHostChanged(newHost); }
      catch (cbErr) { console.warn(`[display] onHostChanged failed: ${cbErr.message}`); }
    }
    await sendImageDirect(imagePath, newHost, display.pin);
  }
}

/**
 * Scan the local /24 for port 1515 and return the first reachable IP
 * that is NOT `excludeHost`. Returns null if nothing found.
 * Quieter than `discover()` — suitable for daemon use on send failures.
 */
export async function findDisplayOnLan(excludeHost = null) {
  const found = await discover();
  return found.find(ip => ip !== excludeHost) ?? null;
}

/** Discover displays by scanning the local /24 subnet for port 1515. */
export async function discover() {
  // Derive subnet from the first non-loopback IPv4 address
  const ifaces = networkInterfaces();
  let subnet = null;
  for (const addrs of Object.values(ifaces)) {
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) {
        subnet = addr.address.split('.').slice(0, 3).join('.');
        break;
      }
    }
    if (subnet) break;
  }
  if (!subnet) {
    console.log('Could not determine local subnet.');
    return [];
  }

  console.log(`Scanning ${subnet}.0/24 for port 1515...`);

  const ips = Array.from({ length: 254 }, (_, i) => `${subnet}.${i + 1}`);
  const found = [];
  const CONCURRENCY = 30;

  for (let i = 0; i < ips.length; i += CONCURRENCY) {
    const batch = ips.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(ip => probePort(ip, 1515, 500)));
    for (let j = 0; j < batch.length; j++) {
      if (results[j]) found.push(batch[j]);
    }
    process.stdout.write(`\r  Checked ${Math.min(i + CONCURRENCY, 254)}/254...`);
  }
  process.stdout.write('\r' + ' '.repeat(30) + '\r');

  if (found.length === 0) {
    console.log('No devices found with port 1515 open.');
  } else {
    console.log(`Found ${found.length} device(s) with port 1515 open:`);
    for (const ip of found) console.log(`  ${ip}`);
  }
  return found;
}

/**
 * Quick TCP connection test to `host:1515`. Returns true if reachable, false otherwise.
 * Use before scheduling timers so we can rediscover proactively at boot.
 */
export function probeHost(host, timeoutMs = 1500) {
  return probePort(host, 1515, timeoutMs);
}

function probePort(ip, port, timeoutMs) {
  return new Promise(resolve => {
    const socket = createConnection({ host: ip, port, timeout: timeoutMs });
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('error', () => { socket.destroy(); resolve(false); });
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
  });
}

/** Get or set Network Standby. Call with no state to query. */
export async function networkStandby(display, state) {
  const [cmd, ...baseArgs] = mdcArgs(display);
  const args = [...baseArgs, 'network_standby'];
  if (state) args.push(state);
  const output = await exec(cmd, args, 15_000);
  console.log(`[display] Network standby: ${output}`);
  return output;
}

/** Get display power/input status. */
export async function status(display) {
  const [cmd, ...baseArgs] = mdcArgs(display);
  const output = await exec(cmd, [...baseArgs, 'status'], 15_000);
  console.log(`[display] Status:\n${output}`);
  return output;
}

/** Get display power state. */
export async function power(display, state) {
  const [cmd, ...baseArgs] = mdcArgs(display);
  const args = [...baseArgs, 'power'];
  if (state) args.push(state);
  const output = await exec(cmd, args, 15_000);
  console.log(`[display] Power: ${output}`);
  return output;
}
