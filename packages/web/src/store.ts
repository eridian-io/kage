import {
  type DisplayLine,
  groupOf,
  type ServerEvent,
  type Session,
  type SessionStatus,
  sortSessions,
} from '@kage/shared';
import { batch, computed, effect, type ReadonlySignal, type Signal, signal } from '@preact/signals';

export const host: Signal<string> = signal('');
export const sessions: Signal<Session[]> = signal([]);
/** The transcript of each session viewed so far, newest 500 lines. */
export const linesById: Signal<Map<string, DisplayLine[]>> = signal(new Map());
/** This stream's id, from the snapshot; null before the first one. */
export const streamId: Signal<string | null> = signal(null);
export const projectsRoot: Signal<string> = signal('');
/** How many sessions are archived. */
export const archivedCount: Signal<number> = signal(0);
/** The archived list at the bottom of the left column is open; it closes when the count is 0. */
export const archiveOpen: Signal<boolean> = signal(false);
export const MAX_LINES = 500;
/**
 * How many lines each session has received, ever. The key of line i of n held is
 * `count - n + i`, so a line keeps its key while newer ones are appended and older ones dropped.
 * Updated in the same batch as linesById; a reset continues the count, so its lines get new keys.
 */
const lineCount = new Map<string, number>();
export const lineKeyBase = (id: string, held: number): number => (lineCount.get(id) ?? 0) - held;
export const selectedId: Signal<string | null> = signal(null);
export const connection: Signal<'connecting' | 'live' | 'reconnecting'> = signal('connecting');
/** True when the server answered 401: the board shows the login screen (spec §5.10, F18). */
export const authRequired: Signal<boolean> = signal(false);
/** A token is set (the snapshot's `auth`): the palette offers Sign out. */
export const tokenSet: Signal<boolean> = signal(false);
/** This is the demo (the snapshot's `demo`): the top bar shows a quiet badge (usability U6). */
export const demo: Signal<boolean> = signal(false);
/** False until the first snapshot: until then the board knows nothing, not "no sessions". */
export const hadSnapshot: Signal<boolean> = signal(false);
export const confirmingDelete: Signal<boolean> = signal(false);
/**
 * Bumped whenever this tab's view changes (a selection, even of the selected row, an automatic
 * pick, or a new stream): the server then recounts the viewed session's branch.
 */
export const viewGen: Signal<number> = signal(0);
/** The session whose branch counts arrived during view `gen` (see countsKnown). */
const countsSeen: Signal<{ id: string; gen: number } | null> = signal(null);
/**
 * The selected session's branch counts are known: since the last view, its files arrived (the
 * server sends the counts just before them) or a count changed (a recount published them). Until
 * then the delete confirmation can't say what would be lost.
 */
export const countsKnown: ReadonlySignal<boolean> = computed(
  () =>
    countsSeen.value !== null &&
    countsSeen.value.gen === viewGen.value &&
    countsSeen.value.id === selectedId.value,
);
const markCounts = (id: string) => {
  if (id === selectedId.value) countsSeen.value = { id, gen: viewGen.value };
};
/**
 * What the middle column shows for the selected session: its output, the branch's diff (Task 10)
 * or the terminal (Task 13). Every selection, explicit or automatic, returns it to 'output'.
 */
export const mainView: Signal<'output' | 'diff' | 'terminal'> = signal('output');
/** The terminal's last close reason or load error, shown in the error line; cleared on select and open. */
export const termNote: Signal<string | null> = signal(null);
/**
 * Bumped when a removal this page asked for (archive, delete) arrives: the list then focuses the
 * newly selected row, since the button that had focus went away with the session (R77).
 */
export const focusList: Signal<number> = signal(0);
export type RemovalKind = 'deleted' | 'archived';
/**
 * What the toast shows, else null: a removed session's kind and name (`project · task`), or a one-line
 * note (the palette's chunk didn't load).
 */
export const toast: Signal<
  { kind: RemovalKind; name: string } | { kind: 'note'; text: string } | null
> = signal(null);
/** True while the New task form replaces the button at the top of the left column. */
export const newTaskOpen: Signal<boolean> = signal(false);
/**
 * After a start: select this id as soon as a session.updated (or snapshot) brings it.
 * keepSelection must not drop it first; the user's own selection meanwhile cancels it.
 */
export const selectWhenSeen: Signal<string | null> = signal(null);
/** The command palette (⌘K / Ctrl+K) is open; its code loads on the first open (R95). */
export const paletteOpen: Signal<boolean> = signal(false);
/** The reply field under the selected session's question is open. */
export const replyOpen: Signal<boolean> = signal(false);
/** Session ids with an answer, reply or stop in flight; their controls are disabled. */
export const busy: Signal<ReadonlySet<string>> = signal(new Set());
/** The last action's failure, shown above that session's footer; cleared on select and the next action. */
export const actionError: Signal<{ id: string; text: string; note?: boolean } | null> =
  signal(null);
/**
 * The question last answered or replied to from this page, by session and content. Its buttons
 * stay disabled while that same question shows, so a second click can't send another digit to an
 * answered prompt; a snapshot that re-creates it doesn't re-enable them. After ANSWER_HOLD_MS
 * they work again, in case the prompt really is still waiting.
 */
export const answered: Signal<{ id: string; q: string } | null> = signal(null);
export const ANSWER_HOLD_MS = 5000;
/** A Stop the server accepted, with the status it was sent at: Stop stays off until that changes. */
export const stopSent: Signal<{ id: string; status: string } | null> = signal(null);
/** The session a first X armed for Stop (R26): a second X within 2 s stops it. */
export const stopArmed: Signal<string | null> = signal(null);
// The login screen replaces the board; a form or palette left open behind it would reappear after
// sign-in.
effect(() => {
  if (authRequired.value) {
    newTaskOpen.value = false;
    paletteOpen.value = false;
  }
});
/** Epoch ms, ticked once a minute by the board so ages re-render. */
export const now: Signal<number> = signal(Date.now());

/** The listed sessions: archived ones are left out, the rest in board order. */
export const sorted: ReadonlySignal<Session[]> = computed(() =>
  sortSessions(sessions.value.filter((s) => !s.archived)),
);
export const selected: ReadonlySignal<Session | null> = computed(
  () => sorted.value.find((s) => s.id === selectedId.value) ?? null,
);

/**
 * Removals (archive or delete) this page asked for, by id (F12): the kind and name its toast will
 * show when the session.removed arrives, and whether the server accepted the request. A removal
 * nobody here asked for (auto-archive, another tab) shows no toast.
 */
const removing = new Map<string, { kind: RemovalKind; name: string; accepted: boolean }>();

export const nameOf = (s: Pick<Session, 'project' | 'task'>) => `${s.project} · ${s.task}`;

/** Stop is offered for Kage's own sessions that are running or waiting (spec §6.1, F2). */
export const canStop = (s: Session): boolean =>
  !s.external && (s.status === 'running' || s.status === 'needs-you');

const questionKey = (s: Session) =>
  s.question ? JSON.stringify([s.question.text, s.question.options]) : '';
/** The session's question is the one answered from here, still showing. */
export const isAnswered = (s: Session): boolean =>
  answered.value?.id === s.id && answered.value.q === questionKey(s);
export function markAnswered(s: Session): void {
  const mark = { id: s.id, q: questionKey(s) };
  answered.value = mark;
  setTimeout(() => {
    if (answered.value === mark) answered.value = null;
  }, ANSWER_HOLD_MS);
}
/** A Stop for this session was accepted and its status hasn't changed since. */
export const stopPending = (s: Session): boolean =>
  stopSent.value?.id === s.id && stopSent.value.status === s.status;

/**
 * When the selected session goes away, keepSelection picks another; a digit meant for the old
 * question must not answer the new one. Digits wait until the user selects (J/K, a click, N), or
 * for AUTO_PICK_MS. Epoch ms of the automatic pick, else 0.
 */
let autoPickedAt = 0;
export const AUTO_PICK_MS = 1000;
/**
 * R51: the same hold for a question that changes under the user's eyes. When the selected
 * session's question text or options change, a digit or click meant for the old one must not
 * answer the new one: the buttons are disabled and digits do nothing for QUESTION_HOLD_MS.
 */
export const QUESTION_HOLD_MS = 800;
export const questionHeld: Signal<boolean> = signal(false);
let questionTimer: ReturnType<typeof setTimeout> | undefined;
function holdQuestion(): void {
  clearTimeout(questionTimer);
  questionHeld.value = true;
  questionTimer = setTimeout(() => {
    questionHeld.value = false;
  }, QUESTION_HOLD_MS);
}
export const digitsHeld = (): boolean =>
  questionHeld.value || Date.now() - autoPickedAt < AUTO_PICK_MS;
export function releaseDigits(): void {
  autoPickedAt = 0;
  clearTimeout(questionTimer);
  questionHeld.value = false;
  seenQuestion = null;
}
/**
 * The selected session and its question, as last seen by keepSelection; null after an explicit
 * selection, which is not a change under the user's eyes.
 */
let seenQuestion: { id: string; key: string } | null = null;

/**
 * Selects a session. Every selection, even of the selected row, drops the confirmation and the
 * toast, as in the target.
 */
export function select(id: string | null): void {
  batch(() => {
    toast.value = null;
    selectedId.value = id;
    viewGen.value++;
    confirmingDelete.value = false;
    mainView.value = 'output';
    termNote.value = null;
    selectWhenSeen.value = null;
    replyOpen.value = false;
    actionError.value = null;
    stopArmed.value = null;
    answered.value = null;
  });
  releaseDigits();
}

/**
 * A start answered 201 with this id. `adopt` usually emits its session.updated before the 201
 * (F5), so the session is often in the store already: select it at once, else when it arrives.
 */
export function selectStarted(id: string): void {
  if (sorted.value.some((s) => s.id === id)) select(id);
  else selectWhenSeen.value = id;
}

function keepSelection(): void {
  if (!sorted.value.some((s) => s.id === selectedId.value)) {
    // Replacing a selected session is automatic; the first selection on load is not a switch.
    if (selectedId.value !== null) autoPickedAt = Date.now();
    selectedId.value = sorted.value[0]?.id ?? null;
    viewGen.value++;
    confirmingDelete.value = false;
    mainView.value = 'output';
    // A note about the session that went away doesn't belong to the one picked instead.
    termNote.value = null;
  }
  // The confirmation belongs to a done session; it ends when the session leaves that group.
  const s = selected.value;
  // An ended session has no window: its terminal view goes (keeping any note), or the board's
  // keys would stay with a terminal that isn't there.
  if (mainView.value === 'terminal' && (s === null || s.status === 'ended')) {
    mainView.value = 'output';
  }
  if (s === null || groupOf(s) !== 'done') confirmingDelete.value = false;
  // The reply field belongs to a question that takes typed replies; it closes when that ends.
  if (!s?.question || s.question.startup) replyOpen.value = false;
  if (s === null || !canStop(s)) stopArmed.value = null;
  // R51: the same selected session now asks something else (a new selection is not a change).
  const key = s ? questionKey(s) : '';
  if (s && seenQuestion?.id === s.id && seenQuestion.key !== key && key !== '') holdQuestion();
  seenQuestion = s ? { id: s.id, key } : null;
}

/**
 * Ports and files have their own events, so a session.updated or snapshot must not wipe what
 * they brought: the incoming session takes the held session's ports, files, filesTotal and
 * filesNote.
 */
function keepLive(incoming: Session): Session {
  const held = sessions.value.find((s) => s.id === incoming.id);
  if (!held) return incoming;
  const { ports, files, filesTotal, filesNote } = held;
  return { ...incoming, ports, files, filesTotal, filesNote };
}

/**
 * Told of each event once the store has applied it (link.ts, and notify.ts once its chunk is in;
 * W1), with the status a session.updated replaced (undefined for a session new to the store).
 * Returns the listener's remover.
 */
type AppliedHook = (e: ServerEvent, was: SessionStatus | undefined) => void;
const appliedHooks = new Set<AppliedHook>();
export function onApplied(fn: AppliedHook): () => void {
  appliedHooks.add(fn);
  return () => {
    appliedHooks.delete(fn);
  };
}

export function applyEvent(e: ServerEvent): void {
  // The heartbeat only tells sse.ts's watchdog that the stream is alive.
  if (e.type === 'hb') return;
  let was: SessionStatus | undefined;
  batch(() => {
    if (e.type === 'snapshot') {
      host.value = e.host;
      tokenSet.value = e.auth;
      demo.value = e.demo;
      // A new stream (a reconnect) starts without lines: the view brings them again.
      const fresh = streamId.value !== e.streamId;
      streamId.value = e.streamId;
      // A new stream posts the view again.
      if (fresh) viewGen.value++;
      projectsRoot.value = e.projectsRoot;
      archivedCount.value = e.archived;
      hadSnapshot.value = true;
      sessions.value = e.sessions.map(keepLive);
      linesById.value = fresh
        ? new Map()
        : new Map([...linesById.value].filter(([id]) => e.sessions.some((s) => s.id === id)));
      // Counts of sessions that are gone go too; the others continue, so keys stay unique.
      for (const id of [...lineCount.keys()]) {
        if (!e.sessions.some((s) => s.id === id)) lineCount.delete(id);
      }
      if (e.archived === 0) archiveOpen.value = false;
      // A removal missed while disconnected is never announced, so its toast entry goes; so does
      // an accepted one whose session is still here (the snapshot is newer than the request).
      for (const [id, r] of [...removing]) {
        if (r.accepted || !e.sessions.some((s) => s.id === id)) removing.delete(id);
      }
    } else if (e.type === 'session.updated') {
      const list = sessions.value;
      const i = list.findIndex((s) => s.id === e.session.id);
      const incoming = keepLive(e.session);
      const held = i < 0 ? undefined : list[i];
      was = held?.status;
      if (
        held &&
        (held.unpushed !== incoming.unpushed ||
          held.uncommitted !== incoming.uncommitted ||
          held.ignored !== incoming.ignored)
      ) {
        markCounts(incoming.id);
      }
      sessions.value = i < 0 ? [...list, incoming] : list.map((s, j) => (j === i ? incoming : s));
    } else if (e.type === 'session.lines') {
      const prev = e.reset ? [] : (linesById.value.get(e.id) ?? []);
      const next = [...prev, ...e.lines].slice(-MAX_LINES);
      lineCount.set(e.id, (lineCount.get(e.id) ?? 0) + e.lines.length);
      linesById.value = new Map(linesById.value).set(e.id, next);
    } else if (e.type === 'session.ports') {
      if (sessions.value.some((s) => s.id === e.id)) {
        sessions.value = sessions.value.map((s) => (s.id === e.id ? { ...s, ports: e.ports } : s));
      }
    } else if (e.type === 'session.files') {
      markCounts(e.id);
      if (sessions.value.some((s) => s.id === e.id)) {
        sessions.value = sessions.value.map((s) =>
          // A value without a note clears the last one.
          s.id === e.id ? { ...s, files: e.files, filesTotal: e.filesTotal, filesNote: e.note } : s,
        );
      }
    } else if (e.type === 'archive') {
      archivedCount.value = e.count;
      if (e.count === 0) archiveOpen.value = false;
    } else if (e.type === 'session.removed') {
      sessions.value = sessions.value.filter((s) => s.id !== e.id);
      lineCount.delete(e.id);
      if (linesById.value.has(e.id)) {
        const m = new Map(linesById.value);
        m.delete(e.id);
        linesById.value = m;
      }
      const asked = removing.get(e.id);
      if (asked !== undefined) {
        removing.delete(e.id);
        toast.value = { kind: asked.kind, name: asked.name };
        focusList.value++;
      }
    }
    const waiting = selectWhenSeen.value;
    if (waiting !== null && sorted.value.some((s) => s.id === waiting)) select(waiting);
    keepSelection();
  });
  for (const fn of appliedHooks) fn(e, was);
}

export function selectNext(delta: 1 | -1): void {
  const list = sorted.value;
  if (list.length === 0) return;
  const i = list.findIndex((s) => s.id === selectedId.value);
  const next = i < 0 ? 0 : Math.min(list.length - 1, Math.max(0, i + delta));
  // At an end of the list nothing moves: no view post, and an open confirmation stays. The
  // key still shows the user saw the selection, so held digits answer it from now on.
  if (next === i) {
    releaseDigits();
    return;
  }
  select(list[next]?.id ?? null);
}

/** An archive or delete request starts: its removal will show the toast of that kind. */
export function beginRemoval(s: Pick<Session, 'id' | 'project' | 'task'>, kind: RemovalKind): void {
  // A request the server already accepted keeps its entry: that removal is on its way.
  if (removing.get(s.id)?.accepted) return;
  removing.set(s.id, { kind, name: nameOf(s), accepted: false });
}

/** The request ended. A failure forgets the toast, unless an earlier request was accepted. */
export function endRemoval(id: string, ok: boolean): void {
  const entry = removing.get(id);
  if (!entry || entry.accepted) return;
  if (ok) entry.accepted = true;
  else removing.delete(id);
}

/**
 * Esc or Back to session: the output comes back, and focus returns to "View diff →", which opened
 * it, or to the selected row when there is none (no files, an external window: the palette opened
 * it), so focus never falls to the page.
 */
export function closeDiff(): void {
  mainView.value = 'output';
  (
    document.querySelector<HTMLElement>('.k-diff') ??
    // The session list's row only: a palette row (k-it on) never matches.
    document.querySelector<HTMLElement>('.k-side [data-id].k-it.on')
  )?.focus();
}

/** T or Terminal: the terminal replaces the output, for a session that still has a window. */
export function openTerminal(s: Session): void {
  if (s.status === 'ended') return;
  batch(() => {
    termNote.value = null;
    confirmingDelete.value = false;
    replyOpen.value = false;
    mainView.value = 'terminal';
  });
}

/**
 * Back, Shift+Esc, Ctrl+Shift+X or the terminal's end: the output comes back (unmounting the
 * terminal disposes it), and focus returns to Terminal, so it never falls to the page.
 */
export function closeTerminal(): void {
  if (mainView.value !== 'terminal') return;
  mainView.value = 'output';
  // After the re-render that brings Terminal back in place of Back to session.
  // Only when focus fell to the page (it was inside xterm); a focused Back is the same button.
  setTimeout(() => {
    const a = document.activeElement;
    if (a === null || a === document.body) {
      document.querySelector<HTMLElement>('[data-act="term"]')?.focus();
    }
  });
}
