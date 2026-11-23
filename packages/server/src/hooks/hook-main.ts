/**
 * The light `kage hook` (performance P2): bundle.ts builds this file alone into
 * `dist/kage-hook.mjs`, and the bundle's hook command runs it (install/runtime.ts hookArgv).
 * It imports cli.ts only, so a hook loads node:net, node:os and node:path, not the server's
 * built-ins (node:http alone costs about 22 ms). It behaves exactly as `kage hook <Event>` in
 * main.ts: no event or no `hook` does nothing, it prints nothing, and it exits 0 whatever
 * happens, within HOOK_DEADLINE_MS.
 */
import { runHookCli } from './cli.ts';

const [command, event] = process.argv.slice(2);
try {
  if (command === 'hook' && event)
    await runHookCli(event, { stdin: process.stdin, env: process.env });
} catch {}
process.exit(0);
