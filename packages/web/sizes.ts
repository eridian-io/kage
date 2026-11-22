import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import * as esbuild from 'esbuild';

/**
 * The size budgets of the web build (spec §7), in one place: build.test.ts asserts them on a fresh
 * build and e2e/perf.spec.ts records them from packages/web/dist (ruling PF5, F6). Gzip level 9.
 */
export const SIZE_LIMITS = {
  /**
   * index.html + every JS and CSS file it names (app, its chunks, its CSS). Spec §7 allows 30 KB;
   * the cap is the first load measured after Task 8 (26,432 B, the palette lazy) + 1 KB, rounded up
   * to the next 0.25 KB (ruling PF5, F7).
   */
  firstLoad: 27 * 1024,
  /** The terminal chunk, JS plus CSS (spec §7: about 90 KB; the plan: at most 100 KB). */
  termChunk: 100 * 1024,
  /** term-loader.ts, the only terminal code in the first load (F14). */
  termLoader: 600,
  /** Every .woff2 in dist/fonts, as served (compressed already; the OFL texts are not counted). Spec §7: 60 KB. */
  fonts: 60 * 1024,
} as const;

/** A budget that fails today: its owning task and its first measurement (ruling PF5, F5). */
export interface AllowFail {
  owner: string;
  baseline: number;
}

/** How far an allowFail budget may regress past its baseline before it fails anyway. */
export const CEILING = 1.25;

const num = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

/**
 * The verdict on an allowFail budget (shared by e2e/budgets.ts and build.test.ts): null while it
 * fails within baseline × CEILING; else the failure message. A pass fails too, so the marker
 * can't be forgotten once the owning task has fixed the budget.
 */
export function allowFailVerdict(
  name: string,
  value: number,
  limit: number,
  allow: AllowFail,
): string | null {
  if (value <= limit) return `${name} passes now: remove its allowFail marker (${allow.owner})`;
  const ceiling = allow.baseline * CEILING;
  if (value > ceiling) {
    return `${name} regressed past its allowFail ceiling: ${num(value)} > ${num(ceiling)} (baseline ${num(allow.baseline)} × ${CEILING}; ${allow.owner})`;
  }
  return null;
}

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
  // What the browser fetches before the board runs: index.html and each file a script or link in
  // it names (the stylesheet, app and its modulepreloaded chunks). build.test.ts checks that these
  // are exactly build()'s firstLoad.
  const html = await readFile(join(dist, 'index.html'), 'utf8');
  let firstLoad = gzipSync(html, { level: 9 }).length;
  for (const m of html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="\/([^"]+\.(?:js|css))"/g)) {
    firstLoad += await gz(join(dist, m[1] as string));
  }
  const termChunk = (await gz(await at(/^term-.*\.js$/))) + (await gz(await at(/^term-.*\.css$/)));
  const termLoader = gzipSync(await termLoaderCode(), { level: 9 }).length;
  let fonts = 0;
  for (const f of await readdir(join(dist, 'fonts'))) {
    if (f.endsWith('.woff2')) fonts += (await stat(join(dist, 'fonts', f))).size;
  }
  return { firstLoad, termChunk, termLoader, fonts };
}
