import sharp from 'sharp';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { unlink } from 'node:fs/promises';

/**
 * Resize an image to the display's native resolution with white letterboxing.
 * Returns { path, cleanup() } — caller must call cleanup() after sending.
 */
export async function processImage(inputPath, { width = 1440, height = 2560 } = {}) {
  const tempPath = join(tmpdir(), `display-${randomBytes(4).toString('hex')}.jpg`);

  await sharp(inputPath)
    .resize(width, height, {
      fit: 'contain',
      background: { r: 255, g: 255, b: 255 },
    })
    .jpeg({ quality: 95 })
    .toFile(tempPath);

  return {
    path: tempPath,
    cleanup: () => unlink(tempPath).catch(() => {}),
  };
}
