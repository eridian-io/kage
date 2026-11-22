/**
 * `kage doctor` (phase 6, Task 4): what Kage needs, how this installation runs, and what to do
 * about anything that isn't right. It changes nothing; see checks.ts for what it may call.
 */
import type { Io } from '../main.ts';
import { type CheckDeps, formatChecks, installChecks, requirementChecks } from './checks.ts';
import { KAGE_VERSION } from './runtime.ts';

/** 0 when nothing failed (warnings are fine), else 1. */
export async function doctorCommand(args: string[], io: Io, deps: CheckDeps): Promise<number> {
  if (args.length > 0) {
    io.err('kage doctor takes no arguments.');
    return 1;
  }
  io.out(`Kage ${KAGE_VERSION}`);
  io.out('');
  const needs = await requirementChecks(deps);
  for (const line of formatChecks(needs)) io.out(line);
  const all = [...needs];
  // Off Linux and macOS the installation checks would only repeat the platform failure.
  if (!needs.some((c) => c.id === 'platform' && c.level === 'fail')) {
    const install = await installChecks(deps);
    io.out('');
    for (const line of formatChecks(install)) io.out(line);
    all.push(...install);
  }
  io.out('');
  if (all.some((c) => c.level === 'fail')) {
    io.out('Fix the ✗ lines, then run kage doctor again.');
    return 1;
  }
  io.out(
    all.some((c) => c.level === 'warn')
      ? 'Kage can run. The ! lines are worth a look.'
      : 'Everything looks good.',
  );
  return 0;
}
