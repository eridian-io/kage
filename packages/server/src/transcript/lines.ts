import type { DisplayLine, Question } from '@kage/shared';
import { stripAnsi } from '../pane/prompt.ts';

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

/** Cuts text to `max` characters, ending with "…" when cut; never splits a surrogate pair. */
function clip(text: string, max = MAX_TEXT): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, max - 1);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/**
 * One line of plain text: line breaks become spaces, escape sequences and control characters go,
 * and the result is clipped. Only a bounded prefix is looked at.
 */
function plain(text: string): string {
  return clip(stripAnsi(text.slice(0, MAX_TEXT * 4).replace(/\r?\n/g, ' ')));
}

/** Say text: escape sequences and control characters go per line, line breaks stay; clipped. */
function sayText(text: string): string {
  const lines = text.slice(0, MAX_SAY * 4).split('\n');
  return clip(lines.map(stripAnsi).join('\n'), MAX_SAY);
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
      return [{ kind: 'say', text: sayText(`> ${c}`) }];
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
  return { text: q.question, options };
}

/** The tool_use_ids answered by the tool_result blocks of a user record. */
export function answeredIds(record: unknown): string[] {
  return blocks(record, 'user').flatMap((b) =>
    b.type === 'tool_result' && typeof b.tool_use_id === 'string' ? [b.tool_use_id] : [],
  );
}

/** True for a system/turn_duration record: the turn is over. */
export function endsTurn(record: unknown): boolean {
  return isObj(record) && record.type === 'system' && record.subtype === 'turn_duration';
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
        if (command) now = `Running ${command.replace(/\s+/g, ' ').trim().slice(0, NOW_COMMAND)}`;
        break;
      }
      case 'Edit':
      case 'Write':
        if (path) now = `Editing ${relative(path, record.cwd)}`;
        break;
      case 'Read':
        if (path) now = `Reading ${relative(path, record.cwd)}`;
        break;
      case 'Grep':
      case 'Glob': {
        const pattern = str(input.pattern);
        if (pattern) now = `Searching ${pattern}`;
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
