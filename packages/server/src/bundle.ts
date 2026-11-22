/**
 * The shipped server (ruling R91): `kage` as one ESM file, every runtime dependency inside
 * (hono, @hono/node-server, ws). No TypeScript is stripped at runtime, which costs an idle
 * `kage serve` about 39 MB. Phase 6 ships this file (or a single executable built from it), run
 * as `node --v8-pool-size=1 kage.mjs` with MALLOC_ARENA_MAX=2.
 *
 * Run: `node packages/server/src/bundle.ts` (part of `pnpm build`).
 */
import { join } from 'node:path';
import * as esbuild from 'esbuild';

/** Where the build puts it: beside src, so `import.meta.dirname/../../web/dist` still finds the board. */
export const BUNDLE = join(import.meta.dirname, '..', 'dist', 'kage.mjs');

export async function bundleServer(outfile: string = BUNDLE): Promise<void> {
  await esbuild.build({
    entryPoints: [join(import.meta.dirname, 'main.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    // ws is CommonJS and calls require() for node builtins: give the ESM file a require.
    banner: {
      js: "import { createRequire as __kageCreateRequire } from 'node:module';\nconst require = __kageCreateRequire(import.meta.url);",
    },
    // ws's optional native speed-ups; it runs without them (and they are never installed).
    external: ['bufferutil', 'utf-8-validate'],
    legalComments: 'none',
    logLevel: 'warning',
  });
}

if (import.meta.main) await bundleServer();
