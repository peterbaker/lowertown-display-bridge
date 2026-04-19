import { readFile, writeFile, rename } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = join(resolve(__dirname, '..'), 'config.json');

/**
 * Atomically rewrite config.json with a new display host IP.
 * Preserves all other fields exactly as they were on disk.
 */
export async function persistDisplayHost(newHost) {
  const raw = await readFile(CONFIG_FILE, 'utf8');
  const cfg = JSON.parse(raw);
  cfg.display = { ...cfg.display, host: newHost };
  const tmp = `${CONFIG_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(cfg, null, 2) + '\n');
  await rename(tmp, CONFIG_FILE);
  console.log(`[bridge] config.json updated: display.host = ${newHost}`);
}
