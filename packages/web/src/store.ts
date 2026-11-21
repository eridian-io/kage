import { type ServerEvent, type Session, sortSessions } from '@kage/shared';
import { batch, computed, type ReadonlySignal, type Signal, signal } from '@preact/signals';

export const host: Signal<string> = signal('');
export const sessions: Signal<Session[]> = signal([]);
export const selectedId: Signal<string | null> = signal(null);
export const connection: Signal<'connecting' | 'live' | 'reconnecting'> = signal('connecting');
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

export const nameOf = (s: Session) => `${s.project} · ${s.task}`;

/** Selects a session; a new selection drops the confirmation and the toast, as in the target. */
export function select(id: string | null): void {
  batch(() => {
    if (id !== selectedId.value) toast.value = null;
    selectedId.value = id;
    confirmingDelete.value = false;
  });
}

function keepSelection(): void {
  if (!sorted.value.some((s) => s.id === selectedId.value)) {
    selectedId.value = sorted.value[0]?.id ?? null;
    confirmingDelete.value = false;
  }
}

export function applyEvent(e: ServerEvent): void {
  batch(() => {
    if (e.type === 'snapshot') {
      host.value = e.host;
      sessions.value = e.sessions;
    } else if (e.type === 'session.updated') {
      const list = sessions.value;
      const i = list.findIndex((s) => s.id === e.session.id);
      sessions.value = i < 0 ? [...list, e.session] : list.map((s, j) => (j === i ? e.session : s));
    } else {
      sessions.value = sessions.value.filter((s) => s.id !== e.id);
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

/** Remembers that this page deleted the session, so its removal shows the toast. */
export function markDeleting(s: Session): void {
  deleting.set(s.id, nameOf(s));
}

export function unmarkDeleting(id: string): void {
  deleting.delete(id);
}
