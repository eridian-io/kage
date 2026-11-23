import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { boardFor, dirFiles, loadAssets, PRECOMPRESSED, SEA_MANIFEST, seaFiles } from './assets.ts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kage-assets-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const FILES: Record<string, string> = {
  '/index.html': '<!doctype html><title>kage</title>',
  '/app-AbC123.js': 'console.log("board")',
  '/fonts/x.woff2': 'not really a font',
};

function writeBoard(dir: string, files: Record<string, string> = FILES): void {
  for (const [p, body] of Object.entries(files)) {
    const file = join(dir, ...p.slice(1).split('/'));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, body);
  }
}

/** A fake node:sea over the same files, as the SEA build embeds them. */
function fakeSea(
  dir: string,
  paths: string[] = Object.keys(FILES),
): { getRawAsset(key: string): ArrayBuffer } {
  const assets = new Map<string, Uint8Array>();
  assets.set(SEA_MANIFEST, new TextEncoder().encode(JSON.stringify(paths)));
  for (const p of paths) {
    assets.set(`board${p}`, new Uint8Array(readFileSync(join(dir, ...p.slice(1).split('/')))));
  }
  return {
    getRawAsset(key) {
      const a = assets.get(key);
      if (!a) throw new Error(`No asset ${key}`);
      return a.buffer.slice(a.byteOffset, a.byteOffset + a.byteLength) as ArrayBuffer;
    },
  };
}

/** A fast stand-in for brotli and gzip: the test compares maps, not compression. */
const encode = async (body: Uint8Array) => ({ gzip: body, br: body });

describe('board sources', () => {
  it('dirFiles lists URL paths and reads them', async () => {
    writeBoard(root);
    const src = dirFiles(root);
    expect((await src.list()).sort()).toEqual(Object.keys(FILES).sort());
    expect(new TextDecoder().decode(await src.read('/fonts/x.woff2'))).toBe('not really a font');
  });

  it('loadAssets(seaFiles(sea)) gives the same map as loadAssets(dir)', async () => {
    writeBoard(root);
    const fromDir = await loadAssets(root, encode);
    const fromSea = await loadAssets(seaFiles(fakeSea(root)), encode);
    expect([...fromSea.keys()].sort()).toEqual([...fromDir.keys()].sort());
    for (const [k, a] of fromDir) {
      const b = fromSea.get(k);
      expect(b).toBeDefined();
      expect(Buffer.from(b?.body ?? []).equals(Buffer.from(a.body))).toBe(true);
      expect(b?.type).toBe(a.type);
      expect(b?.etag).toBe(a.etag);
      expect(b?.immutable).toBe(a.immutable);
    }
    expect(fromSea.get('/')).toBe(fromSea.get('/index.html'));
  });

  it('a string is a folder, as before', async () => {
    writeBoard(root);
    const a = await loadAssets(root, encode);
    const b = await loadAssets(dirFiles(root), encode);
    expect([...a.keys()].sort()).toEqual([...b.keys()].sort());
  });
});

describe('precompressed sidecars (packages/web/build.ts writeCompressed)', () => {
  const hashOf = (body: string | Uint8Array) =>
    createHash('sha256').update(body).digest('base64url').slice(0, 22);
  const brOf = (body: string) =>
    new Uint8Array(brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }));
  const gzOf = (body: string) => new Uint8Array(gzipSync(body, { level: 9 }));

  /** FILES plus .br and .gz beside each compressible file and the manifest of their hashes. */
  function writeCompressedBoard(dir: string, hashes: Record<string, string> = {}): string[] {
    writeBoard(dir);
    const manifest: Record<string, string> = {};
    for (const p of ['/index.html', '/app-AbC123.js']) {
      const body = FILES[p] as string;
      const file = join(dir, ...p.slice(1).split('/'));
      writeFileSync(`${file}.br`, brOf(body));
      writeFileSync(`${file}.gz`, gzOf(body));
      manifest[p] = hashes[p] ?? hashOf(body);
    }
    writeFileSync(join(dir, PRECOMPRESSED), JSON.stringify(manifest));
    return dirFilesSync(dir);
  }
  const dirFilesSync = (dir: string) =>
    readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => `/${relative(dir, join(e.parentPath, e.name)).split(sep).join('/')}`);

  const never = async (): Promise<never> => {
    throw new Error('the encoder ran');
  };

  it('PRECOMPRESSED names the same manifest as the web build', () => {
    expect(PRECOMPRESSED).toBe('precompressed.json');
  });

  it('loadAssets uses the sidecars and never calls the encoder', async () => {
    writeCompressedBoard(root);
    const map = await loadAssets(root, never);
    for (const p of ['/index.html', '/app-AbC123.js']) {
      const body = FILES[p] as string;
      const a = map.get(p);
      expect(Buffer.from(a?.br ?? []).equals(Buffer.from(brOf(body))), p).toBe(true);
      expect(Buffer.from(a?.gzip ?? []).equals(Buffer.from(gzOf(body))), p).toBe(true);
      expect(new TextDecoder().decode(a?.body), p).toBe(body);
      // The ETag stays the raw body's.
      expect(a?.etag).toBe(`"${hashOf(body)}"`);
    }
    // A font has no sidecars: served raw, as before.
    const font = map.get('/fonts/x.woff2');
    expect(font?.br).toBe(font?.body);
    expect(map.get('/app-AbC123.js')?.immutable).toBe(true);
    expect(map.get('/')).toBe(map.get('/index.html'));
  });

  it('a sidecar whose body changed is ignored and the file is compressed at start', async () => {
    writeCompressedBoard(root, { '/index.html': hashOf('an older index.html') });
    const seen: string[] = [];
    const map = await loadAssets(root, async (body) => {
      seen.push(new TextDecoder().decode(body));
      return { gzip: new Uint8Array([1]), br: new Uint8Array([2]) };
    });
    expect(seen).toEqual([FILES['/index.html']]);
    expect([...(map.get('/index.html')?.br ?? [])]).toEqual([2]);
    expect([...(map.get('/index.html')?.gzip ?? [])]).toEqual([1]);
    // The other file's sidecars still hold.
    expect(
      Buffer.from(map.get('/app-AbC123.js')?.br ?? []).equals(
        Buffer.from(brOf(FILES['/app-AbC123.js'] as string)),
      ),
    ).toBe(true);
  });

  it('a missing sidecar, or a broken manifest, compresses at start', async () => {
    writeCompressedBoard(root);
    rmSync(join(root, 'app-AbC123.js.gz'));
    const seen: string[] = [];
    const spy = async (body: Uint8Array) => {
      seen.push(new TextDecoder().decode(body));
      return encode(body);
    };
    await loadAssets(root, spy);
    expect(seen).toEqual([FILES['/app-AbC123.js']]);
    writeFileSync(join(root, PRECOMPRESSED), '{not json');
    seen.length = 0;
    await loadAssets(root, spy);
    expect(seen.sort()).toEqual([FILES['/app-AbC123.js'], FILES['/index.html']].sort());
  });

  it('sidecars and the manifest are not served', async () => {
    writeCompressedBoard(root);
    // A stray sidecar with no manifest entry is not served either.
    writeFileSync(join(root, 'app-OLD999.js.br'), 'old');
    const map = await loadAssets(root, never);
    expect([...map.keys()].sort()).toEqual(['/', ...Object.keys(FILES)].sort());
  });

  it('only a .br or .gz suffix marks a sidecar: /xbr and /fonts/agz are served', async () => {
    writeCompressedBoard(root);
    writeFileSync(join(root, 'xbr'), 'a file whose name ends in br');
    writeFileSync(join(root, 'fonts', 'agz'), 'a file whose name ends in gz');
    const map = await loadAssets(root, encode);
    expect(new TextDecoder().decode(map.get('/xbr')?.body)).toBe('a file whose name ends in br');
    expect(map.has('/fonts/agz')).toBe(true);
  });

  it('the SEA board reads the same sidecars', async () => {
    const paths = writeCompressedBoard(root);
    const fromDir = await loadAssets(root, never);
    const fromSea = await loadAssets(seaFiles(fakeSea(root, paths)), never);
    expect([...fromSea.keys()].sort()).toEqual([...fromDir.keys()].sort());
    for (const [k, a] of fromDir) {
      const b = fromSea.get(k);
      for (const field of ['body', 'gzip', 'br'] as const) {
        expect(Buffer.from(b?.[field] ?? []).equals(Buffer.from(a[field])), `${k} ${field}`).toBe(
          true,
        );
      }
      expect(b?.etag).toBe(a.etag);
    }
  });
});

describe('boardFor', () => {
  const exists = (have: string[]) => (p: string) => have.includes(p);

  it('bundle: web/ beside the script first (the npm layout), else ../../web/dist', () => {
    const script = join(root, 'pkg', 'dist', 'kage.mjs');
    const npm = join(root, 'pkg', 'dist', 'web');
    const repo = join(root, 'pkg', 'dist', '..', '..', 'web', 'dist');
    const both = boardFor(
      { kind: 'bundle', node: 'n', script },
      exists([join(npm, 'index.html'), join(repo, 'index.html')]),
    );
    expect(both?.dir).toBe(npm);
    const repoOnly = boardFor(
      { kind: 'bundle', node: 'n', script },
      exists([join(repo, 'index.html')]),
    );
    expect(repoOnly?.dir).toBe(repo);
    expect(boardFor({ kind: 'bundle', node: 'n', script }, exists([]))).toBeNull();
  });

  it('source: src/main.ts finds packages/web/dist (F3)', () => {
    const script = join(root, 'packages', 'server', 'src', 'main.ts');
    const web = join(root, 'packages', 'server', 'src', '..', '..', 'web', 'dist');
    expect(
      boardFor({ kind: 'source', node: 'n', script }, exists([join(web, 'index.html')]))?.dir,
    ).toBe(web);
    expect(boardFor({ kind: 'source', node: 'n', script }, exists([]))).toBeNull();
  });

  it('source from the real tree resolves to packages/web/dist', () => {
    const script = join(import.meta.dirname, 'main.ts');
    const seen: string[] = [];
    boardFor({ kind: 'source', node: 'n', script }, (p) => {
      seen.push(p);
      return false;
    });
    expect(
      seen.some((p) => p === join(import.meta.dirname, '..', '..', 'web', 'dist', 'index.html')),
    ).toBe(true);
  });

  it('sea: the embedded board when its manifest lists index.html, else null', async () => {
    writeBoard(root);
    const src = boardFor({ kind: 'sea', exe: '/b/kage' }, undefined, fakeSea(root));
    expect(src).not.toBeNull();
    expect((await src?.list())?.sort()).toEqual(Object.keys(FILES).sort());
    const empty = {
      getRawAsset: (): ArrayBuffer => {
        throw new Error('no asset');
      },
    };
    expect(boardFor({ kind: 'sea', exe: '/b/kage' }, undefined, empty)).toBeNull();
  });
});
