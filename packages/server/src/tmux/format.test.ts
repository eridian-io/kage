import { describe, expect, it } from 'vitest';
import { LIST_WINDOWS_FORMAT, parseWindows } from './format.ts';

describe('parseWindows', () => {
  it('uses tab separators in the format string', () => {
    expect(LIST_WINDOWS_FORMAT).toContain('\t');
    expect(LIST_WINDOWS_FORMAT).toContain('#{@kage_id}');
    expect(LIST_WINDOWS_FORMAT).toContain('#{@kage_placeholder}');
  });

  it('parses a window line', () => {
    const line =
      '@12\t0b7e5f0e-1111-2222-3333-444455556666\t%3\t4242\tclaude\t/home/dev/x\tfix-login\t1795271520\t';
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
        placeholder: false,
      },
    ]);
  });

  it('reads a missing @kage_id as null', () => {
    const [w] = parseWindows('@1\t\t%1\t10\tbash\t/tmp\tw\t5\t\n');
    expect(w?.kageId).toBeNull();
  });

  it('reads @kage_placeholder (R22): set means the window Kage made to hold the session', () => {
    expect(parseWindows('@1\t\t%1\t10\tbash\t/tmp\tw\t5\t1\n')[0]?.placeholder).toBe(true);
    expect(parseWindows('@1\t\t%1\t10\tbash\t/tmp\tw\t5\t\n')[0]?.placeholder).toBe(false);
  });

  it('skips malformed lines', () => {
    const good = '@1\t\t%1\t10\tbash\t/tmp\tw\t5\t';
    expect(parseWindows(`garbage\n@1\t\t%1\tNaN\tbash\t/tmp\tw\t5\t\n${good}\n\n`)).toHaveLength(1);
  });
});
