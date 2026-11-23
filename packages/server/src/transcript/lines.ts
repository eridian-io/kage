import type { DisplayLine, Question } from '@kage/shared';
import { stripAnsi } from '../text/ansi.ts';
import { boundQuestion, clip as clipTo, plainLine } from '../text/bounds.ts';

/** Turns Claude Code transcript records (one JSON object per JSONL line) into board lines. */

/** Most `out` lines per tool result. */
const MAX_OUT_LINES = 3;
/** Most `add`/`del` lines per edit. */
const MAX_DIFF_LINES = 12;
/** Longest `out`, diff or detail text, in characters. */
const MAX_TEXT = 200;
/** Longest `say` text, in characters. */
const MAX_SAY = 2000;
/** Characters of a Bash command shown in the now line. */
const NOW_COMMAND = 60;

const THINKING: DisplayLine = { kind: 'think', text: 'Thinking…' };
/** User string content that is Claude Code's own, not typed by the user. */
const LOCAL_PREFIXES = ['<command-name>', '<local-command-stdout>', '<local-command-caveat>'];
const INTERRUPT_PREFIX = '[Request interrupted by user';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** The `message.content` of a record of the given type, or undefined. */
function content(record: unknown, type: 'user' | 'assistant'): unknown {
  if (!isObj(record) || record.type !== type || !isObj(record.message)) return undefined;
  return record.message.content;
}

/** The content blocks of a record of the given type ([] when content isn't an array). */
function blocks(record: unknown, type: 'user' | 'assistant'): Obj[] {
  const c = content(record, type);
  return Array.isArray(c) ? c.filter(isObj) : [];
}

/** Cuts text to `max` characters (default 200), ending with "…" when cut. */
const clip = (text: string, max = MAX_TEXT): string => clipTo(text, max);

/**
 * One line of plain text (`plainLine`): line breaks become spaces; escape sequences, control
 * characters, and bidi and format characters go; then it is clipped.
 */
const plain = (text: string): string => plainLine(text, MAX_TEXT);

/** Say text: escape sequences and control characters go per line, line breaks stay; clipped. */
function sayText(text: string): string {
  const lines = text.slice(0, MAX_SAY * 4).split('\n');
  return clip(lines.map((l) => stripAnsi(l)).join('\n'), MAX_SAY);
}

/** One pasted block, as Claude Code writes it: `<pasted_content id="n">`, text, `</pasted_content id="n">`. */
const OPENER = /<pasted_content id="([^"]{0,40})">\n?/g;
const CLOSER = /\n?<\/pasted_content id="([^"]{0,40})">\n?/g;

/**
 * K10b: a prompt's pasted blocks become "[pasted text] <first line>", one marker per paste id
 * (a long paste arrives as several blocks with the same id); typed text keeps its place.
 */
function unwrapPasted(text: string): string {
  if (!text.includes('<pasted_content')) return text;
  // One linear pass finds every closer; each opener then takes the next closer of its id after
  // it (a pointer per id only moves forward), so unterminated openers cost nothing extra.
  const closers = new Map<string, { start: number; end: number }[]>();
  for (const m of text.matchAll(CLOSER)) {
    const list = closers.get(m[1] as string) ?? [];
    list.push({ start: m.index, end: m.index + m[0].length });
    closers.set(m[1] as string, list);
  }
  const next = new Map<string, number>();
  const seen = new Set<string>();
  let out = '';
  let pos = 0;
  for (const m of text.matchAll(OPENER)) {
    if (m.index < pos) continue; // inside a block already taken
    const id = m[1] as string;
    const list = closers.get(id) ?? [];
    let i = next.get(id) ?? 0;
    const bodyStart = m.index + m[0].length;
    while (
      i < list.length &&
      (list[i] as { start: number }).start < bodyStart - (m[0].endsWith('\n') ? 1 : 0)
    )
      i++;
    next.set(id, i);
    const closer = list[i];
    if (!closer) continue; // unterminated or mismatched: shown raw
    out += text.slice(pos, m.index);
    if (!seen.has(id)) {
      seen.add(id);
      const first = text
        .slice(bodyStart, closer.start)
        .split('\n')
        .find((l) => l.trim() !== '');
      out += `[pasted text] ${(first ?? '').trim()}\n`;
    }
    pos = closer.end;
  }
  return (out + text.slice(pos)).trim();
}

/** Path relative to cwd when inside it; otherwise unchanged. */
function relative(path: string, cwd: unknown): string {
  if (typeof cwd !== 'string' || cwd === '') return path;
  const base = cwd.endsWith('/') ? cwd : `${cwd}/`;
  return path.startsWith(base) && path.length > base.length ? path.slice(base.length) : path;
}

function toolLine(block: Obj, cwd: unknown): DisplayLine | null {
  const name = str(block.name);
  if (!name) return null;
  const input = isObj(block.input) ? block.input : {};
  const path = str(input.file_path);
  switch (name) {
    case 'Edit':
    case 'Write':
    case 'Read': {
      const text = name === 'Edit' ? 'Update' : name;
      return path
        ? { kind: 'tool', text, detail: plain(relative(path, cwd)) }
        : { kind: 'tool', text };
    }
    case 'Bash': {
      const command = str(input.command);
      return command
        ? { kind: 'tool', text: name, detail: plain(command) }
        : { kind: 'tool', text: name };
    }
    case 'Grep':
    case 'Glob': {
      const pattern = str(input.pattern);
      return pattern
        ? { kind: 'tool', text: name, detail: plain(pattern) }
        : { kind: 'tool', text: name };
    }
    default:
      return { kind: 'tool', text: name };
  }
}

/** The first MAX_OUT_LINES non-blank lines of a text, without splitting all of it. */
function firstLines(text: string, into: DisplayLine[]): void {
  let start = 0;
  while (into.length < MAX_OUT_LINES && start <= text.length) {
    let end = text.indexOf('\n', start);
    if (end === -1) end = text.length;
    // Look at a bounded slice only, so a multi-megabyte line costs no more than a short one.
    const raw = text.slice(start, Math.min(end, start + MAX_TEXT * 4));
    const line = stripAnsi(raw).trimEnd();
    if (line.trim() !== '') into.push({ kind: 'out', text: clip(line) });
    start = end + 1;
  }
}

function resultText(c: unknown): string[] {
  if (typeof c === 'string') return [c];
  if (!Array.isArray(c)) return [];
  return c
    .filter(isObj)
    .flatMap((b) => (b.type === 'text' && typeof b.text === 'string' ? [b.text] : []));
}

function diffLines(patch: unknown[]): DisplayLine[] {
  const out: DisplayLine[] = [];
  for (const hunk of patch) {
    if (!isObj(hunk) || !Array.isArray(hunk.lines)) continue;
    for (const l of hunk.lines) {
      if (out.length >= MAX_DIFF_LINES) return out;
      if (typeof l !== 'string') continue;
      if (l.startsWith('-')) out.push({ kind: 'del', text: plain(l.slice(1)) });
      else if (l.startsWith('+')) out.push({ kind: 'add', text: plain(l.slice(1)) });
    }
  }
  return out;
}

function resultLines(record: Obj, block: Obj): DisplayLine[] {
  if (record.toolDenialKind === 'user-rejected') return [{ kind: 'out', text: 'Denied' }];
  const tur = record.toolUseResult;
  if (block.is_error !== true && isObj(tur)) {
    // Edit and Write: the diff stands in for the "updated successfully" text.
    if (Array.isArray(tur.structuredPatch)) return diffLines(tur.structuredPatch);
    // Read: the file's text is not output worth showing.
    if (isObj(tur.file)) return [];
  }
  const out: DisplayLine[] = [];
  for (const text of resultText(block.content)) firstLines(text, out);
  return out;
}

/** True for a user record whose string content Claude Code wrote itself. */
function isLocal(record: Obj, text: string): boolean {
  return record.isMeta === true || LOCAL_PREFIXES.some((p) => text.startsWith(p));
}

/** Display lines for one record; [] for anything it doesn't know. */
export function toDisplayLines(record: unknown): DisplayLine[] {
  if (!isObj(record)) return [];
  if (record.type === 'user') {
    const c = content(record, 'user');
    if (typeof c === 'string') {
      if (isLocal(record, c) || c.startsWith(INTERRUPT_PREFIX)) return [];
      return [{ kind: 'say', text: sayText(`> ${unwrapPasted(c)}`) }];
    }
    return blocks(record, 'user').flatMap((b) =>
      b.type === 'tool_result' ? resultLines(record, b) : [],
    );
  }
  if (record.type === 'assistant') {
    const out: DisplayLine[] = [];
    for (const b of blocks(record, 'assistant')) {
      if (b.type === 'text' && typeof b.text === 'string') {
        const text = sayText(b.text);
        if (text.trim() !== '') out.push({ kind: 'say', text });
      } else if (b.type === 'thinking') {
        if (out.at(-1)?.kind !== 'think') out.push(THINKING);
      } else if (b.type === 'tool_use') {
        const line = toolLine(b, record.cwd);
        if (line) out.push(line);
      }
    }
    return out;
  }
  return [];
}

/** The AskUserQuestion tool_use block of a record, if it has one. */
export function askBlock(record: unknown): Obj | null {
  return (
    blocks(record, 'assistant').find(
      (b) => b.type === 'tool_use' && b.name === 'AskUserQuestion',
    ) ?? null
  );
}

/** AskUserQuestion → {text, options}: the first question's text and its option labels in order. */
export function questionFrom(record: unknown): Question | null {
  const block = askBlock(record);
  if (!block || !isObj(block.input) || !Array.isArray(block.input.questions)) return null;
  const q = block.input.questions[0];
  if (!isObj(q) || typeof q.question !== 'string') return null;
  const options = Array.isArray(q.options)
    ? q.options.flatMap((o) => (isObj(o) && typeof o.label === 'string' ? [o.label] : []))
    : [];
  return boundQuestion(q.question, options);
}

/** The tool_use_ids answered by the tool_result blocks of a user record. */
export function answeredIds(record: unknown): string[] {
  return blocks(record, 'user').flatMap((b) =>
    b.type === 'tool_result' && typeof b.tool_use_id === 'string' ? [b.tool_use_id] : [],
  );
}

/**
 * True for a record that closes the turn: system/turn_duration, system/stop_hook_summary (written
 * when Stop hooks ran, just before turn_duration), or the assistant reply that ends it
 * (`message.stop_reason` "end_turn"). Recorded on 2.1.330 (fixture real-short-turn.jsonl).
 * A subagent's records (`isSidechain: true`) end the subagent's turn, not the session's.
 */
export function endsTurn(record: unknown): boolean {
  if (!isObj(record) || record.isSidechain === true) return false;
  if (record.type === 'system') {
    return record.subtype === 'turn_duration' || record.subtype === 'stop_hook_summary';
  }
  return (
    record.type === 'assistant' &&
    isObj(record.message) &&
    record.message.stop_reason === 'end_turn'
  );
}

/** The "now doing" line a record implies, or null when it implies none. */
export function nowLine(record: unknown): string | null {
  if (!isObj(record)) return null;
  let now: string | null = null;
  for (const b of blocks(record, 'assistant')) {
    if (b.type === 'thinking') now = 'Thinking';
    if (b.type !== 'tool_use') continue;
    const input = isObj(b.input) ? b.input : {};
    const path = str(input.file_path);
    switch (b.name) {
      case 'Bash': {
        const command = str(input.command);
        if (command) {
          now = `Running ${plain(command).replace(/\s+/g, ' ').trim().slice(0, NOW_COMMAND)}`;
        }
        break;
      }
      case 'Edit':
      case 'Write':
        if (path) now = `Editing ${plain(relative(path, record.cwd))}`;
        break;
      case 'Read':
        if (path) now = `Reading ${plain(relative(path, record.cwd))}`;
        break;
      case 'Grep':
      case 'Glob': {
        const pattern = str(input.pattern);
        if (pattern) now = `Searching ${plain(pattern)}`;
        break;
      }
      case 'AskUserQuestion':
        now = 'Asking a question';
        break;
    }
  }
  return now;
}

/**
 * R11: true for a user rejection (No or Esc on a prompt), which fires no hook: a tool_result
 * with `toolDenialKind: "user-rejected"`, or a user text starting "[Request interrupted by user".
 */
export function interrupted(record: unknown): boolean {
  if (!isObj(record) || record.type !== 'user') return false;
  const c = content(record, 'user');
  if (typeof c === 'string') return record.isMeta !== true && c.startsWith(INTERRUPT_PREFIX);
  return blocks(record, 'user').some(
    (b) =>
      (b.type === 'tool_result' && record.toolDenialKind === 'user-rejected') ||
      (b.type === 'text' && typeof b.text === 'string' && b.text.startsWith(INTERRUPT_PREFIX)),
  );
}
