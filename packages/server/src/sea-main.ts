/**
 * The single executable's entry (phase 6, host-integration §7.1). The SEA runs its main script as
 * CommonJS only, so bundle.ts builds this file with esbuild `format: 'cjs'`: no top-level await
 * and no `import.meta` here (the build defines `import.meta.url` from `__filename`). In a SEA,
 * `process.argv` is `[execPath, what was typed, …args]`, so the arguments start at index 2.
 */
import { run } from './main.ts';

void run(process.argv.slice(2));
