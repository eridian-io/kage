import type { Question } from '@kage/shared';
import { stripAnsi } from './ansi.ts';

/** Longest question text, most options and longest option label on the wire. */
export const MAX_QUESTION = 500;
export const MAX_OPTIONS = 10;
export const MAX_OPTION = 200;

/** Cuts to `max` characters, ending with "…" when cut; never splits a surrogate pair. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, max - 1);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/**
 * One line of plain text at most `max` characters: line breaks become spaces; escape sequences,
 * control characters, and bidi and format characters go. It is cut after stripping, so a long
 * escape sequence can't push the visible text out; stripping stops one character past `max`.
 */
export function plainLine(text: string, max: number): string {
  return clip(stripAnsi(text, { oneLine: true, limit: max + 1 }), max);
}

/** A question as it may go on the wire: plain text, bounded in length and count. */
export function boundQuestion(text: string, options: readonly string[]): Question {
  return {
    text: plainLine(text, MAX_QUESTION),
    options: options.slice(0, MAX_OPTIONS).map((o) => plainLine(o, MAX_OPTION)),
  };
}
