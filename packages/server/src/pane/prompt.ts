import type { DisplayLine, Question } from '@kage/shared';
import { stripAnsi } from '../text/ansi.ts';
import { boundQuestion, clip, MAX_QUESTION, plainLine } from '../text/bounds.ts';

/**
 * Reads `tmux capture-pane -p -J` text: permission prompts, AskUserQuestion panes and startup
 * screens (formats recorded in docs/specs/claude-code-integration.md §2, §3, §5, §6), and the
 * fallback lines shown when there is no transcript. Everything returned is plain text.
 *
 * Claude's TUI wraps long text itself (`-J` only joins tmux's own wraps), so wrapped option
 * labels, question lines and startup phrases are joined back here.
 */

/** Longest fallback line, in characters. */
const MAX_LINE = 200;
/**
 * Startup screens are small: a phrase must sit within the last non-empty lines and within the
 * last text blocks (runs of non-empty lines). A long path or paragraph wrapped over many lines
 * stays one block, so it can't push the phrase out, while older scrollback still can't match.
 */
const STARTUP_LINES = 40;
const STARTUP_BLOCKS = 12;
/** Most lines between numbered options (descriptions, rules) and between the last one and the footer. */
const MAX_GAP = 6;

/** The pane's lines without escapes or trailing spaces; indentation stays. */
const rawLines = (pane: string): string[] => pane.split('\n').map((l) => stripAnsi(l).trimEnd());

/** The pane as clean, trimmed lines (nothing is dropped, so indexes keep their place). */
function cleanLines(pane: string): string[] {
  return rawLines(pane).map((l) => l.trim());
}

const OPTION = /^\s*(❯\s*)?(\d+)\.\s+(.*)$/;
const FOOTER = /^(Esc to cancel|Enter to select)/;
const FULL_RULE = /^─{3,}$/;
const DASHED_RULE = /^╌{3,}$/;
const TITLE = /^(Bash command|\w+ file)$/;
/** Options the AskUserQuestion UI adds after the real ones. */
const UI_OPTION = /^(Type something\.?|Chat about this)$/;

/** Option text after "N. ", without a trailing " · hint". */
const optionLabel = (text: string): string => {
  const at = text.indexOf(' · ');
  return (at === -1 ? text : text.slice(0, at)).trim();
};

/** The detail under a permission title: a Bash command, or the file name under an edit title. */
function detailOf(segment: string[]): string {
  const first = segment.findIndex((l) => l !== '');
  if (first === -1) return '';
  const title = segment[first] as string;
  if (!TITLE.test(title)) return '';
  const rest = segment.slice(first + 1);
  if (title.endsWith('command')) {
    const a = rest.findIndex((l) => DASHED_RULE.test(l));
    const b = a === -1 ? -1 : rest.findIndex((l, i) => i > a && DASHED_RULE.test(l));
    if (a === -1 || b === -1) return '';
    return rest
      .slice(a + 1, b)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  return rest.find((l) => l !== '' && !DASHED_RULE.test(l)) ?? '';
}

/** The pane's width as far as the text shows it: its longest line (a full rule spans it). */
const paneWidth = (raw: string[]): number => raw.reduce((w, l) => Math.max(w, l.length), 0);

const indentOf = (l: string): number => l.length - l.trimStart().length;

/**
 * True when `next` continues `line`, wrapped by Claude's TUI: the first word of `next` would not
 * have fitted at the end of `line`. A short line followed by an indented one is something else,
 * such as an AskUserQuestion option's description.
 */
function wrapsInto(line: string, next: string, width: number): boolean {
  const word = next.trim().split(/\s+/)[0] ?? '';
  return word !== '' && line.length + 1 + word.length > width;
}

/** A trimmed line that is neither blank, an option, a rule nor a footer. */
const isText = (l: string): boolean =>
  l !== '' && !OPTION.test(l) && !FULL_RULE.test(l) && !DASHED_RULE.test(l) && !FOOTER.test(l);

/**
 * An option's text with the lines it wrapped onto: unnumbered lines, indented at least as far as
 * the option's text, each the wrapped rest of the line above.
 */
function wrappedOption(raw: string[], at: number, end: number, width: number): string {
  const line = raw[at] as string;
  let text = (OPTION.exec(line) as RegExpExecArray)[3] as string;
  const column = line.length - text.length;
  let prev = line;
  for (let j = at + 1; j < end; j++) {
    const l = raw[j] as string;
    if (!isText(l.trim()) || indentOf(l) < column || !wrapsInto(prev, l, width)) break;
    text += ` ${l.trim()}`;
    prev = l;
  }
  return text;
}

/**
 * The numbered prompt nearest the bottom of the pane (permission prompt or AskUserQuestion):
 * the question and every option in order, wrapped lines joined. Null unless a numbered run
 * starting at 1 is followed by the Esc/Enter footer, so numbered lists in Claude's own output
 * don't match. The result is bounded (500-character question, 10 options of 200).
 */
export function parsePermissionPrompt(pane: string): Question | null {
  return parsePrompt(rawLines(pane));
}

function parsePrompt(raw: string[]): Question | null {
  const lines = raw.map((l) => l.trim());
  // The footer must be the live bottom of the screen: only blank lines may follow it.
  const footer = lines.findLastIndex((l) => l !== '');
  if (footer === -1 || !FOOTER.test(lines[footer] as string)) return null;

  // Walk up from the footer collecting n, n-1, … 1; other lines (descriptions, rules) are skipped.
  const at: number[] = [];
  let expected: number | null = null;
  let gap = 0;
  for (let i = footer - 1; i >= 0 && gap <= MAX_GAP; i--) {
    const m = OPTION.exec(lines[i] as string);
    if (!m) {
      gap++;
      continue;
    }
    const n = Number(m[2]);
    if (expected !== null && n !== expected) break;
    at.unshift(i);
    expected = n - 1;
    gap = 0;
    if (n === 1) break;
  }
  if (expected !== 0) return null;

  const width = paneWidth(raw);
  const labels = at.map((i, k) => optionLabel(wrappedOption(raw, i, at[k + 1] ?? footer, width)));
  while (labels.length > 0 && UI_OPTION.test(labels.at(-1) as string)) labels.pop();
  if (labels.length === 0) return null;

  // The question: the last text line above option 1, with the lines it wrapped from.
  let end = (at[0] as number) - 1;
  while (end >= 0 && lines[end] === '') end--;
  if (end < 0) return null;
  let q = end;
  while (
    q > 0 &&
    isText(lines[q - 1] as string) &&
    wrapsInto(raw[q - 1] as string, raw[q] as string, width)
  ) {
    q--;
  }
  const question = lines.slice(q, end + 1).join(' ');

  let top = q - 1;
  while (top >= 0 && !FULL_RULE.test(lines[top] as string)) top--;
  const detail = detailOf(lines.slice(top + 1, q));
  // R52: the command takes the whole question bound, so commands alike at the start still differ.
  const text = detail ? `${question} — ${detail}` : question;
  const bounded = boundQuestion(text, labels);
  if (plainLine(text, MAX_QUESTION + 1).length > MAX_QUESTION) bounded.cut = true;
  return bounded;
}

const IDLE_FOOTER = /(\? for shortcuts|manual mode on|auto mode on)/;

/** True when Claude's idle input box (`❯` between two rules, or its footer) is on screen after `from`. */
function idleBoxBelow(lines: string[], from: number): boolean {
  for (let i = from + 1; i < lines.length; i++) {
    const l = lines[i] as string;
    if (IDLE_FOOTER.test(l)) return true;
    if (
      l.startsWith('❯') &&
      FULL_RULE.test(lines[i - 1] ?? '') &&
      FULL_RULE.test(lines[i + 1] ?? '')
    ) {
      return true;
    }
  }
  return false;
}

/** The last STARTUP_LINES non-empty lines, with the blank lines between them kept. */
function startupWindow(all: string[]): string[] {
  let from = all.length;
  let seen = 0;
  while (from > 0 && seen < STARTUP_LINES) {
    from--;
    if (all[from] !== '') seen++;
  }
  return all.slice(from);
}

/** True when the bottom of the pane shows Claude's idle input box: Claude is past its startup screens. */
export function showsIdleBox(pane: string): boolean {
  return idleBoxBelow(startupWindow(cleanLines(pane)), -1);
}

interface Block {
  text: string;
  /** Index of the block's first line. */
  at: number;
}

/** Runs of non-empty lines joined with spaces (a rule stands alone), so wrapped phrases match. */
function textBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let current: Block | null = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] as string;
    if (l === '' || FULL_RULE.test(l)) {
      current = null;
    } else if (current) {
      current.text += ` ${l}`;
    } else {
      current = { text: l, at: i };
      blocks.push(current);
    }
  }
  return blocks.slice(-STARTUP_BLOCKS);
}

/** Claude Code's startup screens (integration §6). */
export type StartupKind = 'login' | 'trust' | 'renderer' | 'security' | 'theme';
/** A startup screen: its card question, plus which screen it is (never on the wire, F8). */
export interface StartupScreen extends Question {
  screen: StartupKind;
}

/** The trust screen's unnumbered options, in the order trust.txt recorded (F9). */
const TRUST_OPTIONS = ['No, exit', 'Yes, I trust this folder'] as const;

/**
 * The trust options in the order the live screen draws them (the last line of each), so the
 * cursor plan follows the screen; the recorded order when either line is missing.
 */
function trustOptions(lines: string[]): string[] {
  const found = TRUST_OPTIONS.map((label) => ({
    label,
    at: lines.findLastIndex((l) => l.replace(/^❯\s*/, '') === label),
  }));
  if (found.some((f) => f.at === -1)) return [...TRUST_OPTIONS];
  return found.sort((a, b) => a.at - b.at).map((f) => f.label);
}

function parseStartup(all: string[]): StartupScreen | null {
  const lines = startupWindow(all);
  const blocks = textBlocks(lines);
  const first = blocks[0]?.at ?? lines.length;
  /** First line of the last block whose joined text matches `re`, or -1. */
  const find = (re: RegExp): number => blocks.findLast((b) => re.test(b.text))?.at ?? -1;
  /** The last single line matching `re` within the blocks, or -1 (for short lines that render alone). */
  const findLine = (re: RegExp): number => {
    const i = lines.findLastIndex((l) => re.test(l));
    return i >= first ? i : -1;
  };
  const live = (...at: number[]): boolean =>
    at.every((i) => i >= 0) && !idleBoxBelow(lines, Math.min(...at));
  if (live(find(/Select login method/))) {
    return { text: 'Sign in to Claude Code in the terminal', options: [], screen: 'login' };
  }
  if (
    live(find(/Is this a project you created or one you trust\?/)) ||
    live(
      findLine(/^Accessing workspace:$/),
      findLine(/^(❯\s*)?(\d+\.\s+)?Yes, I trust this folder$/),
    )
  ) {
    return { text: 'Trust this folder?', options: trustOptions(lines), screen: 'trust' };
  }
  if (live(find(/Try the new fullscreen renderer\?/))) {
    return {
      text: 'Try the new fullscreen renderer?',
      options: ['Yes, try it', 'Not now'],
      screen: 'renderer',
    };
  }
  if (live(find(/Security notes/), find(/Press Enter to continue/))) {
    return { text: 'Security notes', options: ['Continue'], screen: 'security' };
  }
  if (live(find(/Choose the text style/))) {
    const numbered = lines.flatMap((l) => {
      const m = OPTION.exec(l);
      return m ? [optionLabel(m[3] as string)] : [];
    });
    const q = boundQuestion('Choose a text style', numbered.length > 0 ? numbered : ['Continue']);
    return { ...q, screen: 'theme' };
  }
  return null;
}

/** Recognises Claude Code's startup screens (R9) by their recorded key phrases. */
export function parseStartupScreen(pane: string): StartupScreen | null {
  return parseStartup(cleanLines(pane));
}

/** True when the pane shows a permission prompt, a question or a startup screen. */
export function showsPrompt(pane: string): boolean {
  const raw = rawLines(pane);
  return parsePrompt(raw) !== null || parseStartup(raw.map((l) => l.trim())) !== null;
}

/** What Claude shows under the tool line after No or Esc on a prompt (spec §1, R11). */
const DENIAL = /^⎿\s+Interrupted · What should Claude do instead\?/;
/** The denial must be live: within this many non-empty lines of the bottom, above the input box. */
const DENIAL_WINDOW = 8;

/** True when the bottom of the pane shows Claude's denial line: a prompt was answered No or Esc. */
export function showsDenial(pane: string): boolean {
  return cleanLines(pane)
    .filter((l) => l !== '')
    .slice(-DENIAL_WINDOW)
    .some((l) => DENIAL.test(l));
}

/**
 * True when the denial line sits right under the last tool line (`● …`) on screen: the answer
 * just given was No. An older denial above a later tool line doesn't count.
 */
export function showsDenialLast(pane: string): boolean {
  const lines = cleanLines(pane).filter((l) => l !== '');
  const tool = lines.findLastIndex((l) => l.startsWith('●'));
  return tool !== -1 && DENIAL.test(lines[tool + 1] ?? '') && showsDenial(pane);
}

/**
 * Which numbered prompt is on screen: an AskUserQuestion (footer `Enter to select …`) or a
 * permission prompt (footer `Esc to cancel …`); null when there is none.
 */
export function numberedPromptKind(pane: string): 'permission' | 'ask' | null {
  const raw = rawLines(pane);
  if (parsePrompt(raw) === null) return null;
  const footer = raw.findLast((l) => l.trim() !== '')?.trim() ?? '';
  return footer.startsWith('Enter to select') ? 'ask' : 'permission';
}

/** Cuts the input box (rule, `❯ …`, rule) and the footer under it from the bottom of the lines. */
function withoutInputBox(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1]?.trim() === '') end--;
  const kept = lines.slice(0, end);
  const bottom = kept.findLastIndex((l) => FULL_RULE.test(l.trim()));
  if (bottom === -1 || kept.length - bottom - 1 > 2) return kept;
  const top = kept.findLastIndex((l, i) => i < bottom && FULL_RULE.test(l.trim()));
  if (top === -1 || bottom - top > 4) return kept;
  if (!kept.slice(top + 1, bottom).some((l) => l.trim().startsWith('❯'))) return kept;
  return kept.slice(0, top);
}

/**
 * Fallback lines when there is no transcript: the last `max` non-empty pane lines as `out`
 * lines, without rules or the input box and footer at the bottom, each at most 200 characters.
 */
export function paneLines(pane: string, max: number): DisplayLine[] {
  const lines = withoutInputBox(pane.split('\n').map((l) => stripAnsi(l).trimEnd()));
  return lines
    .filter((l) => l.trim() !== '' && !FULL_RULE.test(l.trim()))
    .slice(-max)
    .map((text) => ({ kind: 'out', text: clip(text, MAX_LINE) }));
}
