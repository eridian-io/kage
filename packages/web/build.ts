/**
 * Builds the board into dist/: index.html, app-[hash].js, app-[hash].css, the chunk-[hash].js files
 * app imports (each preloaded by index.html), fonts/*, the logo, and the lazy files: the terminal
 * term-[hash].js and term-[hash].css, which only index.html's kage-term meta names (term-loader.ts
 * loads them on the first open; spec §5.6), and one <name>-[hash].js per LAZY entry, loaded by its
 * dynamic import (diff-loader.tsx; R78).
 * `node packages/web/build.ts` builds once; `--watch` rebuilds on every change.
 */
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import * as esbuild from 'esbuild';

const here = import.meta.dirname;

/** The Geist files board.css asks for at /fonts/<name>. */
export const FONTS = [
  'geist-latin-400-normal.woff2',
  'geist-latin-500-normal.woff2',
  'geist-latin-600-normal.woff2',
  'geist-latin-700-normal.woff2',
  'geist-mono-latin-400-normal.woff2',
  'geist-mono-latin-500-normal.woff2',
];
const LOGO = 'kage-logo-96.png';
/**
 * The entries the board loads only on demand, by a dynamic import of their source: never in the
 * first load. A lazy palette (ruling PF5, F7) is one more line here; its name is in HASHED already.
 */
export const LAZY = { diff: 'src/components/DiffView.tsx' } as const;
/** Every name the build writes; assets.ts caches the same names immutable. */
export const HASHED = /^(app|term|diff|palette|chunk)-[A-Za-z0-9]+\.(js|css)$/;

const fontSource = (name: string) =>
  join(
    here,
    'node_modules/@fontsource',
    name.startsWith('geist-mono-') ? 'geist-mono' : 'geist',
    'files',
    name,
  );

async function copyStatic(outDir: string): Promise<void> {
  await mkdir(join(outDir, 'fonts'), { recursive: true });
  await Promise.all([
    ...FONTS.map((f) => copyFile(fontSource(f), join(outDir, 'fonts', f))),
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

/**
 * Checks the output by kind, writes it and index.html, then removes bundles from earlier builds.
 * Returns the first load: app's JS with its static import closure, and app's CSS.
 */
async function writeBundle(
  outDir: string,
  files: esbuild.OutputFile[],
  metafile: esbuild.Metafile,
): Promise<string[]> {
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
  const lazy = Object.keys(LAZY).map((name) => one(new RegExp(`^${name}-.*\\.js$`)));
  const chunks = all(/^chunk-.*\.js$/);
  if (
    !js ||
    !css ||
    !termJs ||
    !termCss ||
    lazy.some((n) => n === undefined) ||
    names.length !== 4 + lazy.length + chunks.length ||
    !names.every((n) => HASHED.test(n))
  ) {
    throw new Error(`Unexpected build output: ${names}`);
  }
  const appJs = staticClosure(metafile, js);
  await Promise.all(files.map((f) => writeFile(f.path, f.contents)));
  const template = await readFile(join(here, 'index.html'), 'utf8');
  // Each chunk app imports is fetched alongside it, not once app has been parsed.
  const preload = appJs
    .slice(1)
    .map((c) => `    <link rel="modulepreload" href="/${c}" />\n`)
    .join('');
  await writeFile(
    join(outDir, 'index.html'),
    template
      .replace('%APP_JS%', js)
      .replace('%APP_CSS%', css)
      .replace('%PRELOAD%', preload)
      .replace('%TERM%', `/${termJs} /${termCss}`),
  );
  for (const old of await readdir(outDir)) {
    if (HASHED.test(old) && !names.includes(old)) await rm(join(outDir, old));
  }
  return [...appJs, css];
}

function options(outDir: string, onBuilt: (r: esbuild.BuildResult) => Promise<void>) {
  return {
    entryPoints: [
      { in: join(here, 'src/main.tsx'), out: 'app' },
      { in: join(here, 'src/styles/index.css'), out: 'app' },
      // Its own entry, never imported by the board: xterm stays out of the first load.
      { in: join(here, 'src/terminal/index.ts'), out: 'term' },
      // Imported by the board only through import(): a file of its own, outside the first load.
      ...Object.entries(LAZY).map(([out, src]) => ({ in: join(here, src), out })),
    ],
    outdir: outDir,
    bundle: true,
    minify: true,
    format: 'esm',
    target: 'es2022',
    jsx: 'automatic',
    jsxImportSource: 'preact',
    entryNames: '[name]-[hash]',
    // What app shares with a lazy entry goes into chunk-[hash].js files, which app imports.
    splitting: true,
    chunkNames: 'chunk-[hash]',
    // board.css points at files copied next to the bundle, not at modules.
    external: ['/fonts/*', `/${LOGO}`],
    metafile: true,
    write: false,
    legalComments: 'none',
    logLevel: 'warning',
    plugins: [
      {
        name: 'kage-dist',
        setup(b) {
          b.onEnd(async (r) => {
            if (r.errors.length === 0) await onBuilt(r);
          });
        },
      },
    ],
  } satisfies esbuild.BuildOptions;
}

export interface BuildResult {
  metafile: esbuild.Metafile;
  /** app's JS plus its static import closure, and app's CSS. */
  firstLoad: string[];
}

const metafileOf = (r: esbuild.BuildResult): esbuild.Metafile => {
  if (!r.metafile) throw new Error('esbuild returned no metafile');
  return r.metafile;
};

/** Builds once into outDir (default dist/), replacing what was there. */
export async function build(opts: { outDir?: string } = {}): Promise<BuildResult> {
  const outDir = opts.outDir ?? join(here, 'dist');
  await rm(outDir, { recursive: true, force: true });
  await copyStatic(outDir);
  let firstLoad: string[] = [];
  const r = await esbuild.build(
    options(outDir, async (res) => {
      firstLoad = await writeBundle(outDir, res.outputFiles ?? [], metafileOf(res));
    }),
  );
  return { metafile: metafileOf(r), firstLoad };
}

/** Builds, then rebuilds dist/ on every source change until the process exits. */
export async function watch(opts: { outDir?: string } = {}): Promise<void> {
  const outDir = opts.outDir ?? join(here, 'dist');
  // No wipe here: a server started next to the watcher may be reading dist/ already.
  await copyStatic(outDir);
  const ctx = await esbuild.context(
    options(outDir, async (res) => {
      await writeBundle(outDir, res.outputFiles ?? [], metafileOf(res));
      console.log(`Built the board into ${outDir}`);
    }),
  );
  await ctx.watch();
}

if (import.meta.main) {
  if (process.argv.includes('--watch')) {
    await watch();
  } else {
    await build();
    console.log(`Built the board into ${join(here, 'dist')}`);
  }
}
