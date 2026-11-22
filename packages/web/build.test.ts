// @vitest-environment node
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import * as esbuild from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build, FONTS } from './build.ts';

// Spec §7 allows 30 KB; phase 4 must end at 25.5 KB to leave room for phase 5 (F14).
const BUDGET = 25.5 * 1024;
/** The terminal chunk, JS plus CSS gzipped (spec §7: about 90 KB; the plan: at most 100 KB). */
const TERM_BUDGET = 100 * 1024;
/** term-loader.ts, the only terminal code in the first load (F14). */
const LOADER_BUDGET = 600;

let out: string;
let result: Awaited<ReturnType<typeof build>>;

beforeAll(async () => {
  out = await mkdtemp(join(tmpdir(), 'kage-build-'));
  result = await build({ outDir: out });
}, 60_000);
afterAll(() => rm(out, { recursive: true, force: true }));

const gz = async (name: string) => gzipSync(await readFile(join(out, name)), { level: 9 }).length;
const built = async (re: RegExp) => (await readdir(out)).find((f) => re.test(f)) as string;

describe('web build', () => {
  it('references one hashed JS and one hashed CSS file; only the kage-term meta names the terminal', async () => {
    const html = await readFile(join(out, 'index.html'), 'utf8');
    const js = [...html.matchAll(/src="\/(app-[A-Za-z0-9]+\.js)"/g)].map((m) => m[1]);
    const css = [...html.matchAll(/href="\/(app-[A-Za-z0-9]+\.css)"/g)].map((m) => m[1]);
    expect(js).toHaveLength(1);
    expect(css).toHaveLength(1);
    // Every script and link that names code names an app- file; none names the terminal.
    const refs = [...html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="([^"]+)"/g)].map(
      (m) => m[1] as string,
    );
    expect(refs.filter((r) => /\.(js|css)$/.test(r))).toEqual([`/${css[0]}`, `/${js[0]}`]);
    expect(html).not.toContain('modulepreload');
    expect(html).not.toMatch(/<(?:script|link)\b[^>]*term-/);
    const meta =
      /<meta name="kage-term" content="\/(term-[A-Za-z0-9]+\.js) \/(term-[A-Za-z0-9]+\.css)" \/>/.exec(
        html,
      );
    expect(meta).not.toBeNull();
    const [, termJs, termCss] = meta as RegExpExecArray;
    const files = (await readdir(out)).sort();
    expect(files).toEqual(
      [css[0], js[0], termJs, termCss, 'fonts', 'index.html', 'kage-logo-96.png'].sort(),
    );
    expect(html).toContain('<script type="module" src="/');
  });

  it('hashes both builds by name (assets.ts caches these names immutable; app.test.ts)', async () => {
    const hashed = (await readdir(out)).filter((f) => /^(app|term)-/.test(f));
    expect(hashed).toHaveLength(4);
    for (const f of hashed) expect(f).toMatch(/^(app|term)-[A-Za-z0-9]+\.(js|css)$/);
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
    const css = await built(/^app-.*\.css$/);
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
    const js = await built(/^app-.*\.js$/);
    const css = await built(/^app-.*\.css$/);
    const total = (await gz('index.html')) + (await gz(js)) + (await gz(css));
    console.log(`first load gzipped: ${total} bytes`);
    expect(total).toBeLessThanOrEqual(BUDGET);
    // xterm stays out of it.
    expect(await readFile(join(out, js), 'utf8')).not.toContain('xterm');
  });

  it(`keeps the terminal chunk (JS + CSS, gzipped) within ${TERM_BUDGET} bytes`, async () => {
    const js = await built(/^term-.*\.js$/);
    const css = await built(/^term-.*\.css$/);
    const total = (await gz(js)) + (await gz(css));
    console.log(`terminal chunk gzipped: ${total} bytes`);
    expect(total).toBeLessThanOrEqual(TERM_BUDGET);
    // xterm.css and terminal.css are both in it; no preact (it is not the board).
    const text = await readFile(join(out, css), 'utf8');
    expect(text).toContain('.xterm-viewport');
    expect(text).toContain('.k-term-x');
    const term = Object.entries(result.metafile.outputs).find(([p]) => /term-[^/\\]*\.js$/.test(p));
    expect(Object.keys(term?.[1].inputs ?? {}).some((p) => p.includes('preact'))).toBe(false);
  });

  it(`keeps the terminal loader within ${LOADER_BUDGET} bytes gzipped`, async () => {
    const r = await esbuild.build({
      entryPoints: [join(import.meta.dirname, 'src/term-loader.ts')],
      bundle: true,
      minify: true,
      format: 'esm',
      target: 'es2022',
      write: false,
      logLevel: 'silent',
    });
    const code = (r.outputFiles[0] as esbuild.OutputFile).contents;
    const size = gzipSync(code, { level: 9 }).length;
    console.log(`terminal loader gzipped: ${size} bytes`);
    expect(size).toBeLessThanOrEqual(LOADER_BUDGET);
    // A type-only import of the chunk: nothing of it is bundled.
    expect(new TextDecoder().decode(code)).not.toContain('xterm');
  });
});
