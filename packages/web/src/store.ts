import {
  type DisplayLine,
  groupOf,
  type ServerEvent,
  type Session,
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
/** False until the first snapshot: until then the board knows nothing, not "no sessions". */
export const hadSnapshot: Signal<boolean> = signal(false);
export const confirmingDelete: Signal<boolean> = signal(false);
/** The deleted session's name (`project · task`) while the toast shows, else null. */
export const toast: Signal<string | null> = signal(null);
/** True while the New task form replaces the button at the top of the left column. */
export const newTaskOpen: Signal<boolean> = signal(false);
/**
 * After a start: select this id as soon as a session.updated (or snapshot) brings it.
 * keepSelection must not drop it first; the user's own selection meanwhile cancels it.
 */
export const selectWhenSeen: Signal<string | null> = signal(null);
/** The reply field under the selected session's question is open. */
export const replyOpen: Signal<boolean> = signal(false);
/** Session ids with an answer, reply or stop in flight; their controls are disabled. */
export const busy: Signal<ReadonlySet<string>> = signal(new Set());
/** The last action's failure, shown above that session's footer; cleared on select and the next action. */
export const actionError: Signal<{ id: string; text: string } | null> = signal(null);
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
// The login screen replaces the board; a form left open behind it would reappear after sign-in.
effect(() => {
  if (authRequired.value) newTaskOpen.value = false;
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

/** Deletes this page asked for, by id, with the name the toast will show. */
const deleting = new Map<string, string>();
/** DELETE requests in flight, by id, so a second attempt can't erase the first one's entry. */
const inFlight = new Map<string, number>();
/** The ids with a DELETE request in flight; Delete is disabled for them. */
export const pendingDeletes: Signal<ReadonlySet<string>> = signal(new Set());

export const nameOf = (s: Session) => `${s.project} · ${s.task}`;

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
    confirmingDelete.value = false;
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
    confirmingDelete.value = false;
  }
  // The confirmation belongs to a done session; it ends when the session leaves that group.
  const s = selected.value;
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
 * they brought: the incoming session takes the held session's ports, files and filesTotal.
 */
function keepLive(incoming: Session): Session {
  const held = sessions.value.find((s) => s.id === incoming.id);
  return held
    ? { ...incoming, ports: held.ports, files: held.files, filesTotal: held.filesTotal }
    : incoming;
}

export function applyEvent(e: ServerEvent): void {
  batch(() => {
    if (e.type === 'snapshot') {
      host.value = e.host;
      // A new stream (a reconnect) starts without lines: the view brings them again.
      const fresh = streamId.value !== e.streamId;
      streamId.value = e.streamId;
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
      // A removal missed while disconnected is never announced, so its toast entry goes.
      for (const id of [...deleting.keys()]) {
        if (!e.sessions.some((s) => s.id === id)) deleting.delete(id);
      }
    } else if (e.type === 'session.updated') {
      const list = sessions.value;
      const i = list.findIndex((s) => s.id === e.session.id);
      const incoming = keepLive(e.session);
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
      if (sessions.value.some((s) => s.id === e.id)) {
        sessions.value = sessions.value.map((s) =>
          s.id === e.id ? { ...s, files: e.files, filesTotal: e.filesTotal } : s,
        );
      }
    } else if (e.type === 'archive') {
      archivedCount.value = e.count;
    } else if (e.type === 'session.removed') {
      sessions.value = sessions.value.filter((s) => s.id !== e.id);
      lineCount.delete(e.id);
      if (linesById.value.has(e.id)) {
        const m = new Map(linesById.value);
        m.delete(e.id);
        linesById.value = m;
      }
      const name = deleting.get(e.id);
      if (name !== undefined) {
        deleting.delete(e.id);
        toast.value = name;
      }
    }
    const waiting = selectWhenSeen.value;
    if (waiting !== null && sorted.value.some((s) => s.id === waiting)) select(waiting);
    keepSelection();
  });
}

export function selectNext(delta: 1 | -1): void {
  const list = sorted.value;
  if (list.length === 0) return;
  const i = list.findIndex((s) => s.id === selectedId.value);
  const next = i < 0 ? 0 : Math.min(list.length - 1, Math.max(0, i + delta));
  select(list[next]?.id ?? null);
}

function setInFlight(id: string, n: number): void {
  if (n > 0) inFlight.set(id, n);
  else inFlight.delete(id);
  pendingDeletes.value = new Set(inFlight.keys());
}

/** A DELETE request starts: its removal will show the toast, and Delete is disabled meanwhile. */
export function beginDelete(s: Session): void {
  deleting.set(s.id, nameOf(s));
  setInFlight(s.id, (inFlight.get(s.id) ?? 0) + 1);
}

/** A DELETE request ended. A failure forgets the toast only when no other request is in flight. */
export function endDelete(id: string, ok: boolean): void {
  const left = (inFlight.get(id) ?? 1) - 1;
  setInFlight(id, left);
  if (!ok && left === 0) deleting.delete(id);
}
