import { type StartupKind, showsPrompt } from '../pane/prompt.ts';
import { stripAnsi } from '../text/ansi.ts';

/**
 * Which keys answer which screen, and the screen readings SessionControls checks before every
 * key (spec §5.4; facts in docs/specs/claude-code-integration.md §2, §3, §6, §7).
 */

export type PromptKind = 'permission' | 'ask' | StartupKind;

export type KeyPlan =
  /** Send the digit; it picks and submits at once (no Enter). */
  | { kind: 'digit'; digit: number }
  /** A one-option screen (security notes, theme "Continue"). */
  | { kind: 'enter' }
  /** Move ❯ to option `index` (0-based) with Up/Down, verify, then Enter. */
  | { kind: 'cursor'; index: number }
  | { kind: 'refuse'; reason: string };

/** The default attach command shown for the login screen. */
export const DEFAULT_ATTACH = 'tmux attach -t kage';

/**
 * The keys for option `option` (1-based) of a prompt of `kind`. Permission prompts and
 * AskUserQuestion only ever get a digit, never Enter (F13). The trust screen's options are
 * unnumbered and a digit does nothing there, so it takes the cursor; so does a theme screen with
 * options (not observed to take digits). `attach` is the command the login refusal names.
 */
export function answerPlan(
  kind: PromptKind,
  options: string[],
  option: number,
  attach: string = DEFAULT_ATTACH,
): KeyPlan {
  if (kind === 'login') {
    return { kind: 'refuse', reason: `Sign in to Claude Code in the terminal: ${attach}.` };
  }
  if (!Number.isInteger(option) || option < 1 || option > options.length) {
    return { kind: 'refuse', reason: `There's no option ${option}.` };
  }
  switch (kind) {
    case 'permission':
    case 'ask':
    case 'renderer':
      return { kind: 'digit', digit: option };
    case 'security':
      return { kind: 'enter' };
    case 'theme':
      return options.length === 1 && options[0] === 'Continue'
        ? { kind: 'enter' }
        : { kind: 'cursor', index: option - 1 };
    case 'trust':
      return { kind: 'cursor', index: option - 1 };
  }
}

const FULL_RULE = /^─{3,}$/;
/** An option line: an optional ❯, an optional "N. ", the label (a " · hint" is not part of it). */
const OPTION_LINE = /^(❯\s*)?(?:\d+\.\s+)?(.*)$/;
/** Most lines between two options, and most non-empty lines under the last one (its footer). */
const OPTION_GAP = 2;
const FOOTER_LINES = 2;
/** Most non-empty lines under the input box's bottom rule (the footer and a tip line). */
const BOX_FOOTER_LINES = 3;
/** Most rows an input box may span. */
const BOX_ROWS = 60;

/** The pane's lines, plain and trimmed (indexes keep their place). */
const linesOf = (pane: string): string[] => pane.split('\n').map((l) => stripAnsi(l).trim());

const labelOf = (text: string): string => {
  const at = text.indexOf(' · ');
  return (at === -1 ? text : text.slice(0, at)).trim();
};

/** Non-empty lines in lines[from…to). */
const nonEmpty = (lines: string[], from: number, to: number): number =>
  lines.slice(from, to).filter((l) => l !== '').length;

/**
 * Which option the live screen's ❯ is on (0-based), or null. Each option must be drawn, in
 * order, close together, at the bottom of the screen (only a short footer below), with exactly
 * one of them carrying the ❯.
 */
export function cursorIndex(pane: string, options: string[]): number | null {
  if (options.length === 0) return null;
  const lines = linesOf(pane);
  const last = lines.findLastIndex((l) => l !== '');
  // Walk up from the bottom: the last option first, each earlier one just above the next.
  const at: number[] = [];
  let from = last;
  for (let k = options.length - 1; k >= 0; k--) {
    const want = options[k];
    let found = -1;
    const limit = k === options.length - 1 ? FOOTER_LINES : OPTION_GAP;
    for (let i = from, seen = 0; i >= 0 && seen <= limit; i--) {
      const l = lines[i] as string;
      if (l === '') continue;
      if (labelOf((OPTION_LINE.exec(l) as RegExpExecArray)[2] as string) === want) {
        found = i;
        break;
      }
      seen++;
    }
    if (found === -1) return null;
    at.unshift(found);
    from = found - 1;
  }
  const marked = at.flatMap((i, k) => ((lines[i] as string).startsWith('❯') ? [k] : []));
  return marked.length === 1 ? (marked[0] as number) : null;
}

/**
 * The idle input box's text after "❯ " (the ❯ is followed by a no-break space), its wrapped rows
 * joined; "" when empty; null unless the box is live at the bottom of the pane (between two
 * full rules, with only its footer under it) and no prompt or startup screen shows. A ghost
 * suggestion reads like typed text here (integration §7).
 */
export function inputLine(pane: string): string | null {
  if (showsPrompt(pane)) return null;
  const lines = linesOf(pane);
  const bottom = lines.findLastIndex((l) => FULL_RULE.test(l));
  if (bottom === -1 || nonEmpty(lines, bottom + 1, lines.length) > BOX_FOOTER_LINES) return null;
  const top = lines.findLastIndex((l, i) => i < bottom && FULL_RULE.test(l));
  if (top === -1 || bottom - top < 2 || bottom - top > BOX_ROWS + 1) return null;
  const first = lines[top + 1] as string;
  if (!first.startsWith('❯')) return null;
  const rows = [first.slice(1), ...lines.slice(top + 2, bottom)].map((r) => r.trim());
  return rows
    .filter((r) => r !== '')
    .join(' ')
    .trim();
}

/** K9: a burst longer than this many UTF-16 units shows as a paste placeholder. */
const PASTE_UNITS = 800;
/** One placeholder, alone in the box. */
const PLACEHOLDER = /^\[Pasted text #\d+( \+\d+ lines)?\]$/;
/** How much of the reply must show at the start of the box. */
const PREFIX_CHARS = 20;

const noSpace = (s: string): string => s.replace(/\s+/g, '');

/**
 * True when the live input box holds `text`: it starts with the text's first 20 characters
 * (whitespace collapsed) and holds nothing beyond the text, so leftover typing before or after
 * it would not be sent along; or, for a reply over 800 UTF-16 units, the box holds exactly one
 * paste placeholder (K9). The text is compared as a capture shows it (format characters dropped).
 */
export function inputShows(pane: string, text: string): boolean {
  const box = inputLine(pane);
  if (box === null) return false;
  if (text.length > PASTE_UNITS && PLACEHOLDER.test(box)) return true;
  const want = noSpace(stripAnsi(text));
  const got = noSpace(box);
  const prefix = noSpace(
    [...stripAnsi(text).replace(/\s+/g, ' ').trim()].slice(0, PREFIX_CHARS).join(''),
  );
  return want !== '' && got.startsWith(prefix) && got.length <= want.length;
}
