import { LIMITS, type NewTaskBody } from '@kage/shared';

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
