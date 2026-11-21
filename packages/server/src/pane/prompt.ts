import type { DisplayLine, Question } from '@kage/shared';
import { stripAnsi } from '../text/ansi.ts';

/**
 * Reads `tmux capture-pane -p -J` text: permission prompts, AskUserQuestion panes and startup
 * screens (formats recorded in docs/specs/claude-code-integration.md §2, §3, §5, §6), and the
 * fallback lines shown when there is no transcript. Everything returned is plain text.
 */

/** Longest fallback line and longest command shown in a prompt's text, in characters. */
const MAX_LINE = 200;
const MAX_COMMAND = 120;
/** Startup screens are small: the phrase must sit within the last non-empty lines. */
const STARTUP_WINDOW = 15;
/** Most lines between numbered options (descriptions, rules) and between the last one and the footer. */
const MAX_GAP = 6;

/** The pane as clean, trimmed lines (nothing is dropped, so indexes keep their place). */
function cleanLines(pane: string): string[] {
  return pane.split('\n').map((l) => stripAnsi(l).trim());
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

/** Cuts to `max` characters, ending with "…" when cut. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, max - 1);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut}…`;
}

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

/**
 * The numbered prompt nearest the bottom of the pane (permission prompt or AskUserQuestion):
 * the question line and every option in order. Null unless a numbered run starting at 1 is
 * followed by the Esc/Enter footer, so numbered lists in Claude's own output don't match.
 */
export function parsePermissionPrompt(pane: string): Question | null {
  return parsePrompt(cleanLines(pane));
}

function parsePrompt(lines: string[]): Question | null {
  // The footer must be the live bottom of the screen: only blank lines may follow it.
  const footer = lines.findLastIndex((l) => l !== '');
  if (footer === -1 || !FOOTER.test(lines[footer] as string)) return null;

  // Walk up from the footer collecting n, n-1, … 1; other lines (descriptions, rules) are skipped.
  const labels: string[] = [];
  let expected: number | null = null;
  let firstAt = -1;
  let gap = 0;
  for (let i = footer - 1; i >= 0 && gap <= MAX_GAP; i--) {
    const m = OPTION.exec(lines[i] as string);
    if (!m) {
      gap++;
      continue;
    }
    const n = Number(m[2]);
    if (expected !== null && n !== expected) break;
    labels.unshift(optionLabel(m[3] as string));
    expected = n - 1;
    firstAt = i;
    gap = 0;
    if (n === 1) break;
  }
  if (expected !== 0) return null;

  while (labels.length > 0 && UI_OPTION.test(labels.at(-1) as string)) labels.pop();
  if (labels.length === 0) return null;

  let q = firstAt - 1;
  while (q >= 0 && lines[q] === '') q--;
  if (q < 0) return null;
  const question = lines[q] as string;

  let top = q - 1;
  while (top >= 0 && !FULL_RULE.test(lines[top] as string)) top--;
  const detail = detailOf(lines.slice(top + 1, q));
  return {
    text: detail ? `${question} — ${clip(detail, MAX_COMMAND)}` : question,
    options: labels,
  };
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

function parseStartup(all: string[]): Question | null {
  const lines = all.filter((l) => l !== '').slice(-STARTUP_WINDOW);
  /** Index of the last line matching `re`, or -1. */
  const find = (re: RegExp): number => lines.findLastIndex((l) => re.test(l));
  const live = (...at: number[]): boolean =>
    at.every((i) => i >= 0) && !idleBoxBelow(lines, Math.min(...at));
  if (live(find(/Select login method/))) {
    return { text: 'Sign in to Claude Code in the terminal', options: [] };
  }
  if (live(find(/Is this a project you created or one you trust\?/))) {
    return { text: 'Trust this folder?', options: ['No, exit', 'Yes, I trust this folder'] };
  }
  if (live(find(/Try the new fullscreen renderer\?/))) {
    return { text: 'Try the new fullscreen renderer?', options: ['Yes, try it', 'Not now'] };
  }
  if (live(find(/Security notes/), find(/Press Enter to continue/))) {
    return { text: 'Security notes', options: ['Continue'] };
  }
  if (live(find(/Choose the text style/))) {
    const numbered = lines.flatMap((l) => {
      const m = OPTION.exec(l);
      return m ? [optionLabel(m[3] as string)] : [];
    });
    return { text: 'Choose a text style', options: numbered.length > 0 ? numbered : ['Continue'] };
  }
  return null;
}

/** Recognises Claude Code's startup screens (R9) by their recorded key phrases. */
export function parseStartupScreen(pane: string): Question | null {
  return parseStartup(cleanLines(pane));
}

/** True when the pane shows a permission prompt, a question or a startup screen. */
export function showsPrompt(pane: string): boolean {
  const lines = cleanLines(pane);
  return parsePrompt(lines) !== null || parseStartup(lines) !== null;
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
