import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { brotliCompress, constants, gzip } from 'node:zlib';

export interface Asset {
  body: Uint8Array;
  gzip: Uint8Array;
  br: Uint8Array;
  type: string;
  etag: string;
  immutable: boolean;
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/** Formats that are compressed already: served raw, never brotli/gzip. */
const PRECOMPRESSED = new Set(['.woff2', '.png', '.jpg', '.jpeg', '.webp']);

/**
 * esbuild's hashed names (packages/web/build.ts HASHED): the board, the terminal, the lazy diff and
 * palette, and the chunks they share. Their content never changes under the same name.
 */
const HASHED = /^\/(app|term|diff|palette|chunk)-[A-Za-z0-9]+\.(js|css)$/;

const br = promisify(brotliCompress);
const gz = promisify(gzip);

type Compress = (body: Uint8Array) => Promise<{ gzip: Uint8Array; br: Uint8Array }>;

/** gzip, then brotli: one encoder at a time (see loadAssets). */
async function compress(body: Uint8Array): Promise<{ gzip: Uint8Array; br: Uint8Array }> {
  const g = await gz(body, { level: 9 });
  const b = await br(body, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 11,
      [constants.BROTLI_PARAM_SIZE_HINT]: body.length,
    },
  });
  return { gzip: new Uint8Array(g), br: new Uint8Array(b) };
}

/** Every file under `dir`, recursively, as absolute paths. */
async function files(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries.filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));
}

/**
 * Reads the built board into memory, precompressed (brotli quality 11, gzip level 9),
 * except formats that are compressed already (fonts, images), which stay raw.
 * Keys are URL paths ('/index.html', '/fonts/…'); '/' maps to index.html.
 *
 * One file and one encoder at a time (R100). Run side by side, the brotli and gzip encoders
 * share libuv's 4 pool threads and, under MALLOC_ARENA_MAX=2, the same two malloc arenas; with
 * glibc's dynamic mmap threshold their large buffers land in those arenas, and how the threads
 * interleave decides how fragmented the arenas are left and how much freed memory stays
 * resident. Measured on the shipped bundle with no sessions: 71.5–76.5 MB idle concurrently,
 * 71.5–72.1 MB one at a time.
 */
export async function loadAssets(
  distDir: string,
  encode: Compress = compress,
): Promise<Map<string, Asset>> {
  const map = new Map<string, Asset>();
  for (const file of await files(distDir)) {
    const path = `/${relative(distDir, file).split(sep).join('/')}`;
    const body = new Uint8Array(await readFile(file));
    const hash = createHash('sha256').update(body).digest('base64url').slice(0, 22);
    const ext = extname(file).toLowerCase();
    // Same bytes as the body, so serveAsset never picks an encoding for these.
    const encoded = PRECOMPRESSED.has(ext) ? { gzip: body, br: body } : await encode(body);
    map.set(path, {
      body,
      ...encoded,
      type: TYPES[ext] ?? 'application/octet-stream',
      etag: `"${hash}"`,
      immutable: HASHED.test(path),
    });
  }
  const index = map.get('/index.html');
  if (index) map.set('/', index);
  return map;
}
