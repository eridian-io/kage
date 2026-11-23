/**
 * Builds the board into dist/: index.html, app-[hash].js, app-[hash].css, the chunk-[hash].js files
 * app imports (each preloaded by index.html), fonts/* with their OFL texts, the logo, and the lazy
 * files: the terminal term-[hash].js and term-[hash].css, which only index.html's kage-term meta
 * names (term-loader.ts loads them on the first open; spec §5.6), and one <name>-[hash].js per LAZY
 * entry, loaded by its dynamic import and named by a kage-<name> meta for a retry (diff-loader.tsx;
 * R78). The terminal is its own esbuild run, so it shares no chunk with the board.
 * A build also writes <file>.br and <file>.gz beside each compressible file, and PRECOMPRESSED
 * last, so the server reads them instead of compressing at every start (performance P1).
 * `node packages/web/build.ts` builds once; `--watch` rebuilds on every change.
 */
import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, extname, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { brotliCompress, constants, gzip } from 'node:zlib';
import * as esbuild from 'esbuild';

const here = import.meta.dirname;

/** The two variable Geist files (latin, wght axis; @fontsource-variable) board.css asks for at /fonts/<name>. */
export const FONTS = ['geist-latin-wght-normal.woff2', 'geist-mono-latin-wght-normal.woff2'];
/** Each font package's OFL licence, shipped next to the fonts (R90): dist/fonts/<name> ← package. */
const LICENCES = { 'OFL-geist.txt': 'geist', 'OFL-geist-mono.txt': 'geist-mono' } as const;
const LOGO = 'kage-logo-96.png';
/**
 * The entries the board loads only on demand, by a dynamic import of their source: never in the
 * first load: the diff view (R78), the command palette (R95), and New task, the archived list and
 * notify (performance P6; lazy.tsx). The login screen stays in the first load (F2).
 */
export const LAZY = {
  diff: 'src/components/DiffView.tsx',
  palette: 'src/components/Palette.tsx',
  newtask: 'src/components/NewTask.tsx',
  archived: 'src/components/ArchivedList.tsx',
  notify: 'src/notify.ts',
} as const;
/** Every name the build writes; assets.ts caches the same names immutable. */
export const HASHED =
  /^(app|term|diff|palette|newtask|archived|notify|chunk)-[A-Za-z0-9]+\.(js|css)$/;

/**
 * The manifest of the precompressed sidecars, at the top of dist/: { "/<path>": "<hash>" }, the
 * hash being the first 22 characters of the base64url SHA-256 of the file's body (the server's
 * ETag). assets.ts (PRECOMPRESSED there) uses a file's sidecars only when its body still matches.
 */
export const PRECOMPRESSED = 'precompressed.json';
/** Formats that are compressed already (assets.ts serves them raw): no sidecars. */
const RAW = new Set(['.woff2', '.png', '.jpg', '.jpeg', '.webp']);
const SIDECAR = /\.(br|gz)$/;

const br = promisify(brotliCompress);
const gz = promisify(gzip);

/** Every file under dir, as URL paths ('/index.html', '/fonts/…'). */
async function listFiles(dir: string): Promise<string[]> {
  let entries: Dirent[] = [];
  try {
    entries = await readdir(dir, { withFileTypes: true, recursive: true, encoding: 'utf8' });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  return entries
    .filter((e) => e.isFile())
    .map((e) => `/${relative(dir, join(e.parentPath, e.name)).split(sep).join('/')}`);
}

const fileOf = (dir: string, urlPath: string) => join(dir, ...urlPath.slice(1).split('/'));

/**
 * Writes <file>.br (quality 11) and <file>.gz (level 9) for each URL path, one file and one
 * encoder at a time (the same bytes the server made at start before, R100), then PRECOMPRESSED.
 */
export async function writeCompressed(outDir: string, paths: string[]): Promise<void> {
  const manifest: Record<string, string> = {};
  for (const path of [...paths].sort()) {
    const file = fileOf(outDir, path);
    const body = await readFile(file);
    await writeFile(`${file}.gz`, await gz(body, { level: 9 }));
    await writeFile(
      `${file}.br`,
      await br(body, {
        params: {
          [constants.BROTLI_PARAM_QUALITY]: 11,
          [constants.BROTLI_PARAM_SIZE_HINT]: body.length,
        },
      }),
    );
    manifest[path] = createHash('sha256').update(body).digest('base64url').slice(0, 22);
  }
  await writeFile(join(outDir, PRECOMPRESSED), `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Removes each .br or .gz whose file is gone (a HASHED output of an earlier build; F16). */
export async function pruneSidecars(outDir: string): Promise<void> {
  const files = await listFiles(outDir);
  const have = new Set(files);
  for (const p of files) {
    if (SIDECAR.test(p) && !have.has(p.replace(SIDECAR, ''))) {
      await rm(fileOf(outDir, p), { force: true });
    }
  }
}

/** Removes every sidecar and the manifest: a watch build writes none, so none may go stale. */
export async function clearCompressed(outDir: string): Promise<void> {
  for (const p of await listFiles(outDir)) {
    if (SIDECAR.test(p) || p === `/${PRECOMPRESSED}`) await rm(fileOf(outDir, p), { force: true });
  }
}

const fontPackage = (pkg: string) => join(here, 'node_modules/@fontsource-variable', pkg);
const fontSource = (name: string) =>
  join(fontPackage(name.startsWith('geist-mono-') ? 'geist-mono' : 'geist'), 'files', name);

async function copyStatic(outDir: string): Promise<void> {
  await mkdir(join(outDir, 'fonts'), { recursive: true });
  await Promise.all([
    ...FONTS.map((f) => copyFile(fontSource(f), join(outDir, 'fonts', f))),
    ...Object.entries(LICENCES).map(([to, pkg]) =>
      copyFile(join(fontPackage(pkg), 'LICENSE'), join(outDir, 'fonts', to)),
    ),
    copyFile(join(here, 'public', LOGO), join(outDir, LOGO)),
  ]);
}

/** The output files `entry` imports statically, itself first, transitively (from the metafile). */
function staticClosure(metafile: esbuild.Metafile, entry: string): string[] {
  const outputs = metafile.outputs;
  const key = Object.keys(outputs).find((k) => basename(k) === entry);
  if (key === undefined) throw new Error(`No ${entry} in the metafile`);
  const seen = new Set([key]);
  for (const k of seen) {
    for (const i of outputs[k]?.imports ?? []) {
      if (i.kind === 'import-statement' && !i.external) seen.add(i.path);
    }
  }
  return [...seen].map((k) => basename(k));
}

/** The board's and the terminal's runs, as one result. */
interface Runs {
  board: esbuild.BuildResult;
  term: esbuild.BuildResult;
}

const metafileOf = (r: esbuild.BuildResult): esbuild.Metafile => {
  if (!r.metafile) throw new Error('esbuild returned no metafile');
  return r.metafile;
};

/** Both runs' metafiles in one (their inputs and outputs, side by side). */
function merged({ board, term }: Runs): esbuild.Metafile {
  const a = metafileOf(board);
  const b = metafileOf(term);
  return { inputs: { ...a.inputs, ...b.inputs }, outputs: { ...a.outputs, ...b.outputs } };
}

/**
 * Checks the output by kind, writes it and index.html, then removes bundles from earlier builds.
 * Returns the first load: app's JS with its static import closure, and app's CSS.
 */
async function writeBundle(outDir: string, runs: Runs): Promise<string[]> {
  const files = [...(runs.board.outputFiles ?? []), ...(runs.term.outputFiles ?? [])];
  const names = files.map((f) => basename(f.path));
  const all = (re: RegExp) => names.filter((n) => re.test(n));
  const one = (re: RegExp) => {
    const found = all(re);
    return found.length === 1 ? found[0] : undefined;
  };
  const js = one(/^app-.*\.js$/);
  const css = one(/^app-.*\.css$/);
  const termJs = one(/^term-.*\.js$/);
  const termCss = one(/^term-.*\.css$/);
  const lazy = Object.keys(LAZY).map((name) => [name, one(new RegExp(`^${name}-.*\\.js$`))]);
  const chunks = all(/^chunk-.*\.js$/);
  if (
    !js ||
    !css ||
    !termJs ||
    !termCss ||
    lazy.some(([, n]) => n === undefined) ||
    names.length !== 4 + lazy.length + chunks.length ||
    !names.every((n) => HASHED.test(n))
  ) {
    throw new Error(`Unexpected build output: ${names}`);
  }
  const appJs = staticClosure(metafileOf(runs.board), js);
  await Promise.all(files.map((f) => writeFile(f.path, f.contents)));
  const template = await readFile(join(here, 'index.html'), 'utf8');
  // Each chunk app imports is fetched alongside it, not once app has been parsed.
  const preload = appJs
    .slice(1)
    .map((c) => `    <link rel="modulepreload" href="/${c}" />\n`)
    .join('');
  const metas = lazy
    .map(([name, file]) => `    <meta name="kage-${name}" content="/${file}" />\n`)
    .join('');
  await writeFile(
    join(outDir, 'index.html'),
    template
      .replace('%APP_JS%', js)
      .replace('%APP_CSS%', css)
      .replace('%PRELOAD%', preload)
      .replace('%TERM%', `/${termJs} /${termCss}`)
      .replace('%LAZY%', metas),
  );
  for (const old of await readdir(outDir)) {
    if (HASHED.test(old) && !names.includes(old)) await rm(join(outDir, old));
  }
  // Their .br and .gz go with them (F16).
  await pruneSidecars(outDir);
  return [...appJs, css];
}

function common(outDir: string, plugins: esbuild.Plugin[]) {
  return {
    outdir: outDir,
    bundle: true,
    minify: true,
    format: 'esm',
    target: 'es2022',
    jsx: 'automatic',
    jsxImportSource: 'preact',
    entryNames: '[name]-[hash]',
    // board.css points at files copied next to the bundle, not at modules.
    external: ['/fonts/*', `/${LOGO}`],
    metafile: true,
    write: false,
    legalComments: 'none',
    logLevel: 'warning',
    plugins,
  } satisfies esbuild.BuildOptions;
}

/** The board: app, its CSS and the LAZY entries, with what they share split into chunks. */
function boardOptions(outDir: string, plugins: esbuild.Plugin[] = []) {
  return {
    ...common(outDir, plugins),
    entryPoints: [
      { in: join(here, 'src/main.tsx'), out: 'app' },
      { in: join(here, 'src/styles/index.css'), out: 'app' },
      // Imported by the board only through import(): a file of its own, outside the first load.
      ...Object.entries(LAZY).map(([out, src]) => ({ in: join(here, src), out })),
    ],
    // What app shares with a lazy entry goes into chunk-[hash].js files, which app imports.
    splitting: true,
    chunkNames: 'chunk-[hash]',
  } satisfies esbuild.BuildOptions;
}

/**
 * The terminal, never imported by the board: xterm stays out of the first load, and its own copies
 * of the few small modules it shares with the board (leave.ts, the shared types) keep it from
 * splitting them into extra first-load chunks.
 */
function termOptions(outDir: string, plugins: esbuild.Plugin[] = []) {
  return {
    ...common(outDir, plugins),
    entryPoints: [{ in: join(here, 'src/terminal/index.ts'), out: 'term' }],
  } satisfies esbuild.BuildOptions;
}

export interface BuildResult {
  /** Both runs' metafiles, merged. */
  metafile: esbuild.Metafile;
  /** app's JS plus its static import closure, and app's CSS. */
  firstLoad: string[];
}

/** Builds once into outDir (default dist/), replacing what was there. */
export async function build(opts: { outDir?: string } = {}): Promise<BuildResult> {
  const outDir = opts.outDir ?? join(here, 'dist');
  await rm(outDir, { recursive: true, force: true });
  await copyStatic(outDir);
  const [board, term] = await Promise.all([
    esbuild.build(boardOptions(outDir)),
    esbuild.build(termOptions(outDir)),
  ]);
  const runs = { board, term };
  const firstLoad = await writeBundle(outDir, runs);
  const compressible = (await listFiles(outDir)).filter(
    (p) => !RAW.has(extname(p).toLowerCase()) && !SIDECAR.test(p) && p !== `/${PRECOMPRESSED}`,
  );
  await writeCompressed(outDir, compressible);
  return { metafile: merged(runs), firstLoad };
}

/** Builds, then rebuilds dist/ on every source change until the process exits. */
export async function watch(opts: { outDir?: string } = {}): Promise<void> {
  const outDir = opts.outDir ?? join(here, 'dist');
  // No wipe here: a server started next to the watcher may be reading dist/ already. But no
  // sidecars: a watch build compresses nothing, so the server compresses at start (assets.ts).
  await clearCompressed(outDir);
  await copyStatic(outDir);
  // Each run keeps its last good result; index.html is written once both have one.
  const last: Partial<Runs> = {};
  // One write at a time: two overlapping writes would each delete the other's fresh files as
  // stale. A queued write reads `last` when its turn comes, so it writes the newest pair.
  let writes: Promise<void> = Promise.resolve();
  const keep = (which: keyof Runs): esbuild.Plugin => ({
    name: `kage-dist-${which}`,
    setup(b) {
      b.onEnd((r) => {
        if (r.errors.length > 0) return;
        last[which] = r;
        writes = writes.then(async () => {
          const { board, term } = last;
          if (!board || !term) return;
          try {
            await writeBundle(outDir, { board, term });
            console.log(`Built the board into ${outDir}`);
          } catch (e) {
            // A bad write is reported; the chain goes on, so the next change still writes.
            console.error(e instanceof Error ? e.message : e);
          }
        });
        return writes;
      });
    },
  });
  const contexts = await Promise.all([
    esbuild.context(boardOptions(outDir, [keep('board')])),
    esbuild.context(termOptions(outDir, [keep('term')])),
  ]);
  await Promise.all(contexts.map((c) => c.watch()));
}

if (import.meta.main) {
  if (process.argv.includes('--watch')) {
    await watch();
  } else {
    await build();
    console.log(`Built the board into ${join(here, 'dist')}`);
  }
}
