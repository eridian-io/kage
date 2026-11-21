import { describe, expect, it } from 'vitest';
import { LIST_WINDOWS_FORMAT, parseWindows } from './format.ts';

describe('parseWindows', () => {
  it('uses tab separators in the format string', () => {
    expect(LIST_WINDOWS_FORMAT).toContain('\t');
    expect(LIST_WINDOWS_FORMAT).toContain('#{@kage_id}');
  });

  it('parses a window line', () => {
    const line =
      '@12\t0b7e5f0e-1111-2222-3333-444455556666\t%3\t4242\tclaude\t/home/dev/x\tfix-login\t1795271520';
    expect(parseWindows(`${line}\n`)).toEqual([
      {
        windowId: '@12',
        kageId: '0b7e5f0e-1111-2222-3333-444455556666',
        paneId: '%3',
        panePid: 4242,
        command: 'claude',
        cwd: '/home/dev/x',
        name: 'fix-login',
        activity: 1795271520,
      },
    ]);
  });

  it('reads a missing @kage_id as null', () => {
    const [w] = parseWindows('@1\t\t%1\t10\tbash\t/tmp\tw\t5\n');
    expect(w?.kageId).toBeNull();
  });

  it('skips malformed lines', () => {
    const good = '@1\t\t%1\t10\tbash\t/tmp\tw\t5';
    expect(parseWindows(`garbage\n@1\t\t%1\tNaN\tbash\t/tmp\tw\t5\n${good}\n\n`)).toHaveLength(1);
  });
});
