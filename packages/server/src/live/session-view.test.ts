import { describe, expect, it } from 'vitest';
import { questionFromToolInput, type SessionView, toSession } from './session-view.ts';

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
