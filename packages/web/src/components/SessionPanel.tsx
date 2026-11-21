import { formatAge, groupOf, type Session, shortWorktree } from '@kage/shared';
import type { ComponentChildren } from 'preact';
import { apiDelete } from '../api.ts';
import { confirmingDelete, markDeleting, now, unmarkDeleting } from '../store.ts';
import { INERT } from './inert.ts';
import { Output } from './Output.tsx';
import { Toast } from './Toast.tsx';

/** The target's status classes: wait, run, done (ended shows as done). */
const CHIP = { 'needs you': 'wait', running: 'run', done: 'done' } as const;

const ICON = {
  term: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="m7 10 3 2-3 2M12 15h5" />
    </svg>
  ),
  stop: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  ),
  arch: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="4" width="18" height="5" rx="1" />
      <path d="M5 9v10h14V9M10 13h4" />
    </svg>
  ),
  del: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6" />
    </svg>
  ),
};

interface ActProps {
  label: string;
  hotkey?: string;
  cls?: string;
  icon?: ComponentChildren;
  onClick?: () => void;
}

/** A footer action. Without onClick it is shown but inert in this phase. */
function Act({ label, hotkey, cls, icon, onClick }: ActProps) {
  return (
    <button
      type="button"
      class={cls ? `k-act ${cls}` : 'k-act'}
      {...(onClick ? { onClick } : INERT)}
    >
      {icon}
      {label}
      {hotkey && <kbd>{hotkey}</kbd>}
    </button>
  );
}

function ago(ms: number): string {
  const age = formatAge(ms);
  return age === 'now' ? 'just now' : `${age} ago`;
}

function unpushedWarning(n: number): string {
  return n === 1
    ? '1 commit isn’t pushed and will be lost.'
    : `${n} commits aren’t pushed and will be lost.`;
}

async function deleteSession(s: Session): Promise<void> {
  markDeleting(s);
  confirmingDelete.value = false;
  try {
    const res = await apiDelete(`/api/sessions/${encodeURIComponent(s.id)}`);
    if (!res.ok) unmarkDeleting(s.id);
  } catch {
    unmarkDeleting(s.id);
  }
}

function Confirm({ s }: { s: Session }) {
  return (
    <div class="k-confirm">
      <div>
        <b>Delete this session?</b>
        {' This removes the tmux window, the worktree '}
        <code>{s.worktree}</code>
        {' and the branch '}
        <code>{s.branch}</code>.
        {s.unpushed > 0 ? (
          <>
            {' '}
            <span class="warn">{unpushedWarning(s.unpushed)}</span>
          </>
        ) : (
          ' Everything on the branch is pushed, so nothing is lost.'
        )}
      </div>
      <div class="row">
        <button type="button" class="k-act danger-solid" onClick={() => deleteSession(s)}>
          Delete session
        </button>
        <button
          type="button"
          class="k-act"
          onClick={() => {
            confirmingDelete.value = false;
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

export function SessionPanel({ session: s }: { session: Session }) {
  const group = groupOf(s);
  const done = group === 'done';
  const confirming = done && confirmingDelete.value;
  const worktree = shortWorktree(s.worktree);
  return (
    <main class="k-main">
      <div class="k-head">
        <div>
          <h3>
            <span class="k-proj">{s.project} /</span>
            <span class="k-task" title={s.task}>
              {s.task}
            </span>
            <span class={`k-chip ${CHIP[group]}`}>{group}</span>
          </h3>
        </div>
      </div>
      <div class="k-meta">
        <span class="k-clip" title={s.branch}>
          branch <b>{s.branch}</b>
        </span>
        <span class="k-clip" title={s.worktree}>
          worktree <b>{worktree}</b>
        </span>
        {done ? (
          <span>
            finished <b>{ago(now.value - s.statusSince)}</b>
          </span>
        ) : (
          <span>
            started <b>{ago(now.value - s.startedAt)}</b>
          </span>
        )}
      </div>
      <Toast />
      <Output session={s} />
      {s.question && (
        <div class="k-ask">
          <div class="k-q">
            <small>Waiting for you</small>
            {s.question.text}
          </div>
          <div class="k-opts">
            {s.question.options.map((o, i) => (
              <button type="button" key={`${i}`} {...INERT}>
                <kbd>{i + 1}</kbd>
                {o}
              </button>
            ))}
            <span class="k-or">or press R to reply</span>
          </div>
        </div>
      )}
      {done && !confirming && (
        <div class="k-follow" {...INERT}>
          Follow up in this session…<kbd>R</kbd>
        </div>
      )}
      {confirming && <Confirm s={s} />}
      <div class="k-foot">
        <div class="l">
          <Act label="Terminal" hotkey="T" icon={ICON.term} />
        </div>
        <div class="r">
          {done ? (
            <>
              <Act label="Archive" hotkey="E" icon={ICON.arch} />
              <Act
                label="Delete…"
                cls="stop"
                icon={ICON.del}
                onClick={() => {
                  confirmingDelete.value = true;
                }}
              />
            </>
          ) : (
            <Act label="Stop" hotkey="X" cls="stop" icon={ICON.stop} />
          )}
        </div>
      </div>
    </main>
  );
}
