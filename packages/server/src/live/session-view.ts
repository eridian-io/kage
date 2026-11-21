import { posix } from 'node:path';
import type { DisplayLine, Question, Session, SessionStatus } from '@kage/shared';
import { disabledOptions, type PromptKind } from '../control/keys.ts';
import type { SessionRecord } from '../state/store.ts';
import { boundQuestion } from '../text/bounds.ts';
import type { TmuxWindow } from '../tmux/format.ts';

/** Pane activity this recent means running (spec §5.3, external windows without hooks). */
export const ACTIVE_MS = 5000;

/** The visible parts of one live session, as LiveSource keeps them. */
export interface SessionView {
  id: string;
  record: SessionRecord | null;
  window: TmuxWindow | null;
  /** Epoch ms when Kage first saw an external window. */
  firstSeen: number;
  status: SessionStatus;
  statusSince: number;
  question: Question | null;
  /** How the question is answered; it decides which options are disabled (R39). */
  promptKind?: PromptKind | null;
  now: string | null;
}

/** The wire Session for a live session; `lines` is always [] (lines travel separately). */
export function toSession(v: SessionView): Session {
  const r = v.record;
  const w = v.window;
  const cwd = w?.cwd ?? '';
  const s: Session = {
    id: v.id,
    status: v.status,
    project: r ? r.project : posix.basename(cwd) || (w?.name ?? ''),
    task: r ? r.task : (w?.name ?? ''),
    branch: r ? r.branch : '',
    worktree: r ? r.worktree : cwd,
    startedAt: r ? r.createdAt : v.firstSeen,
    statusSince: v.statusSince,
    pinned: r ? r.pinned : false,
    archived: r ? r.archived : false,
    external: r === null,
    unpushed: 0,
    lines: [],
    ports: [],
    files: [],
    filesTotal: 0,
  };
  if (v.question) {
    s.question = { text: v.question.text, options: v.question.options.slice() };
    if (v.question.startup) s.question.startup = true;
    const off = disabledOptions(v.promptKind ?? null, v.question.options);
    if (off.length > 0) s.question.disabledOptions = off;
  }
  // The now line says what a running turn is doing; a finished or waiting one shows none (F3).
  if (v.now && v.status === 'running') s.now = v.now;
  return s;
}

const sameQuestion = (a: Question | undefined, b: Question | undefined): boolean =>
  a === b ||
  (a !== undefined &&
    b !== undefined &&
    a.text === b.text &&
    a.options.length === b.options.length &&
    a.options.every((o, i) => o === b.options[i]) &&
    (a.disabledOptions ?? []).join() === (b.disabledOptions ?? []).join() &&
    (a.startup ?? false) === (b.startup ?? false));

/**
 * Shallow compare of two sessions (the question by value; lines by length). Ports, files and
 * filesTotal are left out: they travel in their own events.
 */
export function sameSession(a: Session | null, b: Session): boolean {
  if (!a) return false;
  for (const key of Object.keys(b) as (keyof Session)[]) {
    if (key === 'question' || key === 'ports' || key === 'files' || key === 'filesTotal') continue;
    const x = a[key];
    const y = b[key];
    if (Array.isArray(x) && Array.isArray(y)) {
      if (x.length !== y.length) return false;
    } else if (x !== y) return false;
  }
  return Object.keys(a).length === Object.keys(b).length && sameQuestion(a.question, b.question);
}

export const sameLines = (a: DisplayLine[], b: DisplayLine[]): boolean =>
  a.length === b.length &&
  a.every((l, i) => {
    const m = b[i] as DisplayLine;
    return l.kind === m.kind && l.text === m.text && l.detail === m.detail;
  });

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** AskUserQuestion's hook `tool_input` → the first question and its option labels, bounded. */
export function questionFromToolInput(input: unknown): Question | null {
  if (!isObj(input) || !Array.isArray(input.questions)) return null;
  const q = input.questions[0];
  if (!isObj(q) || typeof q.question !== 'string') return null;
  const options = Array.isArray(q.options)
    ? q.options.flatMap((o) => (isObj(o) && typeof o.label === 'string' ? [o.label] : []))
    : [];
  return boundQuestion(q.question, options);
}

/**
 * AskUserQuestion's hook `tool_input` → each question's multiSelect, keyed by its question text
 * as the card shows it (bounded, whitespace collapsed).
 */
export function multiSelectByQuestion(input: unknown): Map<string, boolean> {
  const out = new Map<string, boolean>();
  if (!isObj(input) || !Array.isArray(input.questions)) return out;
  for (const q of input.questions) {
    if (!isObj(q) || typeof q.question !== 'string') continue;
    const text = boundQuestion(q.question, []).text.replace(/ +/g, ' ').trim();
    out.set(text, q.multiSelect === true);
  }
  return out;
}

export const questionKey = (q: Question | null): string | null =>
  q ? JSON.stringify([q.text, q.options]) : null;
