#!/usr/bin/env node
/**
 * Lowertown Display Bridge
 *
 * Usage:
 *   node bridge.js                  Start the bridge daemon (default)
 *   node bridge.js start            Start the bridge daemon
 *   node bridge.js push <image>     Push one image immediately (for testing)
 *   node bridge.js status           Show display device status
 *   node bridge.js discover         Discover displays on the local network
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadConfig() {
  const configPath = resolve(__dirname, 'config.json');
  if (!existsSync(configPath)) {
    console.error('Error: config.json not found.');
    console.error('Copy config.json.example to config.json and fill in your display IP and PIN.');
    process.exit(1);
  }
  try {
    return JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (err) {
    console.error(`Error parsing config.json: ${err.message}`);
    process.exit(1);
  }
}

const [, , command = 'start', ...args] = process.argv;
const config = loadConfig();

switch (command) {
  case 'start': {
    const { startBridge } = await import('./lib/scheduler.js');
    await startBridge(config);
    break;
  }

  case 'push': {
    const [imagePath] = args;
    if (!imagePath) {
      console.error('Usage: bridge.js push <image-path>');
      process.exit(1);
    }
    const absPath = resolve(imagePath);
    if (!existsSync(absPath)) {
      console.error(`File not found: ${absPath}`);
      process.exit(1);
    }
    const { processImage } = await import('./lib/process-image.js');
    const { sendImage } = await import('./lib/display.js');
    console.log(`Pushing ${absPath}...`);
    const processed = await processImage(absPath, config.images);
    try {
      await sendImage(processed.path, config.display);
    } finally {
      await processed.cleanup();
    }
    break;
  }

  case 'status': {
    const { status } = await import('./lib/display.js');
    await status(config.display);
    break;
  }

  case 'discover': {
    const { discover } = await import('./lib/display.js');
    await discover();
    break;
  }

  default:
    console.error(`Unknown command: ${command}`);
    console.error('Usage: bridge.js [start|push <image>|status|discover]');
    process.exit(1);
}
