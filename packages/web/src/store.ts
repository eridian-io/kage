import {
  type DisplayLine,
  groupOf,
  type ServerEvent,
  type Session,
  sortSessions,
} from '@kage/shared';
import { batch, computed, type ReadonlySignal, type Signal, signal } from '@preact/signals';

export const host: Signal<string> = signal('');
export const sessions: Signal<Session[]> = signal([]);
/** The transcript of each session viewed so far, newest 500 lines. */
export const linesById: Signal<Map<string, DisplayLine[]>> = signal(new Map());
/** This stream's id, from the snapshot; null before the first one. */
export const streamId: Signal<string | null> = signal(null);
export const projectsRoot: Signal<string> = signal('');
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

/**
 * Selects a session. Every selection, even of the selected row, drops the confirmation and the
 * toast, as in the target.
 */
export function select(id: string | null): void {
  batch(() => {
    toast.value = null;
    selectedId.value = id;
    confirmingDelete.value = false;
  });
}

function keepSelection(): void {
  if (!sorted.value.some((s) => s.id === selectedId.value)) {
    selectedId.value = sorted.value[0]?.id ?? null;
    confirmingDelete.value = false;
  }
  // The confirmation belongs to a done session; it ends when the session leaves that group.
  const s = selected.value;
  if (s === null || groupOf(s) !== 'done') confirmingDelete.value = false;
}

export function applyEvent(e: ServerEvent): void {
  batch(() => {
    if (e.type === 'snapshot') {
      host.value = e.host;
      // A new stream (a reconnect) starts without lines: the view brings them again.
      const fresh = streamId.value !== e.streamId;
      streamId.value = e.streamId;
      projectsRoot.value = e.projectsRoot;
      hadSnapshot.value = true;
      sessions.value = e.sessions;
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
      sessions.value = i < 0 ? [...list, e.session] : list.map((s, j) => (j === i ? e.session : s));
    } else if (e.type === 'session.lines') {
      const prev = e.reset ? [] : (linesById.value.get(e.id) ?? []);
      const next = [...prev, ...e.lines].slice(-MAX_LINES);
      lineCount.set(e.id, (lineCount.get(e.id) ?? 0) + e.lines.length);
      linesById.value = new Map(linesById.value).set(e.id, next);
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
