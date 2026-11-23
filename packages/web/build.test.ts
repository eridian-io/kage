// @vitest-environment node
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import {
  brotliCompressSync,
  brotliDecompressSync,
  constants,
  gunzipSync,
  gzipSync,
} from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  build,
  clearCompressed,
  FONTS,
  HASHED,
  LAZY,
  PRECOMPRESSED,
  pruneSidecars,
  writeCompressed,
} from './build.ts';
import { measureSizes, SIZE_LIMITS, type Sizes, termLoaderCode } from './sizes.ts';

// The limits live in sizes.ts, shared with e2e/perf.spec.ts (ruling PF5, F6).
const BUDGET = SIZE_LIMITS.firstLoad;
const TERM_BUDGET = SIZE_LIMITS.termChunk;
const LOADER_BUDGET = SIZE_LIMITS.termLoader;

let out: string;
let result: Awaited<ReturnType<typeof build>>;
let sizes: Sizes;

beforeAll(async () => {
  out = await mkdtemp(join(tmpdir(), 'kage-build-'));
  result = await build({ outDir: out });
  sizes = await measureSizes(out);
}, 60_000);
afterAll(() => rm(out, { recursive: true, force: true }));

const built = async (re: RegExp) => (await readdir(out)).find((f) => re.test(f)) as string;

const gzFile = async (f: string) => gzipSync(await readFile(join(out, f)), { level: 9 }).length;
const textOf = (f: string) => readFile(join(out, f), 'utf8');
const html = () => textOf('index.html');
/** Every script and link in index.html that names code (.js or .css), without the slash. */
const codeRefs = async () =>
  [...(await html()).matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="\/([^"]+)"/g)]
    .map((m) => m[1] as string)
    .filter((r) => /\.(js|css)$/.test(r));

describe('web build', () => {
  it('references one app JS, one app CSS and a modulepreload per shared chunk; only the kage-term meta names the terminal', async () => {
    const page = await html();
    const js = [...page.matchAll(/src="\/(app-[A-Za-z0-9]+\.js)"/g)].map((m) => m[1]);
    const css = [...page.matchAll(/href="\/(app-[A-Za-z0-9]+\.css)"/g)].map((m) => m[1]);
    expect(js).toHaveLength(1);
    expect(css).toHaveLength(1);
    expect(page).toContain('<script type="module" src="/');
    // Every other code reference is a modulepreload of a shared chunk.
    const preloads = [...page.matchAll(/<link rel="modulepreload" href="\/([^"]+)" \/>/g)].map(
      (m) => m[1] as string,
    );
    for (const p of preloads) expect(p).toMatch(/^chunk-[A-Za-z0-9]+\.js$/);
    expect((await codeRefs()).sort()).toEqual([css[0], js[0], ...preloads].sort());
    // Neither lazy entry is ever named by a script or a link.
    expect(page).not.toMatch(/<(?:script|link)\b[^>]*(?:term|diff|palette)-/);
    const meta =
      /<meta name="kage-term" content="\/(term-[A-Za-z0-9]+\.js) \/(term-[A-Za-z0-9]+\.css)" \/>/.exec(
        page,
      );
    expect(meta).not.toBeNull();
    // Each lazy entry is named by its own meta only, for a cache-busting retry (diff-loader.tsx).
    for (const name of Object.keys(LAZY)) {
      const lazy = new RegExp(
        `<meta name="kage-${name}" content="/(${name}-[A-Za-z0-9]+\\.js)" />`,
      );
      expect(lazy.exec(page)?.[1], name).toBe(await built(new RegExp(`^${name}-.*\\.js$`)));
    }
  });

  it('builds the terminal on its own: it imports no chunk, so nothing in the first load is shared with it', async () => {
    const outputs = result.metafile.outputs;
    const term = Object.keys(outputs).find((p) => /term-[^/\\]*\.js$/.test(p)) as string;
    expect(outputs[term]?.imports.filter((i) => !i.external)).toEqual([]);
    // Its own copies of the small helpers it needs (leave.ts), not a shared chunk.
    expect(Object.keys(outputs[term]?.inputs ?? {}).some((p) => p.endsWith('leave.ts'))).toBe(true);
  });

  it('the first load is under the new cap: hardening Task 14’s measurement + 1 KB (performance P6)', () => {
    expect(BUDGET).toBe(26_314 + 1024);
    expect(sizes.firstLoad).toBeLessThanOrEqual(BUDGET);
  });

  it('builds only HASHED names: one app JS, app CSS, term JS, term CSS and one JS per lazy entry, plus shared chunks (assets.ts caches these immutable; app.test.ts)', async () => {
    const files = (await readdir(out)).filter(
      (f) =>
        !['fonts', 'index.html', 'kage-logo-96.png', PRECOMPRESSED].includes(f) &&
        !/\.(br|gz)$/.test(f),
    );
    for (const f of files) expect(f).toMatch(HASHED);
    expect(HASHED.source).toBe(
      '^(app|term|diff|palette|newtask|archived|notify|chunk)-[A-Za-z0-9]+\\.(js|css)$',
    );
    const count = (re: RegExp) => files.filter((f) => re.test(f)).length;
    expect(count(/^app-.*\.js$/)).toBe(1);
    expect(count(/^app-.*\.css$/)).toBe(1);
    expect(count(/^term-.*\.js$/)).toBe(1);
    expect(count(/^term-.*\.css$/)).toBe(1);
    // The diff today; a lazy palette (ruling PF5, F7) is one more LAZY entry.
    expect(Object.keys(LAZY)).toContain('diff');
    for (const name of Object.keys(LAZY)) {
      expect(count(new RegExp(`^${name}-.*\\.js$`)), name).toBe(1);
      // Its styles are in board.css: no CSS of its own.
      expect(count(new RegExp(`^${name}-.*\\.css$`)), name).toBe(0);
    }
    expect(count(/^chunk-.*\.css$/)).toBe(0);
    expect(files).toHaveLength(4 + Object.keys(LAZY).length + count(/^chunk-.*\.js$/));
  });

  it('first load: app JS, its static import closure and app CSS, each named by index.html', async () => {
    const js = await built(/^app-.*\.js$/);
    const css = await built(/^app-.*\.css$/);
    expect(result.firstLoad).toContain(js);
    expect(result.firstLoad).toContain(css);
    for (const f of result.firstLoad) {
      expect(f).toMatch(/^(app-[A-Za-z0-9]+\.(js|css)|chunk-[A-Za-z0-9]+\.js)$/);
    }
    // Every chunk in it has its modulepreload, and index.html names nothing else.
    expect((await codeRefs()).sort()).toEqual([...result.firstLoad].sort());
  });

  it('the diff view is its own lazy file, outside the first load', async () => {
    const diff = await built(/^diff-.*\.js$/);
    expect(result.firstLoad).not.toContain(diff);
    console.log(`diff chunk gzipped: ${await gzFile(diff)} bytes`);
    // DiffView's markup is in it, not in the first load.
    expect(await textOf(diff)).toContain('k-diff-file');
    for (const f of result.firstLoad.filter((n) => n.endsWith('.js'))) {
      expect(await textOf(f), f).not.toContain('k-diff-file');
    }
  });

  it('the command palette is its own lazy file, outside the first load (R95)', async () => {
    const palette = await built(/^palette-.*\.js$/);
    expect(result.firstLoad).not.toContain(palette);
    console.log(`palette chunk gzipped: ${await gzFile(palette)} bytes`);
    // Its markup, fuzzy match and commands are in it; the first load keeps only the key and the
    // hint button (and notify.ts, which the palette is handed instead of importing).
    const text = await textOf(palette);
    expect(text).toContain('Keep typing to see more.');
    expect(text).toContain('Turn on browser notifications');
    for (const f of result.firstLoad.filter((n) => n.endsWith('.js'))) {
      const code = await textOf(f);
      expect(code, f).not.toContain('Keep typing to see more.');
      expect(code, f).not.toContain('Turn on browser notifications');
    }
    // It adds no first-load chunk of its own: everything it imports, app imports anyway.
    const key = Object.keys(result.metafile.outputs).find((k) => k.endsWith(palette)) as string;
    const imports = (result.metafile.outputs[key]?.imports ?? [])
      .filter((i) => i.kind === 'import-statement')
      .map((i) => i.path.split(/[\\/]/).pop());
    for (const i of imports) expect(result.firstLoad).toContain(i);
  });

  it('NewTask, the archived list and notify are lazy chunks outside the first load; Login stays in it (F2)', async () => {
    expect(Object.keys(LAZY)).toEqual(['diff', 'palette', 'newtask', 'archived', 'notify']);
    const firstJs = result.firstLoad.filter((n) => n.endsWith('.js'));
    const firstText = (await Promise.all(firstJs.map(textOf))).join('\n');
    // A string only each entry's own code holds.
    const marks = {
      newtask: 'What should Claude do?',
      archived: 'k-restore',
      notify: 'requestPermission',
    } as const;
    for (const [name, mark] of Object.entries(marks)) {
      const file = await built(new RegExp(`^${name}-.*\\.js$`));
      expect(result.firstLoad, name).not.toContain(file);
      console.log(`${name} chunk gzipped: ${await gzFile(file)} bytes`);
      expect(await textOf(file), name).toContain(mark);
      expect(firstText, name).not.toContain(mark);
    }
    // The metafile agrees: no first-load output takes an input from these modules.
    for (const f of firstJs) {
      const key = Object.keys(result.metafile.outputs).find((k) => k.endsWith(f)) as string;
      const inputs = Object.keys(result.metafile.outputs[key]?.inputs ?? {});
      for (const src of ['NewTask.tsx', 'ArchivedList.tsx', 'notify.ts']) {
        expect(
          inputs.some((i) => i.endsWith(`/${src}`)),
          `${f} has ${src}`,
        ).toBe(false);
      }
    }
    // F2: the login screen is in the first load, so a board can always show it.
    expect(firstText).toContain("That token isn't right.");
  });

  it('the demo data stays out of the first load (the server serves it)', async () => {
    // The docs seed's text in packages/shared/src/demo.ts.
    for (const f of result.firstLoad) {
      expect(await textOf(f), f).not.toContain('a troubleshooting section');
    }
  });

  it('copies the fonts and preloads the two variable files and the logo', async () => {
    expect(FONTS).toHaveLength(2);
    for (const f of FONTS) expect(existsSync(join(out, 'fonts', f)), f).toBe(true);
    const html = await readFile(join(out, 'index.html'), 'utf8');
    const preloads = [...html.matchAll(/<link rel="preload" href="([^"]+)"/g)].map((m) => m[1]);
    expect(preloads).toEqual([
      '/fonts/geist-latin-wght-normal.woff2',
      '/fonts/geist-mono-latin-wght-normal.woff2',
      '/kage-logo-96.png',
    ]);
    // Every font the CSS asks for is in dist/fonts.
    const css = await built(/^app-.*\.css$/);
    const urls = [...(await readFile(join(out, css), 'utf8')).matchAll(/url\(\/fonts\/([^)]+)\)/g)];
    expect(urls.map((m) => m[1]).sort()).toEqual([...FONTS].sort());
  });

  it(`keeps the fonts (dist/fonts, as served) within ${SIZE_LIMITS.fonts} bytes`, async () => {
    console.log(`fonts: ${sizes.fonts} bytes`);
    expect(sizes.fonts).toBeLessThanOrEqual(SIZE_LIMITS.fonts);
    expect((await readdir(join(out, 'fonts'))).filter((f) => f.endsWith('.woff2'))).toHaveLength(2);
  });

  it('ships both fonts’ OFL licence next to them (R90), outside the fonts size', async () => {
    for (const [file, pkg] of [
      ['OFL-geist.txt', 'geist'],
      ['OFL-geist-mono.txt', 'geist-mono'],
    ] as const) {
      const text = await readFile(join(out, 'fonts', file), 'utf8');
      expect(text).toContain('SIL Open Font License');
      expect(text).toBe(
        await readFile(
          join(import.meta.dirname, 'node_modules/@fontsource-variable', pkg, 'LICENSE'),
          'utf8',
        ),
      );
    }
    let woff2 = 0;
    for (const f of FONTS) woff2 += (await stat(join(out, 'fonts', f))).size;
    expect(sizes.fonts).toBe(woff2);
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

  it(`keeps the first load (index.html + its JS and CSS, gzipped) within ${BUDGET} bytes`, async () => {
    let total = await gzFile('index.html');
    const each: string[] = [];
    for (const f of result.firstLoad) {
      const n = await gzFile(f);
      each.push(`${f} ${n}`);
      total += n;
    }
    console.log(`first load gzipped: ${total} bytes (${each.join(', ')})`);
    // sizes.ts (perf.spec.ts) measures the same files, from index.html.
    expect(sizes.firstLoad).toBe(total);
    expect(total).toBeLessThanOrEqual(BUDGET);
    // xterm stays out of it.
    for (const f of result.firstLoad) expect(await textOf(f), f).not.toContain('xterm');
  });

  it(`keeps the terminal chunk (JS + CSS, gzipped) within ${TERM_BUDGET} bytes`, async () => {
    const css = await built(/^term-.*\.css$/);
    const total = sizes.termChunk;
    console.log(`terminal chunk gzipped: ${total} bytes`);
    expect(total).toBeLessThanOrEqual(TERM_BUDGET);
    // xterm.css and terminal.css are both in it; no preact (it is not the board).
    const text = await readFile(join(out, css), 'utf8');
    expect(text).toContain('.xterm-viewport');
    expect(text).toContain('.k-term-x');
    // Nor in any chunk it imports, if splitting gave it one.
    const outputs = result.metafile.outputs;
    const term = Object.keys(outputs).find((p) => /term-[^/\\]*\.js$/.test(p)) as string;
    const closure = new Set([term]);
    for (const p of closure) {
      for (const i of outputs[p]?.imports ?? []) {
        if (i.kind === 'import-statement' && !i.external) closure.add(i.path);
      }
    }
    for (const p of closure) {
      expect(
        Object.keys(outputs[p]?.inputs ?? {}).some((i) => i.includes('preact')),
        p,
      ).toBe(false);
    }
  });

  it(`keeps the terminal loader within ${LOADER_BUDGET} bytes gzipped`, async () => {
    const code = await termLoaderCode();
    const size = sizes.termLoader;
    expect(size).toBe(gzipSync(code, { level: 9 }).length);
    console.log(`terminal loader gzipped: ${size} bytes`);
    expect(size).toBeLessThanOrEqual(LOADER_BUDGET);
    // A type-only import of the chunk: nothing of it is bundled.
    expect(new TextDecoder().decode(code)).not.toContain('xterm');
  });

  it('the build writes .br and .gz beside each compressible file, and a manifest of body hashes', async () => {
    const all = (await readdir(out, { recursive: true, withFileTypes: true }))
      .filter((e) => e.isFile())
      .map((e) => `/${relative(out, join(e.parentPath, e.name)).split(sep).join('/')}`);
    const sidecars = all.filter((p) => /\.(br|gz)$/.test(p));
    const bases = all.filter((p) => !/\.(br|gz)$/.test(p) && p !== `/${PRECOMPRESSED}`);
    // Fonts and images are compressed already: no sidecars.
    const compressible = bases.filter((p) => !/\.(woff2|png|jpe?g|webp)$/.test(p));
    expect(compressible).toContain('/index.html');
    expect(compressible).toContain('/fonts/OFL-geist.txt');
    expect(compressible.length).toBeGreaterThan(5);
    expect(sidecars.sort()).toEqual(compressible.flatMap((p) => [`${p}.br`, `${p}.gz`]).sort());
    const manifest = JSON.parse(await textOf(PRECOMPRESSED)) as Record<string, string>;
    expect(Object.keys(manifest).sort()).toEqual([...compressible].sort());
    for (const p of compressible) {
      const file = join(out, ...p.slice(1).split('/'));
      const body = await readFile(file);
      const hash = createHash('sha256').update(body).digest('base64url').slice(0, 22);
      expect(manifest[p], p).toBe(hash);
      expect(manifest[p]).toHaveLength(22);
      expect(brotliDecompressSync(await readFile(`${file}.br`)).equals(body), p).toBe(true);
      expect(gunzipSync(await readFile(`${file}.gz`)).equals(body), p).toBe(true);
    }
  });
});

describe('precompressed sidecars', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kage-sidecars-'));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it('writeCompressed writes brotli 11 and gzip 9 for the paths it is given, and the manifest', async () => {
    const w = join(dir, 'w');
    await mkdir(join(w, 'sub'), { recursive: true });
    const text = 'const board = "kage";\n'.repeat(200);
    await writeFile(join(w, 'a.js'), text);
    await writeFile(join(w, 'sub', 'b.css'), 'body{color:red}\n');
    await writeFile(join(w, 'skip.txt'), 'not asked for');
    await writeCompressed(w, ['/a.js', '/sub/b.css']);
    const names = (await readdir(w, { recursive: true })).map((n) => n.split(sep).join('/'));
    expect(names.sort()).toEqual(
      [
        'a.js',
        'a.js.br',
        'a.js.gz',
        PRECOMPRESSED,
        'skip.txt',
        'sub',
        'sub/b.css',
        'sub/b.css.br',
        'sub/b.css.gz',
      ].sort(),
    );
    // Quality 11 and level 9: the bytes the server made at start before.
    const body = Buffer.from(text);
    const br = brotliCompressSync(body, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: 11,
        [constants.BROTLI_PARAM_SIZE_HINT]: body.length,
      },
    });
    expect((await readFile(join(w, 'a.js.br'))).equals(br)).toBe(true);
    expect((await readFile(join(w, 'a.js.gz'))).equals(gzipSync(body, { level: 9 }))).toBe(true);
    const manifest = JSON.parse(await readFile(join(w, PRECOMPRESSED), 'utf8'));
    expect(manifest).toEqual({
      '/a.js': createHash('sha256').update(body).digest('base64url').slice(0, 22),
      '/sub/b.css': createHash('sha256')
        .update('body{color:red}\n')
        .digest('base64url')
        .slice(0, 22),
    });
  });

  it('pruneSidecars removes a sidecar whose file is gone, and keeps the rest (F16)', async () => {
    const d = join(dir, 'p');
    await mkdir(join(d, 'fonts'), { recursive: true });
    for (const f of ['app-NEW.js', 'app-NEW.js.br', 'app-NEW.js.gz', 'app-OLD.js.br']) {
      await writeFile(join(d, f), 'x');
    }
    await writeFile(join(d, 'fonts', 'gone.txt.gz'), 'x');
    await pruneSidecars(d);
    expect((await readdir(d)).sort()).toEqual([
      'app-NEW.js',
      'app-NEW.js.br',
      'app-NEW.js.gz',
      'fonts',
    ]);
    expect(await readdir(join(d, 'fonts'))).toEqual([]);
  });

  it('clearCompressed removes every sidecar and the manifest, nothing else (watch writes none)', async () => {
    const d = join(dir, 'c');
    await mkdir(join(d, 'fonts'), { recursive: true });
    for (const f of ['index.html', 'index.html.br', 'index.html.gz', PRECOMPRESSED]) {
      await writeFile(join(d, f), 'x');
    }
    await writeFile(join(d, 'fonts', 'OFL.txt'), 'x');
    await writeFile(join(d, 'fonts', 'OFL.txt.br'), 'x');
    await clearCompressed(d);
    expect((await readdir(d)).sort()).toEqual(['fonts', 'index.html']);
    expect(await readdir(join(d, 'fonts'))).toEqual(['OFL.txt']);
    // A folder that isn't there yet is fine.
    await clearCompressed(join(dir, 'missing'));
  });
});
