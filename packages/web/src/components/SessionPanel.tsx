import { formatAge, groupOf, type Session, shortWorktree } from '@kage/shared';
import type { ComponentChildren } from 'preact';
import { archive, canAct, remove, resume, stop } from '../api.ts';
import {
  actionError,
  confirmingDelete,
  now,
  projectsRoot,
  stopArmed,
  stopPending,
} from '../store.ts';
import { Ask } from './Ask.tsx';
import { FollowUp } from './FollowUp.tsx';
import { INERT } from './inert.ts';
import { Output } from './Output.tsx';
import { Toast } from './Toast.tsx';

/** The target's status classes: wait, run, done; ended is grey like done. */
const CHIP = { 'needs you': 'wait', running: 'run', done: 'done', ended: 'ended' } as const;

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
  resume: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 12a8 8 0 1 0 2.3-5.6M4 4v4h4" />
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
  disabled?: boolean;
}

/** A footer action. Without onClick it is shown but inert in this phase. */
function Act({ label, hotkey, cls, icon, onClick, disabled }: ActProps) {
  return (
    <button
      type="button"
      class={cls ? `k-act ${cls}` : 'k-act'}
      disabled={disabled}
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

/** What the delete would lose, one sentence per count above 0 (R75: ignored files too). */
function lossWarning(s: Session): string {
  const parts: string[] = [];
  if (s.unpushed > 0) {
    parts.push(
      s.unpushed === 1
        ? '1 commit isn’t pushed and will be lost.'
        : `${s.unpushed} commits aren’t pushed and will be lost.`,
    );
  }
  if (s.uncommitted > 0) {
    parts.push(
      s.uncommitted === 1
        ? '1 file has uncommitted changes and will be lost.'
        : `${s.uncommitted} files have uncommitted changes and will be lost.`,
    );
  }
  if (s.ignored > 0) {
    parts.push(
      s.ignored === 1
        ? '1 ignored file (like .env) will be deleted too.'
        : `${s.ignored} ignored files (like .env) will be deleted too.`,
    );
  }
  return parts.join(' ');
}

function Confirm({ s }: { s: Session }) {
  const loss = lossWarning(s);
  return (
    <div class="k-confirm">
      <div>
        <b>Delete this session?</b>
        {' This removes the tmux window, the worktree '}
        <code>{s.worktree}</code>
        {' and the branch '}
        <code>{s.branch}</code>.
        {loss !== '' ? (
          <>
            {' '}
            <span class="warn">{loss}</span>
          </>
        ) : (
          ' Everything on the branch is pushed, so nothing is lost.'
        )}
      </div>
      <div class="row">
        <button
          type="button"
          class="k-act danger-solid"
          disabled={!canAct(s.id)}
          onClick={() => remove(s)}
        >
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
  const ended = s.status === 'ended';
  // Kage never stops, archives or deletes a window it didn't create (spec §5.2).
  const own = !s.external;
  const confirming = done && own && confirmingDelete.value;
  const chip = ended ? 'ended' : group;
  const worktree = shortWorktree(s.worktree, projectsRoot.value);
  const error = actionError.value?.id === s.id ? actionError.value.text : null;
  // Every action waits for a live stream (its result arrives as an event) and for the last one.
  const off = !canAct(s.id);
  return (
    <main class="k-main">
      <div class="k-head">
        <div>
          <h3>
            <span class="k-proj">{s.project} /</span>
            <span class="k-task" title={s.task}>
              {s.task}
            </span>
            <span class={`k-chip ${CHIP[chip]}`}>{chip}</span>
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
      {/* Keyed by session, so a half-typed reply never carries over to another session. */}
      {s.question && <Ask key={s.id} session={s} question={s.question} />}
      {done && !ended && !confirming && (
        <FollowUp key={s.id} id={s.id} placeholder="Follow up in this session…" hotkey="R" />
      )}
      {confirming && <Confirm s={s} />}
      {error !== null && (
        <div class="k-err" role="alert">
          {error}
        </div>
      )}
      <div class="k-foot">
        <div class="l">
          {/* Kage resumes only sessions it launched; an external window keeps its Terminal. */}
          {ended && own ? (
            <Act
              label="Resume"
              hotkey="U"
              icon={ICON.resume}
              disabled={off}
              onClick={() => resume(s)}
            />
          ) : (
            <Act label="Terminal" hotkey="T" icon={ICON.term} />
          )}
        </div>
        <div class="r">
          {!own ? null : done ? (
            <>
              <Act
                label="Archive"
                hotkey="E"
                icon={ICON.arch}
                disabled={off}
                onClick={() => archive(s, true)}
              />
              <Act
                label="Delete…"
                cls="stop"
                icon={ICON.del}
                disabled={off}
                onClick={() => {
                  confirmingDelete.value = true;
                }}
              />
            </>
          ) : (
            <>
              {stopArmed.value === s.id && (
                <span class="k-hint" role="status">
                  Press X again to stop
                </span>
              )}
              <Act
                label="Stop"
                hotkey="X"
                cls="stop"
                icon={ICON.stop}
                disabled={off || stopPending(s)}
                onClick={() => stop(s)}
              />
            </>
          )}
        </div>
      </div>
    </main>
  );
}
