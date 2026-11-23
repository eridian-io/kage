import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, extname, join, relative, sep } from 'node:path';
import * as nodeSea from 'node:sea';
import { promisify } from 'node:util';
import { brotliCompress, constants, gzip } from 'node:zlib';
import type { RunMode } from './install/runtime.ts';

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
const RAW = new Set(['.woff2', '.png', '.jpg', '.jpeg', '.webp']);

/**
 * The web build's manifest of precompressed sidecars (packages/web/build.ts PRECOMPRESSED):
 * { "/<path>": "<the body's hash, as in the ETag>" }, with <file>.br and <file>.gz beside each.
 */
export const PRECOMPRESSED = 'precompressed.json';
const SIDECAR = /.(br|gz)$/;

/** The build's manifest, or an empty one when it is missing or not a map of strings. */
async function readManifest(board: BoardFiles, paths: string[]): Promise<Map<string, string>> {
  if (!paths.includes(`/${PRECOMPRESSED}`)) return new Map();
  try {
    const m: unknown = JSON.parse(new TextDecoder().decode(await board.read(`/${PRECOMPRESSED}`)));
    if (typeof m !== 'object' || m === null || Array.isArray(m)) return new Map();
    return new Map(
      Object.entries(m).filter((e): e is [string, string] => typeof e[1] === 'string'),
    );
  } catch {
    return new Map();
  }
}

/**
 * esbuild's hashed names (packages/web/build.ts HASHED): the board, the terminal, the lazy diff and
 * palette, and the chunks they share. Their content never changes under the same name.
 */
const HASHED = /^\/(app|term|diff|palette|chunk)-[A-Za-z0-9]+\.(js|css)$/;

const br = promisify(brotliCompress);
const gz = promisify(gzip);

export type Compress = (body: Uint8Array) => Promise<{ gzip: Uint8Array; br: Uint8Array }>;

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

/** The built board's files, by URL path ('/index.html', '/fonts/…'). */
export interface BoardFiles {
  list(): Promise<string[]>;
  read(urlPath: string): Promise<Uint8Array>;
  /** The folder, for a board read from disk (`node --watch` reloads it). */
  dir?: string;
}

/** The board in a folder (packages/web/dist, or web/ in the npm package). */
export function dirFiles(dir: string): BoardFiles {
  return {
    dir,
    async list() {
      const entries = await readdir(dir, { withFileTypes: true, recursive: true });
      return entries
        .filter((e) => e.isFile())
        .map((e) => `/${relative(dir, join(e.parentPath, e.name)).split(sep).join('/')}`);
    },
    async read(urlPath) {
      return new Uint8Array(await readFile(join(dir, ...urlPath.slice(1).split('/'))));
    },
  };
}

/**
 * The SEA asset that lists the embedded board: a JSON array of URL paths ('/index.html', …).
 * Each file is the asset `board` + its URL path (the release build writes both, Task 6).
 */
export const SEA_MANIFEST = 'board/manifest.json';

type SeaAssets = { getRawAsset(key: string): ArrayBuffer };

/** The board embedded in the SEA (node:sea by default). */
export function seaFiles(sea: SeaAssets = nodeSea): BoardFiles {
  const bytes = (key: string) => new Uint8Array(sea.getRawAsset(key).slice(0));
  return {
    async list() {
      const paths: unknown = JSON.parse(new TextDecoder().decode(bytes(SEA_MANIFEST)));
      if (
        !Array.isArray(paths) ||
        !paths.every((p) => typeof p === 'string' && p.startsWith('/'))
      ) {
        throw new Error(`${SEA_MANIFEST} is not a list of paths`);
      }
      return paths as string[];
    },
    async read(urlPath) {
      return bytes(`board${urlPath}`);
    },
  };
}

/**
 * Where this run mode's board is, or null when it has none (no index.html):
 * - sea: embedded;
 * - bundle: web/ beside the script (the npm package), else ../../web/dist (the repo's build);
 * - source: ../../web/dist from src/main.ts, which is packages/web/dist.
 */
export function boardFor(
  m: RunMode,
  exists: (p: string) => boolean = existsSync,
  sea: SeaAssets = nodeSea,
): BoardFiles | null {
  if (m.kind === 'sea') {
    try {
      const paths: unknown = JSON.parse(
        new TextDecoder().decode(new Uint8Array(sea.getRawAsset(SEA_MANIFEST))),
      );
      return Array.isArray(paths) && paths.includes('/index.html') ? seaFiles(sea) : null;
    } catch {
      return null;
    }
  }
  const dir = dirname(m.script);
  const dirs =
    m.kind === 'bundle'
      ? [join(dir, 'web'), join(dir, '..', '..', 'web', 'dist')]
      : [join(dir, '..', '..', 'web', 'dist')];
  const found = dirs.find((d) => exists(join(d, 'index.html')));
  return found === undefined ? null : dirFiles(found);
}

/**
 * Reads the built board (a folder, or the SEA's embedded files) into memory, compressed (brotli
 * quality 11, gzip level 9), except formats that are compressed already (fonts, images), which
 * stay raw. Keys are URL paths ('/index.html', '/fonts/…'); '/' maps to index.html.
 *
 * The web build writes each file's brotli and gzip beside it and a manifest of the bodies' hashes
 * (performance P1): a file whose hash the manifest holds, with both sidecars there, is read as it
 * is. The sidecars and the manifest are never served as files. Any other file (a watch build
 * writes no sidecars; a body changed since the build) is compressed here, at start.
 *
 * Compressing at start: one file and one encoder at a time (R100). Run side by side, the brotli and gzip encoders
 * share libuv's 4 pool threads and, under MALLOC_ARENA_MAX=2, the same two malloc arenas; with
 * glibc's dynamic mmap threshold their large buffers land in those arenas, and how the threads
 * interleave decides how fragmented the arenas are left and how much freed memory stays
 * resident. Measured on the shipped bundle with no sessions: 71.5–76.5 MB idle concurrently,
 * 71.5–72.1 MB one at a time.
 */
export async function loadAssets(
  src: BoardFiles | string,
  encode: Compress = compress,
): Promise<Map<string, Asset>> {
  const board = typeof src === 'string' ? dirFiles(src) : src;
  const map = new Map<string, Asset>();
  const paths = await board.list();
  const have = new Set(paths);
  const built = await readManifest(board, paths);
  for (const path of paths) {
    if (SIDECAR.test(path) || path === `/${PRECOMPRESSED}`) continue;
    const body = await board.read(path);
    const hash = createHash('sha256').update(body).digest('base64url').slice(0, 22);
    const ext = extname(path).toLowerCase();
    const sidecars = built.get(path) === hash && have.has(`${path}.br`) && have.has(`${path}.gz`);
    // Same bytes as the body, so serveAsset never picks an encoding for these.
    const encoded = RAW.has(ext)
      ? { gzip: body, br: body }
      : sidecars
        ? { gzip: await board.read(`${path}.gz`), br: await board.read(`${path}.br`) }
        : await encode(body);
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
