import { describe, expect, it } from 'vitest';
import {
  hasControlChars,
  parseAnswer,
  parseArchive,
  parseDelete,
  parseNewTask,
  parsePin,
  parseReply,
} from './validate.ts';

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
  const EXPECTED = 'Expected {"option": <1–9>, "question": "<the question shown>"}';
  const Q = 'Do you want to proceed? — npm test';

  it('accepts exactly {option, question} with an integer 1–9 and the question text (R36)', () => {
    for (const option of [1, 4, 9]) {
      expect(parseAnswer({ option, question: Q })).toEqual({
        ok: true,
        value: { option, question: Q },
      });
    }
  });

  it('refuses other numbers, types and shapes', () => {
    for (const option of [0, 10, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '1', null, true]) {
      expect(answerError({ option, question: Q })).toBe(EXPECTED);
    }
    for (const body of [
      undefined,
      null,
      1,
      'x',
      [],
      [{ option: 1, question: Q }],
      {},
      { option: 1 },
    ]) {
      expect(answerError(body)).toBe(EXPECTED);
    }
    expect(answerError({ option: 1, question: 7 })).toBe(EXPECTED);
    expect(answerError({ option: 1, question: Q, enter: true })).toBe('Unexpected field "enter"');
  });

  it('the question is 1–500 characters without control characters', () => {
    const msg = `"question" must be the question's text (1–500 characters).`;
    expect(answerError({ option: 1, question: '' })).toBe(msg);
    expect(answerError({ option: 1, question: '   ' })).toBe(msg);
    expect(answerError({ option: 1, question: 'q'.repeat(501) })).toBe(msg);
    expect(answerError({ option: 1, question: `a${String.fromCharCode(10)}b` })).toBe(msg);
    expect(parseAnswer({ option: 1, question: 'q'.repeat(500) }).ok).toBe(true);
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
      `abc${String.fromCodePoint(0x202e)}def`,
      `a${String.fromCodePoint(0x2066)}b`,
      `a${String.fromCodePoint(0x2028)}b`,
    ]) {
      expect(replyError({ text })).toBe(CONTROL_ERROR);
    }
  });

  it('refuses LRM, RLM, ALM and the BOM (fix round item 9)', () => {
    for (const cp of [0x200e, 0x200f, 0x061c, 0xfeff]) {
      expect(replyError({ text: `a${String.fromCodePoint(cp)}b` })).toBe(CONTROL_ERROR);
    }
  });

  it('R37: refuses a reply starting with !, # or / (after leading spaces)', () => {
    const msg = "Replies from the board can't start with !, # or /. Use the terminal for those.";
    for (const text of ['!rm -rf ~', '# remember this', '/exit', '  !ls', ' /compact']) {
      expect(replyError({ text })).toBe(msg);
    }
    expect(parseReply({ text: 'use a/b instead' }).ok).toBe(true);
  });

  it('refuses a reply starting with a digit 1–9 (it could answer a prompt that appears mid-send)', () => {
    const msg = "Replies from the board can't start with a number. Use the terminal for that.";
    for (const text of ['1', '2 please', ' 9 tests']) expect(replyError({ text })).toBe(msg);
    expect(parseReply({ text: '0 errors is the goal' }).ok).toBe(true);
    expect(parseReply({ text: 'run 3 tests' }).ok).toBe(true);
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

describe('parsePin and parseArchive (phase 4 Task 4)', () => {
  const PIN = 'Expected {"pinned": true|false}';
  const ARCHIVE = 'Expected {"archived": true|false}';
  it('takes exactly a boolean', () => {
    expect(parsePin({ pinned: true })).toEqual({ ok: true, value: { pinned: true } });
    expect(parsePin({ pinned: false })).toEqual({ ok: true, value: { pinned: false } });
    expect(parseArchive({ archived: true })).toEqual({ ok: true, value: { archived: true } });
    expect(parseArchive({ archived: false })).toEqual({ ok: true, value: { archived: false } });
  });
  it('refuses another type, an extra key, an array, null and a missing body', () => {
    for (const body of [
      { pinned: 'yes' },
      { pinned: 1 },
      { pinned: null },
      {},
      [],
      null,
      undefined,
    ]) {
      expect(parsePin(body), JSON.stringify(body)).toEqual({ ok: false, error: PIN });
    }
    expect(parsePin({ pinned: true, x: 1 })).toEqual({ ok: false, error: 'Unexpected field "x"' });
    for (const body of [{ archived: 'yes' }, { archived: 0 }, {}, [], null, undefined]) {
      expect(parseArchive(body), JSON.stringify(body)).toEqual({ ok: false, error: ARCHIVE });
    }
    expect(parseArchive({ archived: true, pinned: true })).toEqual({
      ok: false,
      error: 'Unexpected field "pinned"',
    });
  });
});

describe('parseDelete (phase 4 Task 6)', () => {
  const DELETE = 'Expected {"unpushed": <count>, "uncommitted": <count>, "ignored": <count>}';
  it('takes exactly the two counts, integers 0–1,000,000', () => {
    for (const body of [
      { unpushed: 0, uncommitted: 0, ignored: 0 },
      { unpushed: 1, uncommitted: 2, ignored: 0 },
      { unpushed: 1_000_000, uncommitted: 1_000_000, ignored: 1_000_000 },
    ]) {
      expect(parseDelete(body)).toEqual({ ok: true, value: body });
    }
  });
  it('refuses a missing count, a negative, a fraction, a string, too big, an array, null and no body', () => {
    for (const body of [
      {},
      { unpushed: 0, uncommitted: 0 },
      { unpushed: 0, uncommitted: 0, ignored: -1 },
      { unpushed: 0, uncommitted: 0, ignored: 0.5 },
      { unpushed: 0, uncommitted: 0, ignored: 1_000_001 },
      { unpushed: 0 },
      { uncommitted: 0, ignored: 0 },
      { unpushed: -1, uncommitted: 0, ignored: 0 },
      { unpushed: 1.5, uncommitted: 0, ignored: 0 },
      { unpushed: 0, uncommitted: Number.NaN, ignored: 0 },
      { unpushed: '1', uncommitted: 0, ignored: 0 },
      { unpushed: 0, uncommitted: 1_000_001, ignored: 0 },
      { unpushed: null, uncommitted: 0, ignored: 0 },
      [],
      null,
      undefined,
    ]) {
      expect(parseDelete(body), JSON.stringify(body)).toEqual({ ok: false, error: DELETE });
    }
  });
  it('refuses an extra key', () => {
    expect(parseDelete({ unpushed: 0, uncommitted: 0, ignored: 0, force: true })).toEqual({
      ok: false,
      error: 'Unexpected field "force"',
    });
  });
});
