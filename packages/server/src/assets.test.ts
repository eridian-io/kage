import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { boardFor, dirFiles, loadAssets, SEA_MANIFEST, seaFiles } from './assets.ts';

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
function fakeSea(dir: string): { getRawAsset(key: string): ArrayBuffer } {
  const assets = new Map<string, Uint8Array>();
  assets.set(SEA_MANIFEST, new TextEncoder().encode(JSON.stringify(Object.keys(FILES))));
  for (const p of Object.keys(FILES)) {
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
