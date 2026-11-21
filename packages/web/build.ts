/**
 * Builds the board into dist/: index.html, app-[hash].js, app-[hash].css, fonts/*, the logo.
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
const HASHED = /^app-[A-Za-z0-9]+\.(js|css)$/;

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

/** Writes the new bundle and index.html, then removes bundles from earlier builds. */
async function writeBundle(outDir: string, files: esbuild.OutputFile[]): Promise<void> {
  const names = files.map((f) => basename(f.path));
  const js = names.find((n) => n.endsWith('.js'));
  const css = names.find((n) => n.endsWith('.css'));
  if (!js || !css || names.length !== 2) throw new Error(`Unexpected build output: ${names}`);
  await Promise.all(files.map((f) => writeFile(f.path, f.contents)));
  const template = await readFile(join(here, 'index.html'), 'utf8');
  await writeFile(
    join(outDir, 'index.html'),
    template.replace('%APP_JS%', js).replace('%APP_CSS%', css),
  );
  for (const old of await readdir(outDir)) {
    if (HASHED.test(old) && !names.includes(old)) await rm(join(outDir, old));
  }
}

function options(outDir: string, onBuilt: (r: esbuild.BuildResult) => Promise<void>) {
  return {
    entryPoints: [join(here, 'src/main.tsx'), join(here, 'src/styles/index.css')],
    outdir: outDir,
    bundle: true,
    minify: true,
    format: 'esm',
    target: 'es2022',
    jsx: 'automatic',
    jsxImportSource: 'preact',
    entryNames: 'app-[hash]',
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
}

/** Builds once into outDir (default dist/), replacing what was there. */
export async function build(opts: { outDir?: string } = {}): Promise<BuildResult> {
  const outDir = opts.outDir ?? join(here, 'dist');
  await rm(outDir, { recursive: true, force: true });
  await copyStatic(outDir);
  const r = await esbuild.build(
    options(outDir, (res) => writeBundle(outDir, res.outputFiles ?? [])),
  );
  if (!r.metafile) throw new Error('esbuild returned no metafile');
  return { metafile: r.metafile };
}

/** Builds, then rebuilds dist/ on every source change until the process exits. */
export async function watch(opts: { outDir?: string } = {}): Promise<void> {
  const outDir = opts.outDir ?? join(here, 'dist');
  // No wipe here: a server started next to the watcher may be reading dist/ already.
  await copyStatic(outDir);
  const ctx = await esbuild.context(
    options(outDir, async (res) => {
      await writeBundle(outDir, res.outputFiles ?? []);
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
