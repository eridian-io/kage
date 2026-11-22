import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import * as esbuild from 'esbuild';

/**
 * The size budgets of the web build (spec §7), in one place: build.test.ts asserts them on a fresh
 * build and e2e/perf.spec.ts records them from packages/web/dist (ruling PF5, F6). Gzip level 9.
 */
export const SIZE_LIMITS = {
  /** index.html + app JS + app CSS. Spec §7 allows 30 KB; phase 4 ends at 25.5 KB (F14). */
  firstLoad: 25.5 * 1024,
  /** The terminal chunk, JS plus CSS (spec §7: about 90 KB; the plan: at most 100 KB). */
  termChunk: 100 * 1024,
  /** term-loader.ts, the only terminal code in the first load (F14). */
  termLoader: 600,
  /** Every file in dist/fonts, as served (woff2 is compressed already). Spec §7: 60 KB. */
  fonts: 60 * 1024,
} as const;

export interface Sizes {
  firstLoad: number;
  termChunk: number;
  termLoader: number;
  fonts: number;
}

const gz = async (path: string) => gzipSync(await readFile(path), { level: 9 }).length;

/** The one file in `dir` matching `re`; throws when there isn't exactly one. */
export async function builtFile(dir: string, re: RegExp): Promise<string> {
  const found = (await readdir(dir)).filter((f) => re.test(f));
  if (found.length !== 1) throw new Error(`Expected one file matching ${re} in ${dir}: ${found}`);
  return found[0] as string;
}

/** term-loader.ts bundled and minified on its own, as the first load carries it. */
export async function termLoaderCode(): Promise<Uint8Array> {
  const r = await esbuild.build({
    entryPoints: [join(import.meta.dirname, 'src/term-loader.ts')],
    bundle: true,
    minify: true,
    format: 'esm',
    target: 'es2022',
    write: false,
    logLevel: 'silent',
  });
  return (r.outputFiles[0] as esbuild.OutputFile).contents;
}

/** Every size SIZE_LIMITS bounds, measured on the build in `dist`. */
export async function measureSizes(dist: string): Promise<Sizes> {
  const at = (re: RegExp) => builtFile(dist, re).then((f) => join(dist, f));
  const firstLoad =
    (await gz(join(dist, 'index.html'))) +
    (await gz(await at(/^app-.*\.js$/))) +
    (await gz(await at(/^app-.*\.css$/)));
  const termChunk = (await gz(await at(/^term-.*\.js$/))) + (await gz(await at(/^term-.*\.css$/)));
  const termLoader = gzipSync(await termLoaderCode(), { level: 9 }).length;
  let fonts = 0;
  for (const f of await readdir(join(dist, 'fonts')))
    fonts += (await stat(join(dist, 'fonts', f))).size;
  return { firstLoad, termChunk, termLoader, fonts };
}
