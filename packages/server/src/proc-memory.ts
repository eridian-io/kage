/**
 * For tests only (nothing in Kage imports this): the perf harness's reading of a process's
 * anonymous memory (performance P5). About 48 MB of the idle server's RSS is the `node` binary's
 * shared file pages, which move with the Node version, not with Kage; the `Anonymous` line of
 * `/proc/<pid>/smaps_rollup` is the part Kage controls (its heap, malloc arenas and stacks).
 */
import { readFileSync } from 'node:fs';

/** MB from the `Anonymous:` line of a smaps_rollup file (Linux reports it in kB). */
export function anonymousMb(file: string): number {
  const kb = Number(/^Anonymous:\s+(\d+) kB$/m.exec(readFileSync(file, 'utf8'))?.[1]);
  if (!Number.isFinite(kb)) throw new Error(`No Anonymous line in ${file}`);
  return kb / 1024;
}
