import type { Question, Session } from '@kage/shared';
import { answer } from '../api.ts';
import { busy, connection, isAnswered, markAnswered, replyOpen } from '../store.ts';
import { FollowUp } from './FollowUp.tsx';

const close = () => {
  replyOpen.value = false;
};
const open = () => {
  replyOpen.value = true;
};

/**
 * The question card (spec §5.4, §6.1): the answer buttons with their 1–9 keys and, for questions
 * that take typed replies, "or press R to reply" and the reply field. Startup screens (R9) take
 * buttons only; the login screen has none (F8), so it points at the terminal.
 */
export function Ask({ session: s, question: q }: { session: Session; question: Question }) {
  const off = busy.value.has(s.id) || connection.value !== 'live' || isAnswered(s);
  return (
    <div class="k-ask">
      <div class="k-q">
        <small>Waiting for you</small>
        {q.text}
      </div>
      {q.startup && q.options.length === 0 ? (
        <div class="k-hint">Open the session's terminal (tmux attach) and sign in there.</div>
      ) : (
        <div class="k-opts">
          {q.options.map((o, i) => {
            const refused = q.disabledOptions?.includes(i + 1);
            return (
              <button
                type="button"
                key={`${i}`}
                disabled={off || refused}
                title={refused ? 'Choose this one in the terminal' : undefined}
                onClick={() => answer(s, i + 1)}
              >
                <kbd>{i + 1}</kbd>
                {o}
              </button>
            );
          })}
          {!q.startup && (
            <button type="button" class="k-or" onClick={open}>
              or press R to reply
            </button>
          )}
        </div>
      )}
      {replyOpen.value && !q.startup && (
        <FollowUp
          id={s.id}
          placeholder="Reply instead of choosing…"
          hotkey="Esc"
          focus
          onEscape={close}
          onSent={() => {
            markAnswered(s);
            close();
          }}
        />
      )}
    </div>
  );
}
