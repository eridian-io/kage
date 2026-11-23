/**
 * The shipped server (ruling R91): `kage` as one ESM file, every runtime dependency inside
 * (hono, @hono/node-server, ws). No TypeScript is stripped at runtime, which costs an idle
 * `kage serve` about 39 MB. Phase 6 ships this file (or a single executable built from it), run
 * as `node --v8-pool-size=1 kage.mjs` with MALLOC_ARENA_MAX=2.
 *
 * The hook entry `kage-hook.mjs` is built beside it (bundleHook).
 *
 * Run: `node packages/server/src/bundle.ts` (part of `pnpm build`).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as esbuild from 'esbuild';

/** Where the build puts it: beside src, so `<dir>/../../web/dist` finds the board (boardFor). */
export const BUNDLE = join(import.meta.dirname, '..', 'dist', 'kage.mjs');

/** The light `kage hook` (performance P2), beside the bundle: hookArgv names it when it is there. */
export const HOOK_BUNDLE = join(import.meta.dirname, '..', 'dist', 'kage-hook.mjs');

/** packages/server/package.json's version: `kage --version` in both bundles. */
export function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'));
  return String(pkg.version);
}

export interface BundleOptions {
  /** The version `kage --version` prints (default: package.json's; F16's override). */
  version?: string;
}

/** What both bundles share. */
function common(version: string): esbuild.BuildOptions {
  return {
    bundle: true,
    platform: 'node',
    target: 'node24',
    define: { KAGE_BUILD_VERSION: JSON.stringify(version) },
    // ws's optional native speed-ups; it runs without them (and they are never installed).
    external: ['bufferutil', 'utf-8-validate'],
    legalComments: 'none',
    logLevel: 'warning',
  };
}

export async function bundleServer(outfile: string = BUNDLE, o: BundleOptions = {}): Promise<void> {
  await esbuild.build({
    ...common(o.version ?? packageVersion()),
    entryPoints: [join(import.meta.dirname, 'main.ts')],
    outfile,
    format: 'esm',
    // ws is CommonJS and calls require() for node builtins: give the ESM file a require.
    banner: {
      js: "import { createRequire as __kageCreateRequire } from 'node:module';\nconst require = __kageCreateRequire(import.meta.url);",
    },
  });
}

/**
 * The single executable's main script (host-integration §7.1): CommonJS, since the SEA runs no
 * ESM main. `import.meta.url` comes from `__filename` (the executable in a SEA, where ENTRY is
 * "" anyway), and `import.meta.main` is false: sea-main.ts calls run() itself.
 */
export async function bundleSeaEntry(outfile: string, o: BundleOptions = {}): Promise<void> {
  const base = common(o.version ?? packageVersion());
  await esbuild.build({
    ...base,
    entryPoints: [join(import.meta.dirname, 'sea-main.ts')],
    outfile,
    format: 'cjs',
    define: {
      ...base.define,
      'import.meta.url': '__kageUrl',
      'import.meta.main': 'false',
    },
    banner: { js: "var __kageUrl = require('node:url').pathToFileURL(__filename).href;" },
  });
}

/**
 * The hook entry's build: hooks/hook-main.ts and what it imports (hooks/cli.ts), one ESM file of
 * a few KB that loads only node:net, node:os and node:path. Exported for its test's metafile.
 */
export function hookBuildOptions(outfile: string): esbuild.BuildOptions {
  return {
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    entryPoints: [join(import.meta.dirname, 'hooks', 'hook-main.ts')],
    outfile,
    legalComments: 'none',
    logLevel: 'warning',
  };
}

/** Builds dist/kage-hook.mjs (part of `pnpm build`; stageNpm ships it next to kage.mjs). */
export async function bundleHook(outfile: string = HOOK_BUNDLE): Promise<void> {
  await esbuild.build(hookBuildOptions(outfile));
}

if (import.meta.main) {
  await bundleServer();
  await bundleHook();
}
