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

const EXPECTED_ANSWER = 'Expected {"option": <1–9>}';

/** A `POST …/answer` body: exactly `{option}`, an integer 1–9 (the key Claude shows for it). */
export function parseAnswer(body: unknown): Parsed<AnswerBody> {
  const o = exactKeys(body, ['option'], EXPECTED_ANSWER);
  if (!o.ok) return o;
  const { option } = o.value;
  if (typeof option !== 'number' || !Number.isInteger(option) || option < 1 || option > 9) {
    return fail(EXPECTED_ANSWER);
  }
  return { ok: true, value: { option } };
}

const EXPECTED_REPLY = 'Expected {"text": "<reply>"}';

/**
 * A `POST …/reply` body: exactly `{text}`. No control characters at all (newlines included: a
 * newline would submit early), checked before trimming; then 1–4000 characters (code points)
 * and at most 12,000 bytes, trimmed.
 */
export function parseReply(body: unknown): Parsed<ReplyBody> {
  const o = exactKeys(body, ['text'], EXPECTED_REPLY);
  if (!o.ok) return o;
  const { text: raw } = o.value;
  if (typeof raw !== 'string') return fail(EXPECTED_REPLY);
  if (hasControlChars(raw, false)) {
    return fail("The reply can't contain control characters or line breaks.");
  }
  const text = raw.trim();
  const chars = [...text].length;
  if (chars === 0 || chars > LIMITS.replyChars) {
    return fail(`Write a reply of 1–${LIMITS.replyChars} characters.`);
  }
  if (Buffer.byteLength(text, 'utf8') > LIMITS.textBytes) {
    return fail('The reply is too long (over 12,000 bytes).');
  }
  return { ok: true, value: { text } };
}
