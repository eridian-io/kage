import type { DisplayLine, Question } from '@kage/shared';

/**
 * Reads `tmux capture-pane -p -J` text: permission prompts, AskUserQuestion panes and startup
 * screens (formats recorded in docs/specs/claude-code-integration.md §2, §3, §5, §6), and the
 * fallback lines shown when there is no transcript. Everything returned is plain text.
 */

const ESC = 0x1b;
const BEL = 0x07;

/** Longest fallback line and longest command shown in a prompt's text, in characters. */
const MAX_LINE = 200;
const MAX_COMMAND = 120;
/** Startup screens are small: only the last lines of the pane can be one. */
const STARTUP_WINDOW = 30;
/** Most lines between numbered options (descriptions, rules) and between the last one and the footer. */
const MAX_GAP = 6;

/** Removes terminal escape sequences (CSI, OSC including OSC 8 links, others) and control characters other than tab. */
export function stripAnsi(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    const next = text[i + 1];
    if (c === ESC && next === '[') {
      // CSI: parameter and intermediate bytes, then one final byte in @–~.
      i += 2;
      while (i < text.length && (text.charCodeAt(i) < 0x40 || text.charCodeAt(i) > 0x7e)) i++;
      i++;
    } else if (c === ESC && (next === ']' || next === 'P' || next === '_' || next === '^')) {
      // OSC, DCS, APC, PM: up to BEL or ESC \.
      i += 2;
      while (i < text.length && text.charCodeAt(i) !== BEL && text.charCodeAt(i) !== ESC) i++;
      if (text.charCodeAt(i) === ESC && text[i + 1] === '\\') i += 2;
      else if (text.charCodeAt(i) === BEL) i++;
    } else if (c === ESC) {
      // Other escapes: intermediate bytes (space to /), then one final byte.
      i++;
      while (i < text.length && text.charCodeAt(i) >= 0x20 && text.charCodeAt(i) <= 0x2f) i++;
      i++;
    } else {
      if (c === 0x09 || (c >= 0x20 && c < 0x7f) || c > 0x9f) out += text[i];
      i++;
    }
  }
  return out;
}

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
const optionLabel = (text: string): string => text.replace(/\s+·\s.*$/, '').trim();

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
  const lines = cleanLines(pane);
  const footer = lines.findLastIndex((l) => FOOTER.test(l));
  if (footer === -1) return null;

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

/** Recognises Claude Code's startup screens (R9) by their recorded key phrases. */
export function parseStartupScreen(pane: string): Question | null {
  const lines = cleanLines(pane)
    .filter((l) => l !== '')
    .slice(-STARTUP_WINDOW);
  const text = lines.join('\n');
  if (/Select login method/.test(text)) {
    return { text: 'Sign in to Claude Code in the terminal', options: [] };
  }
  if (/Is this a project you created or one you trust\?/.test(text)) {
    return { text: 'Trust this folder?', options: ['No, exit', 'Yes, I trust this folder'] };
  }
  if (/Try the new fullscreen renderer\?/.test(text)) {
    return { text: 'Try the new fullscreen renderer?', options: ['Yes, try it', 'Not now'] };
  }
  if (/Security notes/.test(text) && /Press Enter to continue/.test(text)) {
    return { text: 'Security notes', options: ['Continue'] };
  }
  if (/Choose the text style/.test(text)) {
    const numbered = lines.flatMap((l) => {
      const m = OPTION.exec(l);
      return m ? [optionLabel(m[3] as string)] : [];
    });
    return { text: 'Choose a text style', options: numbered.length > 0 ? numbered : ['Continue'] };
  }
  return null;
}

/** True when the pane shows a permission prompt, a question or a startup screen. */
export function showsPrompt(pane: string): boolean {
  return parsePermissionPrompt(pane) !== null || parseStartupScreen(pane) !== null;
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
