import { describe, expect, it } from 'vitest';
import { hasControlChars, parseAnswer, parseNewTask, parseReply } from './validate.ts';

const ok = { project: 'shop', base: 'main', task: 'Fix the cart total', acceptEdits: false };
const EXPECTED = 'Expected {"project", "base", "task", "acceptEdits"}';

const errorOf = (body: unknown): string | null => {
  const r = parseNewTask(body);
  return r.ok ? null : r.error;
};

describe('parseNewTask', () => {
  it('accepts a valid body and returns exactly its fields', () => {
    expect(parseNewTask({ ...ok, acceptEdits: true })).toEqual({
      ok: true,
      value: { ...ok, acceptEdits: true },
    });
  });

  it('refuses anything but an object with the four fields', () => {
    for (const body of [undefined, null, 'x', 7, [], [ok]]) expect(errorOf(body)).toBe(EXPECTED);
    const { acceptEdits: _, ...missing } = ok;
    expect(errorOf(missing)).toBe(EXPECTED);
    expect(errorOf({ ...ok, project: 7 })).toBe(EXPECTED);
    expect(errorOf({ ...ok, base: null })).toBe(EXPECTED);
    expect(errorOf({ ...ok, task: ['x'] })).toBe(EXPECTED);
  });

  it('names an unexpected field', () => {
    expect(errorOf({ ...ok, mode: 'bypassPermissions' })).toBe('Unexpected field "mode"');
  });

  it('wants 1–4000 characters of task', () => {
    const msg = 'Describe the task in 1–4000 characters.';
    expect(errorOf({ ...ok, task: '' })).toBe(msg);
    expect(errorOf({ ...ok, task: '   \n ' })).toBe(msg);
    expect(errorOf({ ...ok, task: 'x'.repeat(4001) })).toBe(msg);
    expect(errorOf({ ...ok, task: 'x'.repeat(4000) })).toBeNull();
  });

  it('refuses a task over 12,000 bytes', () => {
    // F4: 3,001 four-byte emoji are 3,001 characters and 12,004 bytes.
    const task = '😀'.repeat(3001);
    expect(Buffer.byteLength(task)).toBe(12_004);
    expect(errorOf({ ...ok, task })).toBe('The task is too long (over 12,000 bytes).');
    expect(errorOf({ ...ok, task: '😀'.repeat(3000) })).toBeNull();
    // A 13 KB task (review focus 1).
    expect(errorOf({ ...ok, task: '😀'.repeat(3300) })).toBe(
      'The task is too long (over 12,000 bytes).',
    );
  });

  it('refuses control characters, but allows newlines and tabs', () => {
    const msg = "The task can't contain control characters.";
    expect(errorOf({ ...ok, task: 'a\u001b[2Jb' })).toBe(msg);
    expect(errorOf({ ...ok, task: '\u202eevil' })).toBe(msg);
    expect(errorOf({ ...ok, task: 'a\u0000b' })).toBe(msg);
    expect(errorOf({ ...ok, task: 'line one\nline two' })).toBeNull();
    expect(errorOf({ ...ok, task: 'line one\r\nline two' })).toBeNull();
    expect(errorOf({ ...ok, task: 'col\tcol' })).toBeNull();
  });

  it('refuses a task starting with "-"', () => {
    const msg = 'The task can\'t start with "-".';
    expect(errorOf({ ...ok, task: '-p hi' })).toBe(msg);
    expect(errorOf({ ...ok, task: '--dangerously-skip-permissions' })).toBe(msg);
    expect(errorOf({ ...ok, task: '-p x' })).toBe(msg);
  });

  it('wants a boolean acceptEdits', () => {
    const msg = '"acceptEdits" must be true or false.';
    expect(errorOf({ ...ok, acceptEdits: 'true' })).toBe(msg);
    expect(errorOf({ ...ok, acceptEdits: 1 })).toBe(msg);
    expect(errorOf({ ...ok, acceptEdits: null })).toBe(msg);
  });

  it('passes hostile project and base names through as plain strings (the lookup 404s them)', () => {
    for (const name of ['../../etc', 'a/../../b', '$(rm -rf ~)', '-x']) {
      expect(parseNewTask({ ...ok, project: name })).toMatchObject({ ok: true });
      expect(parseNewTask({ ...ok, base: name })).toMatchObject({ ok: true });
    }
  });

  it('keeps shell characters in a task as text (it never reaches a shell)', () => {
    for (const task of ['$(rm -rf ~)', '../../etc', 'a/../../b', 'x; rm -rf ~', '`id`']) {
      expect(parseNewTask({ ...ok, task })).toEqual({ ok: true, value: { ...ok, task } });
    }
  });
});

describe('hasControlChars', () => {
  it('finds C0, DEL, C1, line and paragraph separators and bidi controls', () => {
    for (const c of [
      '\u0000',
      '\u0007',
      '\u001b',
      '\u007f',
      '\u0085',
      '\u009b',
      '\u2028',
      '\u2029',
      '\u202a',
      '\u202e',
      '\u2066',
      '\u2069',
    ]) {
      expect(hasControlChars(`a${c}b`, true)).toBe(true);
    }
  });

  it('allows LF, CR and TAB only with allowNewlines', () => {
    for (const c of ['\n', '\r', '\t']) {
      expect(hasControlChars(`a${c}b`, true)).toBe(false);
      expect(hasControlChars(`a${c}b`, false)).toBe(true);
    }
  });

  it('passes ordinary text, accents and emoji', () => {
    expect(hasControlChars('Ünïcödé café 😀 日本語', false)).toBe(false);
  });
});

describe('parseAnswer', () => {
  const answerError = (body: unknown): string | null => {
    const r = parseAnswer(body);
    return r.ok ? null : r.error;
  };

  it('accepts exactly {option} with an integer 1–9', () => {
    for (const option of [1, 4, 9])
      expect(parseAnswer({ option })).toEqual({ ok: true, value: { option } });
  });

  it('refuses other numbers, types and shapes', () => {
    for (const option of [0, 10, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '1', null, true]) {
      expect(answerError({ option })).toBe('Expected {"option": <1–9>}');
    }
    for (const body of [undefined, null, 1, 'x', [], [{ option: 1 }], {}]) {
      expect(answerError(body)).toBe('Expected {"option": <1–9>}');
    }
    expect(answerError({ option: 1, enter: true })).toBe('Unexpected field "enter"');
  });
});

describe('parseReply', () => {
  const replyError = (body: unknown): string | null => {
    const r = parseReply(body);
    return r.ok ? null : r.error;
  };
  const CONTROL_ERROR = "The reply can't contain control characters or line breaks.";

  it('accepts exactly {text} and trims it', () => {
    expect(parseReply({ text: '  use the other script  ' })).toEqual({
      ok: true,
      value: { text: 'use the other script' },
    });
    // Control characters are checked before trimming: a trailing newline is refused too.
    expect(replyError({ text: 'yes\n' })).toBe(
      "The reply can't contain control characters or line breaks.",
    );
  });

  it('refuses other shapes', () => {
    for (const body of [undefined, null, 'x', [], {}, { text: 7 }, { text: null }]) {
      expect(replyError(body)).toBe('Expected {"text": "<reply>"}');
    }
    expect(replyError({ text: 'hi', submit: false })).toBe('Unexpected field "submit"');
  });

  it('refuses empty, blank and over-long replies (4,000 code points, 12,000 bytes)', () => {
    expect(replyError({ text: '' })).toBe('Write a reply of 1–4000 characters.');
    expect(replyError({ text: '   ' })).toBe('Write a reply of 1–4000 characters.');
    expect(replyError({ text: 'a'.repeat(4001) })).toBe('Write a reply of 1–4000 characters.');
    expect(parseReply({ text: 'a'.repeat(4000) }).ok).toBe(true);
    // 3,000 emoji are 3,000 characters but 12,000 bytes: allowed; 3,001 are over.
    expect(parseReply({ text: '😀'.repeat(3000) }).ok).toBe(true);
    expect(replyError({ text: '😀'.repeat(3001) })).toBe(
      'The reply is too long (over 12,000 bytes).',
    );
  });

  it('refuses newlines, ESC, NUL, other controls and bidi overrides (F15)', () => {
    for (const text of [
      'yes\nrm -rf ~',
      'yes\r',
      'a\tb',
      'a\u001b[2J',
      'a\u0000b',
      'a\u007fb',
      'a\u0085b',
      'abc‮def',
      'a⁦b',
      'a b',
    ]) {
      expect(replyError({ text })).toBe(CONTROL_ERROR);
    }
  });

  it('keeps shell syntax and option-like text as plain text (F15: it is typed, never run)', () => {
    for (const text of [
      'ok; rm -rf ~',
      '$(rm -rf ~)',
      '`id`',
      '--dangerously-skip-permissions',
      '-p x',
    ]) {
      expect(parseReply({ text })).toEqual({ ok: true, value: { text } });
    }
  });
});
