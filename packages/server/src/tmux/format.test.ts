import { describe, expect, it } from 'vitest';
import { LIST_PANES_FORMAT, parsePanes, pickPanes } from './format.ts';

/** One list-panes line: window, kage id, pane, pid, command, path, name, activity, active, dead, placeholder. */
const line = (o: {
  w?: string;
  kage?: string;
  pane?: string;
  pid?: string;
  cmd?: string;
  cwd?: string;
  name?: string;
  act?: string;
  active?: string;
  dead?: string;
  placeholder?: string;
}): string =>
  [
    o.w ?? '@1',
    o.kage ?? '',
    o.pane ?? '%1',
    o.pid ?? '10',
    o.cmd ?? 'bash',
    o.cwd ?? '/tmp',
    o.name ?? 'w',
    o.act ?? '5',
    o.active ?? '1',
    o.dead ?? '0',
    o.placeholder ?? '',
  ].join('\t');

describe('LIST_PANES_FORMAT', () => {
  it('uses real tab separators (F16) and lists the fields in order', () => {
    expect(LIST_PANES_FORMAT).not.toContain('\\t');
    expect(LIST_PANES_FORMAT.split('\t')).toEqual([
      '#{window_id}',
      '#{@kage_id}',
      '#{pane_id}',
      '#{pane_pid}',
      '#{pane_current_command}',
      '#{pane_current_path}',
      '#{window_name}',
      '#{window_activity}',
      '#{pane_active}',
      '#{pane_dead}',
      '#{@kage_placeholder}',
    ]);
  });
});

describe('parsePanes', () => {
  it('parses a pane line', () => {
    const l = line({
      w: '@12',
      kage: '0b7e5f0e-1111-2222-3333-444455556666',
      pane: '%3',
      pid: '4242',
      cmd: 'claude',
      cwd: '/home/dev/x',
      name: 'fix-login',
      act: '1795271520',
    });
    expect(parsePanes(`${l}\n`)).toEqual([
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
        active: true,
        dead: false,
      },
    ]);
  });

  it('reads a missing @kage_id as null', () => {
    expect(parsePanes(line({}))[0]?.kageId).toBeNull();
  });

  it('reads @kage_placeholder (R22)', () => {
    expect(parsePanes(line({ placeholder: '1' }))[0]?.placeholder).toBe(true);
    expect(parsePanes(line({}))[0]?.placeholder).toBe(false);
  });

  it('pane_dead 1 gives dead: true; pane_active 0 gives active: false', () => {
    const [p] = parsePanes(line({ dead: '1', active: '0' }));
    expect(p?.dead).toBe(true);
    expect(p?.active).toBe(false);
  });

  it('skips malformed lines', () => {
    const good = line({});
    const out = [
      'garbage',
      line({ pid: 'NaN' }),
      line({ w: '1' }),
      line({ pane: '1' }),
      line({ act: '' }),
      `${good}\textra`,
      good.split('\t').slice(0, 10).join('\t'),
      good,
      '',
    ].join('\n');
    expect(parsePanes(out)).toHaveLength(1);
  });

  it('tolerates CRLF line ends', () => {
    expect(parsePanes(`${line({})}\r\n`)).toHaveLength(1);
  });
});

describe('pickPanes (B14)', () => {
  const panes = (out: string[]) => parsePanes(out.join('\n'));

  it('a window with two panes where the second has sent a hook picks the second', () => {
    const p = panes([
      line({ pane: '%1', cmd: 'claude', active: '1' }),
      line({ pane: '%2', cmd: 'node', active: '0' }),
    ]);
    const [w, ...rest] = pickPanes(p, new Set(['%2']));
    expect(rest).toEqual([]);
    expect(w?.paneId).toBe('%2');
    expect(w).not.toHaveProperty('active');
  });

  it('with no hooks, a pane running claude wins over the active pane', () => {
    const p = panes([
      line({ pane: '%1', cmd: 'bash', active: '1' }),
      line({ pane: '%2', cmd: 'claude', active: '0' }),
    ]);
    expect(pickPanes(p, new Set()).map((w) => w.paneId)).toEqual(['%2']);
  });

  it('a version-string process title counts as claude', () => {
    const p = panes([
      line({ pane: '%1', cmd: 'bash', active: '1' }),
      line({ pane: '%2', cmd: '2.1.330', active: '0' }),
    ]);
    expect(pickPanes(p, new Set()).map((w) => w.paneId)).toEqual(['%2']);
  });

  it('otherwise the active pane is picked', () => {
    const p = panes([
      line({ pane: '%1', cmd: 'bash', active: '0' }),
      line({ pane: '%2', cmd: 'vim', active: '1' }),
    ]);
    expect(pickPanes(p, new Set()).map((w) => w.paneId)).toEqual(['%2']);
  });

  it('falls back to the first pane when none is active', () => {
    const p = panes([line({ pane: '%1', active: '0' }), line({ pane: '%2', active: '0' })]);
    expect(pickPanes(p, new Set()).map((w) => w.paneId)).toEqual(['%1']);
  });

  it('a hook pane in another window does not affect this one', () => {
    const p = panes([
      line({ w: '@1', pane: '%1', cmd: 'bash', active: '1' }),
      line({ w: '@1', pane: '%2', cmd: 'claude', active: '0' }),
      line({ w: '@2', pane: '%3', cmd: 'bash', active: '1' }),
      line({ w: '@2', pane: '%4', cmd: 'bash', active: '0' }),
    ]);
    expect(pickPanes(p, new Set(['%4'])).map((w) => [w.windowId, w.paneId])).toEqual([
      ['@1', '%2'],
      ['@2', '%4'],
    ]);
  });

  it('single-pane windows give that pane, in window order', () => {
    const p = panes([line({ w: '@3', pane: '%9' }), line({ w: '@1', pane: '%1' })]);
    expect(pickPanes(p, new Set()).map((w) => w.windowId)).toEqual(['@3', '@1']);
  });
});
