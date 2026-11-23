import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { anonymousMb } from './proc-memory.ts';

const FIXTURE = join(import.meta.dirname, '../test/fixtures/proc/smaps_rollup.txt');

describe('anonymousMb (the perf harness serveAnon, performance P5)', () => {
  it('serveAnon reads Anonymous from smaps_rollup', () => {
    // 22,956 kB: the Anonymous line, not Rss, Pss_Anon's neighbours or Shared_Clean.
    expect(anonymousMb(FIXTURE)).toBe(22956 / 1024);
  });

  it('throws when the file has no Anonymous line', () => {
    expect(() => anonymousMb(join(import.meta.dirname, '../test/fixtures/ports/ss.txt'))).toThrow(
      'No Anonymous line in',
    );
  });
});
