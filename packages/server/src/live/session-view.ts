import { posix } from 'node:path';
import type { DisplayLine, FileChange, Port, Question, Session, SessionStatus } from '@kage/shared';
import { disabledOptions, type PromptKind } from '../control/keys.ts';
import type { PreviewTarget } from '../preview/tracker.ts';
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
  /** Epoch ms (wall clock, from `now`; not monotonic) when Kage first saw an external window. */
  firstSeen: number;
  status: SessionStatus;
  statusSince: number;
  question: Question | null;
  /** How the question is answered; it decides which options are disabled (R39). */
  promptKind?: PromptKind | null;
  now: string | null;
  /** The latest preview values (Task 8); absent means none yet. */
  ports?: Port[];
  files?: FileChange[];
  filesTotal?: number;
  /** Why the list is empty (UNPINNED, security M4); absent when git ran. */
  filesNote?: string;
  /** A record's branch counts (Task 3), refreshed with the files; absent means none yet (0). */
  unpushed?: number;
  uncommitted?: number;
  ignored?: number;
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
    // External sessions never get counts: they keep 0.
    unpushed: r ? (v.unpushed ?? 0) : 0,
    uncommitted: r ? (v.uncommitted ?? 0) : 0,
    ignored: r ? (v.ignored ?? 0) : 0,
    lines: [],
    ports: (v.ports ?? []).map((p) => ({ ...p })),
    files: (v.files ?? []).map((f) => ({ ...f })),
    filesTotal: v.filesTotal ?? 0,
  };
  if (v.filesNote !== undefined) s.filesNote = v.filesNote;
  if (v.question) {
    s.question = { text: v.question.text, options: v.question.options.slice() };
    if (v.question.startup) s.question.startup = true;
    if (v.question.cut) s.question.cut = true;
    const off = disabledOptions(v.promptKind ?? null, v.question.options);
    if (off.length > 0) s.question.disabledOptions = off;
  }
  // The now line says what a running turn is doing; a finished or waiting one shows none (F3).
  if (v.now && v.status === 'running') s.now = v.now;
  return s;
}

/**
 * What the preview tracker needs (F6): a record's worktree, base, branch and base commit, or an external window's pane
 * cwd with no base; the pane pid while the window is live; active while running or needs you.
 * `repo` is the record's project folder, which its git is pinned to (security M4); an external
 * window gets null. Null when there is no folder to look at.
 */
export function previewTarget(v: SessionView, repo: string | null): PreviewTarget | null {
  const worktree = v.record ? v.record.worktree : (v.window?.cwd ?? '');
  if (worktree === '') return null;
  const live = v.window !== null && !v.window.dead && v.status !== 'ended';
  return {
    id: v.id,
    worktree,
    repo: v.record ? repo : null,
    base: v.record?.base ?? null,
    branch: v.record?.branch ?? null,
    baseCommit: v.record?.baseCommit ?? null,
    panePid: live && v.window ? v.window.panePid : null,
    active: v.status === 'running' || v.status === 'needs-you',
  };
}

const sameQuestion = (a: Question | undefined, b: Question | undefined): boolean =>
  a === b ||
  (a !== undefined &&
    b !== undefined &&
    a.text === b.text &&
    a.options.length === b.options.length &&
    a.options.every((o, i) => o === b.options[i]) &&
    (a.disabledOptions ?? []).join() === (b.disabledOptions ?? []).join() &&
    (a.startup ?? false) === (b.startup ?? false) &&
    (a.cut ?? false) === (b.cut ?? false));

/** Session keys sameSession leaves out (the question is compared by value). */
const OWN_EVENTS = new Set<keyof Session>([
  'question',
  'ports',
  'files',
  'filesTotal',
  'filesNote',
]);

/**
 * Shallow compare of two sessions (the question by value; lines by length). Ports, files,
 * filesTotal and filesNote are left out: they travel in their own events.
 */
export function sameSession(a: Session | null, b: Session): boolean {
  if (!a) return false;
  for (const key of Object.keys(b) as (keyof Session)[]) {
    if (OWN_EVENTS.has(key)) continue;
    const x = a[key];
    const y = b[key];
    if (Array.isArray(x) && Array.isArray(y)) {
      if (x.length !== y.length) return false;
    } else if (x !== y) return false;
  }
  return Object.keys(a).length === Object.keys(b).length && sameQuestion(a.question, b.question);
}

/** How a view differs from the last frame sent: not at all, in its now line only, or otherwise. */
export type ViewChange = 'none' | 'now' | 'other';

/** The view's question as toSession would send it equals `a` (sameQuestion, without building it). */
function sameViewQuestion(a: Question | undefined, v: SessionView): boolean {
  const q = v.question;
  if (!q || !a) return !q && !a;
  if (a.text !== q.text || a.options.length !== q.options.length) return false;
  if (!a.options.every((o, i) => o === q.options[i])) return false;
  if ((a.startup ?? false) !== (q.startup ?? false) || (a.cut ?? false) !== (q.cut ?? false)) {
    return false;
  }
  return (
    (a.disabledOptions ?? []).join() === disabledOptions(v.promptKind ?? null, q.options).join()
  );
}

/**
 * What the throttle needs to know (spec §5.5): the same answer as comparing `last` with
 * toSession(v) through sameSession, read straight from the view so a burst of hooks builds no
 * Session. Ports, files and filesTotal travel in their own events and are left out, as there.
 */
export function viewChange(last: Session | null, v: SessionView): ViewChange {
  if (!last) return 'other';
  if (last.status !== v.status || last.statusSince !== v.statusSince) return 'other';
  const r = v.record;
  if (r) {
    if (
      last.external ||
      last.project !== r.project ||
      last.task !== r.task ||
      last.branch !== r.branch ||
      last.worktree !== r.worktree ||
      last.startedAt !== r.createdAt ||
      last.pinned !== r.pinned ||
      last.archived !== r.archived ||
      last.unpushed !== (v.unpushed ?? 0) ||
      last.uncommitted !== (v.uncommitted ?? 0) ||
      last.ignored !== (v.ignored ?? 0)
    ) {
      return 'other';
    }
  } else {
    const w = v.window;
    // The project is the cwd's last part or the window name: unchanged when both are.
    if (
      !last.external ||
      last.worktree !== (w?.cwd ?? '') ||
      last.task !== (w?.name ?? '') ||
      last.startedAt !== v.firstSeen
    ) {
      return 'other';
    }
  }
  if (!sameViewQuestion(last.question, v)) return 'other';
  const now = v.now && v.status === 'running' ? v.now : undefined;
  return last.now === now ? 'none' : 'now';
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
