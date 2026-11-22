// @vitest-environment node
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build, FONTS } from './build.ts';

// Spec §7 allows 30 KB; phase 4 must end at 25.5 KB to leave room for phase 5 (F14).
const BUDGET = 25.5 * 1024;

let out: string;
let result: Awaited<ReturnType<typeof build>>;

beforeAll(async () => {
  out = await mkdtemp(join(tmpdir(), 'kage-build-'));
  result = await build({ outDir: out });
}, 60_000);
afterAll(() => rm(out, { recursive: true, force: true }));

const gz = async (name: string) => gzipSync(await readFile(join(out, name)), { level: 9 }).length;

describe('web build', () => {
  it('references exactly one hashed JS and one hashed CSS file', async () => {
    const html = await readFile(join(out, 'index.html'), 'utf8');
    const js = [...html.matchAll(/src="\/(app-[A-Za-z0-9]+\.js)"/g)].map((m) => m[1]);
    const css = [...html.matchAll(/href="\/(app-[A-Za-z0-9]+\.css)"/g)].map((m) => m[1]);
    expect(js).toHaveLength(1);
    expect(css).toHaveLength(1);
    expect(html.match(/\.js"/g)).toHaveLength(1);
    expect(html.match(/\.css"/g)).toHaveLength(1);
    const files = (await readdir(out)).sort();
    expect(files).toEqual([css[0], js[0], 'fonts', 'index.html', 'kage-logo-96.png'].sort());
    expect(html).toContain('<script type="module" src="/');
  });

  it('copies the fonts and preloads the two 400 weights and the logo', async () => {
    expect(FONTS).toHaveLength(6);
    for (const f of FONTS) expect(existsSync(join(out, 'fonts', f)), f).toBe(true);
    const html = await readFile(join(out, 'index.html'), 'utf8');
    const preloads = [...html.matchAll(/<link rel="preload" href="([^"]+)"/g)].map((m) => m[1]);
    expect(preloads).toEqual([
      '/fonts/geist-latin-400-normal.woff2',
      '/fonts/geist-mono-latin-400-normal.woff2',
      '/kage-logo-96.png',
    ]);
    // Every font the CSS asks for is in dist/fonts.
    const css = (await readdir(out)).find((f) => f.endsWith('.css')) as string;
    const urls = [...(await readFile(join(out, css), 'utf8')).matchAll(/url\(\/fonts\/([^)]+)\)/g)];
    expect(urls.map((m) => m[1]).sort()).toEqual([...FONTS].sort());
  });

  it('bundles exactly one copy of preact', () => {
    const copies = new Set(
      Object.keys(result.metafile.inputs)
        .map((p) => /node_modules[\\/](?:\.pnpm[\\/])?(preact@[^\\/]+)/.exec(p)?.[1])
        .filter(Boolean),
    );
    const plain = Object.keys(result.metafile.inputs).filter((p) =>
      /node_modules[\\/]preact[\\/]dist[\\/]preact\.(?:mjs|module\.js)$/.test(p),
    );
    expect(copies.size).toBe(1);
    expect(plain).toHaveLength(1);
  });

  it(`keeps the first load (index.html + JS + CSS, gzipped) within ${BUDGET} bytes`, async () => {
    const files = await readdir(out);
    const js = files.find((f) => f.endsWith('.js')) as string;
    const css = files.find((f) => f.endsWith('.css')) as string;
    const total = (await gz('index.html')) + (await gz(js)) + (await gz(css));
    console.log(`first load gzipped: ${total} bytes`);
    expect(total).toBeLessThanOrEqual(BUDGET);
  });
});
