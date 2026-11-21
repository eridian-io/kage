import { describe, expect, it } from 'vitest';
import type { TmuxWindow } from '../tmux/format.ts';
import {
  previewTarget,
  questionFromToolInput,
  type SessionView,
  sameSession,
  toSession,
} from './session-view.ts';

const view = (over: Partial<SessionView> = {}): SessionView => ({
  id: 'ext-@1',
  record: null,
  window: null,
  firstSeen: 1,
  status: 'running',
  statusSince: 1,
  question: null,
  now: 'Running npm test',
  ...over,
});

describe('toSession', () => {
  it('carries the now line only while the session is running (F3)', () => {
    expect(toSession(view()).now).toBe('Running npm test');
    for (const status of ['done', 'needs-you', 'ended'] as const) {
      expect(toSession(view({ status }))).not.toHaveProperty('now');
    }
  });
  it('carries a cut question’s flag (R52), and none otherwise', () => {
    const cut = { text: 'Do you want to proceed? — x…', options: ['Yes'], cut: true };
    expect(toSession(view({ status: 'needs-you', question: cut })).question?.cut).toBe(true);
    const whole = { text: 'Do you want to proceed?', options: ['Yes'] };
    expect(toSession(view({ status: 'needs-you', question: whole })).question).not.toHaveProperty(
      'cut',
    );
  });
});

describe('toSession v3', () => {
  it('fills filesTotal 0 until real data arrives', () => {
    expect(toSession(view())).toMatchObject({ files: [], filesTotal: 0 });
  });

  it('carries the latest ports and files as copies', () => {
    const ports = [{ port: 5173, process: 'vite', localOnly: true }];
    const files = [{ path: 'a.ts', added: 1, removed: 2 }];
    const s = toSession(view({ ports, files, filesTotal: 120 }));
    expect(s).toMatchObject({ ports, files, filesTotal: 120 });
    expect(s.ports[0]).not.toBe(ports[0]);
    expect(s.files[0]).not.toBe(files[0]);
  });
});

describe('previewTarget (F6)', () => {
  const window: TmuxWindow = {
    windowId: '@1',
    kageId: null,
    paneId: '%1',
    panePid: 4100,
    command: 'node',
    cwd: '/home/dev/projects/demo/sub',
    name: 'demo',
    activity: 0,
    placeholder: false,
    dead: false,
  };

  it('an external window: the pane cwd, no base, its pane pid; active while running or needs you', () => {
    expect(previewTarget(view({ window }))).toEqual({
      id: 'ext-@1',
      worktree: '/home/dev/projects/demo/sub',
      base: null,
      panePid: 4100,
      active: true,
    });
    expect(previewTarget(view({ window, status: 'needs-you' }))?.active).toBe(true);
    expect(previewTarget(view({ window, status: 'done' }))?.active).toBe(false);
  });

  it('no pane pid when ended or dead; null without a folder', () => {
    expect(previewTarget(view({ window, status: 'ended' }))?.panePid).toBeNull();
    expect(previewTarget(view({ window: { ...window, dead: true } }))?.panePid).toBeNull();
    expect(previewTarget(view())).toBeNull();
  });
});

describe('sameSession', () => {
  const base = toSession(view());
  it('ignores ports, files and filesTotal, which have their own events', () => {
    const b = {
      ...base,
      ports: [{ port: 3000, process: 'node', localOnly: false }],
      files: [{ path: 'a', added: 1, removed: 0 }],
      filesTotal: 1,
    };
    expect(sameSession(base, b)).toBe(true);
  });
  it('compares question.startup', () => {
    const q = { text: 'Theme?', options: ['Dark'] };
    const a = { ...base, question: q };
    expect(sameSession(a, { ...base, question: { ...q } })).toBe(true);
    expect(sameSession(a, { ...base, question: { ...q, startup: true } })).toBe(false);
  });
  it('compares question.cut (R52)', () => {
    const q = { text: 'Run it?', options: ['Yes'] };
    expect(sameSession({ ...base, question: q }, { ...base, question: { ...q, cut: true } })).toBe(
      false,
    );
  });
  it('still sees a changed status', () => {
    expect(sameSession(base, { ...base, status: 'done' })).toBe(false);
  });
});

describe('questionFromToolInput', () => {
  it('reads the first question and its labels', () => {
    expect(
      questionFromToolInput({
        questions: [{ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }, {}] }],
      }),
    ).toEqual({ text: 'Which?', options: ['A', 'B'] });
  });
  it('bounds it: 500-character text, at most 10 options of 200, plain text', () => {
    const q = questionFromToolInput({
      questions: [
        {
          question: `${'q'.repeat(700)}\x1b[2J`,
          options: Array.from({ length: 12 }, () => ({ label: `\x07${'o'.repeat(300)}` })),
        },
      ],
    });
    expect(q?.text).toHaveLength(500);
    expect(q?.text).not.toContain('\x1b');
    expect(q?.options).toHaveLength(10);
    expect(q?.options.every((o) => o.length <= 200 && !o.includes('\x07'))).toBe(true);
  });
});
