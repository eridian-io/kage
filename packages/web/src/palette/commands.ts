/**
 * What the command palette offers (Task 8), built from the board's signals each time it opens.
 * Every action runs through the same functions as its button or key, so act()'s busy, live and
 * 401 rules hold, and Delete… only opens the confirmation.
 */
import { groupOf, type Session } from '@kage/shared';
import { archive, canAct, pin, resume, stop } from '../api.ts';
import type { NotifyApi } from '../notify.ts';
import {
  archivedCount,
  archiveOpen,
  canStop,
  confirmingDelete,
  focusList,
  mainView,
  newTaskOpen,
  openTerminal,
  releaseDigits,
  select,
  selected,
  sorted,
  stopPending,
} from '../store.ts';

export type CommandGroup = 'sessions' | 'this session' | 'general';
export interface Command {
  id: string;
  group: CommandGroup;
  title: string;
  /** The board key that does the same, shown as a hint. */
  key?: string;
  session?: Session;
  run: () => void;
  /** Shown, but Enter and a click do nothing. */
  disabled?: boolean;
  /** A quiet line on the right, in place of a key hint. */
  note?: string;
  /** The command puts focus where it belongs itself; otherwise the palette returns it on close. */
  moves?: boolean;
}

/** What the query is matched against: a session's `project / task branch`, else the title. */
export const textOf = (c: Command): string =>
  c.session ? `${c.title} ${c.session.branch}` : c.title;

function jump(s: Session): void {
  // Focus leaves the palette for the page, so the list's focus rule (R77) takes the new row.
  (document.activeElement as HTMLElement | null)?.blur?.();
  select(s.id);
  focusList.value++;
}

function sessionCommands(s: Session): Command[] {
  const own = !s.external;
  const done = groupOf(s) === 'done';
  const ended = s.status === 'ended';
  const off = !canAct(s.id);
  const out: Command[] = [];
  const add = (c: Omit<Command, 'group' | 'session'>) =>
    out.push({ ...c, group: 'this session', session: s });
  // As the preview: no files, no View diff (R99).
  if (mainView.value !== 'diff' && s.filesTotal > 0) {
    add({
      id: 'diff',
      title: 'View diff',
      moves: true,
      run: () => {
        mainView.value = 'diff';
      },
    });
  }
  if (!ended) {
    add({
      id: 'term',
      title: 'Open the terminal',
      key: 'T',
      moves: true,
      run: () => openTerminal(s),
    });
  }
  if (own) {
    add({
      id: 'pin',
      title: s.pinned ? 'Unpin' : 'Pin',
      key: 'S',
      disabled: off,
      run: () => void pin(s),
    });
  }
  if (own && done) {
    add({
      id: 'archive',
      title: 'Archive',
      key: 'E',
      disabled: off,
      run: () => void archive(s, true),
    });
  }
  if (own && ended) {
    add({ id: 'resume', title: 'Resume', key: 'U', disabled: off, run: () => void resume(s) });
  }
  if (canStop(s)) {
    add({
      id: 'stop',
      title: 'Stop',
      key: 'X',
      disabled: off || stopPending(s),
      run: () => void stop(s),
    });
  }
  if (own && done) {
    add({
      id: 'del',
      title: 'Delete…',
      disabled: off,
      // As the Delete… button: the confirmation, never the delete itself.
      run: () => {
        mainView.value = 'output';
        confirmingDelete.value = true;
      },
    });
  }
  return out;
}

/** `notify` is notify.ts's notifyApi (passed in, so this chunk doesn't import notify.ts). */
export function commands(notify: NotifyApi): Command[] {
  const out: Command[] = sorted.value.map((s) => ({
    id: `s:${s.id}`,
    group: 'sessions',
    title: `${s.project} / ${s.task}`,
    session: s,
    moves: true,
    run: () => jump(s),
  }));
  const s = selected.value;
  if (s) out.push(...sessionCommands(s));
  out.push({
    id: 'new',
    group: 'general',
    title: 'New task',
    key: 'N',
    moves: true,
    run: () => {
      releaseDigits();
      // An open form keeps what was typed; its field takes focus again.
      if (newTaskOpen.value) document.querySelector<HTMLElement>('.k-nt-task')?.focus();
      else newTaskOpen.value = true;
    },
  });
  if (archivedCount.value > 0) {
    out.push({
      id: 'archived',
      group: 'general',
      title: 'Show archived',
      run: () => {
        archiveOpen.value = true;
      },
    });
  }
  const n = notify.state.value;
  if (n === 'default') {
    out.push({
      id: 'notify',
      group: 'general',
      title: 'Turn on browser notifications',
      // What a notification shows (Task 7's N2): said before the browser asks.
      note: 'shows project and task',
      // Run inside the key or click, so the browser sees a user action.
      run: () => void notify.enable(),
    });
  } else if (n === 'insecure') {
    out.push({
      id: 'notify',
      group: 'general',
      title: 'Browser notifications need HTTPS; use ntfy instead',
      disabled: true,
      run: () => {},
    });
  }
  return out;
}
