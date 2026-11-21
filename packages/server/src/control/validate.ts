import { type AnswerBody, LIMITS, type NewTaskBody, type ReplyBody } from '@kage/shared';

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * C0 controls, DEL, C1 controls, the line and paragraph separators, and the bidi embeddings,
 * overrides and isolates (U+202A–U+202E, U+2066–U+2069) that can make text read differently
 * from what it is.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
/** F11: what `allowNewlines` allows. */
const NEWLINES = /[\n\r\t]/g;

/** True when `s` holds a control character; with `allowNewlines`, LF, CR and TAB are allowed. */
export function hasControlChars(s: string, allowNewlines: boolean): boolean {
  return CONTROL.test(allowNewlines ? s.replace(NEWLINES, '') : s);
}

const KEYS = ['project', 'base', 'task', 'acceptEdits'] as const;
const EXPECTED = 'Expected {"project", "base", "task", "acceptEdits"}';

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

/**
 * A `POST /api/sessions` body: exactly the four keys, with their types and LIMITS. The project
 * and base are only checked to be strings here; the launcher looks them up (404 when unknown).
 */
export function parseNewTask(body: unknown): Parsed<NewTaskBody> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return fail(EXPECTED);
  const o = body as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (!(KEYS as readonly string[]).includes(k)) return fail(`Unexpected field "${k}"`);
  }
  if (!KEYS.every((k) => k in o)) return fail(EXPECTED);
  const { project, base, task, acceptEdits } = o;
  if (typeof project !== 'string' || typeof base !== 'string' || typeof task !== 'string') {
    return fail(EXPECTED);
  }
  // Characters are code points (F4): 3,001 emoji are 3,001 characters.
  const chars = [...task].length;
  if (task.trim() === '' || chars > LIMITS.taskChars) {
    return fail(`Describe the task in 1–${LIMITS.taskChars} characters.`);
  }
  if (Buffer.byteLength(task, 'utf8') > LIMITS.textBytes) {
    return fail('The task is too long (over 12,000 bytes).');
  }
  if (hasControlChars(task, true)) return fail("The task can't contain control characters.");
  if (task.startsWith('-')) return fail('The task can\'t start with "-".');
  if (typeof acceptEdits !== 'boolean') return fail('"acceptEdits" must be true or false.');
  return { ok: true, value: { project, base, task, acceptEdits } };
}

/** An object whose keys are exactly `keys`; else the error to answer with. */
function exactKeys(
  body: unknown,
  keys: readonly string[],
  expected: string,
): Parsed<Record<string, unknown>> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return fail(expected);
  const o = body as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!keys.includes(k)) return fail(`Unexpected field "${k}"`);
  if (!keys.every((k) => k in o)) return fail(expected);
  return { ok: true, value: o };
}

const EXPECTED_ANSWER = 'Expected {"option": <1–9>, "question": "<the question shown>"}';

/**
 * A `POST …/answer` body: exactly `{option, question}`. `option` is an integer 1–9 (the key
 * Claude shows for it); `question` (R36) is the question text the card showed, 1–500
 * characters without control characters, so the server answers only that question.
 */
export function parseAnswer(body: unknown): Parsed<AnswerBody> {
  const o = exactKeys(body, ['option', 'question'], EXPECTED_ANSWER);
  if (!o.ok) return o;
  const { option, question } = o.value;
  if (typeof option !== 'number' || !Number.isInteger(option) || option < 1 || option > 9) {
    return fail(EXPECTED_ANSWER);
  }
  if (typeof question !== 'string') return fail(EXPECTED_ANSWER);
  const chars = [...question].length;
  if (question.trim() === '' || chars > LIMITS.questionChars || hasControlChars(question, false)) {
    return fail(`"question" must be the question's text (1–${LIMITS.questionChars} characters).`);
  }
  return { ok: true, value: { option, question } };
}

/** Invisible marks a reply may not carry (fix round item 9): LRM, RLM, ALM and the BOM. */
const INVISIBLE = new RegExp(`[${String.fromCodePoint(0x200e, 0x200f, 0x061c, 0xfeff)}]`, 'u');
/**
 * R37: `!` runs a shell command in Claude (no permission prompt), `#` writes memory and `/` is a
 * slash command. A leading digit could answer a prompt that appears mid-send.
 */
const RISKY_START = /^[!#/]/;
const DIGIT_START = /^[1-9]/;

const EXPECTED_REPLY = 'Expected {"text": "<reply>"}';

/**
 * A `POST …/reply` body: exactly `{text}`. No control characters at all (newlines included: a
 * newline would submit early) and no invisible marks, checked before trimming; then 1–4000
 * characters (code points) and at most 12,000 bytes, trimmed; never starting with !, #, / (R37)
 * or a digit 1–9.
 */
export function parseReply(body: unknown): Parsed<ReplyBody> {
  const o = exactKeys(body, ['text'], EXPECTED_REPLY);
  if (!o.ok) return o;
  const { text: raw } = o.value;
  if (typeof raw !== 'string') return fail(EXPECTED_REPLY);
  if (hasControlChars(raw, false) || INVISIBLE.test(raw)) {
    return fail("The reply can't contain control characters or line breaks.");
  }
  const text = raw.trim();
  const chars = [...text].length;
  if (chars === 0 || chars > LIMITS.replyChars) {
    return fail(`Write a reply of 1–${LIMITS.replyChars} characters.`);
  }
  if (RISKY_START.test(text)) {
    return fail("Replies from the board can't start with !, # or /. Use the terminal for those.");
  }
  if (DIGIT_START.test(text)) {
    return fail("Replies from the board can't start with a number. Use the terminal for that.");
  }
  if (Buffer.byteLength(text, 'utf8') > LIMITS.textBytes) {
    return fail('The reply is too long (over 12,000 bytes).');
  }
  return { ok: true, value: { text } };
}
