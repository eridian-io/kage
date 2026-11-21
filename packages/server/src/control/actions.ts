import type { Question, SessionStatus } from '@kage/shared';
import { firstLine } from '../git/exec.ts';
import type { LiveSource } from '../live-source.ts';
import { parsePermissionPrompt, parseStartupScreen, showsPrompt } from '../pane/prompt.ts';
import type { Key, TmuxClient } from '../tmux/client.ts';
import {
  answerPlan,
  cursorIndex,
  DEFAULT_ATTACH,
  inputLine,
  inputShows,
  type PromptKind,
} from './keys.ts';

/** An action refused or failed; `status` is the HTTP status the route answers with. */
export class ActionError extends Error {
  readonly status: 403 | 404 | 409 | 422;
  constructor(status: 403 | 404 | 409 | 422, message: string) {
    super(message);
    this.name = 'ActionError';
    this.status = status;
  }
}

/** What SessionControls needs to know about a session, read fresh for every action. */
export interface ControlTarget {
  id: string;
  kageId: string | null;
  /** Null once the window is gone. */
  windowId: string | null;
  paneId: string | null;
  status: SessionStatus;
  question: Question | null;
  promptKind: PromptKind | null;
  external: boolean;
}

export type ControlTmux = Pick<
  TmuxClient,
  'capturePane' | 'sendKeys' | 'sendText' | 'windowKageId' | 'killOwnedWindow'
>;
export type ControlSource = Pick<
  LiveSource,
  'target' | 'markAnswered' | 'markReplied' | 'markStopped'
>;

/** A word as a POSIX shell reads it: bare when safe, else single-quoted. */
const shellWord = (w: string): string =>
  /^[\w.@%+=:,/-]+$/.test(w) ? w : `'${w.replaceAll("'", "'\\''")}'`;

/** The command that attaches to Kage's tmux session, as the login refusal names it. */
export function attachCommand(session: string, socket: string | null): string {
  const sock = socket ? ` -L ${shellWord(socket)}` : '';
  return `tmux${sock} attach -t ${shellWord(session)}`;
}

/** Lines of scrollback each check captures (as LiveSource does, so the parsers see the same). */
const CAPTURE_LINES = 200;
/** After Escape, and after typing: look every 100 ms, at most 10 times. */
const POLL_MS = 100;
const POLLS = 10;

const CHANGED = 'The prompt on screen changed. Look again.';
const ENDED = 'This session has ended.';
const GONE_RE = /no such window|can't find window|can't find session|no server running/i;
const STARTUP_KINDS: ReadonlySet<PromptKind> = new Set([
  'login',
  'trust',
  'renderer',
  'security',
  'theme',
]);

const sameOptions = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((o, i) => o === b[i]);

/**
 * Answer, reply and stop as checked keystrokes (spec §5.4, §5.8; Review Focus 2, 3, 6). Before
 * every key the pane is captured and checked, so no key can approve something the user didn't
 * pick: a digit only goes to the prompt the board showed, Enter never goes to a permission prompt
 * or an AskUserQuestion, a cursor move is verified before its Enter, and Enter after a typed reply
 * follows a capture that shows the text in Claude's input box. Kage never sends C-u or a second
 * Escape (K8). One action at a time per session.
 */
export class SessionControls {
  readonly #tmux: ControlTmux;
  readonly #source: ControlSource;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #attach: string;
  readonly #busy = new Set<string>();

  constructor(d: {
    tmux: ControlTmux;
    source: ControlSource;
    sleep?: (ms: number) => Promise<void>;
    /** The command the login refusal names (default `tmux attach -t kage`). */
    attach?: string;
  }) {
    this.#tmux = d.tmux;
    this.#source = d.source;
    this.#sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.#attach = d.attach ?? DEFAULT_ATTACH;
  }

  answer(id: string, option: number): Promise<void> {
    return this.#locked(id, async (t) => {
      if (t.status === 'ended' || !t.paneId) throw new ActionError(409, ENDED);
      if (t.status !== 'needs-you' || !t.question || !t.promptKind) {
        throw new ActionError(409, "This session isn't waiting for an answer.");
      }
      const { paneId, question, promptKind: kind } = t;
      const plan = answerPlan(kind, question.options, option, this.#attach);
      if (plan.kind === 'refuse') throw new ActionError(409, plan.reason);

      const before = await this.#capture(paneId);
      if (!this.#showsSame(before, kind, question)) throw new ActionError(409, CHANGED);
      if (plan.kind === 'digit') {
        await this.#keys(paneId, [String(plan.digit) as Key]);
      } else if (plan.kind === 'enter') {
        await this.#keys(paneId, ['Enter']);
      } else {
        // The delta comes from the ❯ on screen, never from an assumed start (Down and Up wrap).
        const at = cursorIndex(before, question.options);
        if (at === null) throw new ActionError(409, CHANGED);
        const delta = plan.index - at;
        if (delta !== 0) {
          const move: Key = delta > 0 ? 'Down' : 'Up';
          await this.#keys(
            paneId,
            Array.from({ length: Math.abs(delta) }, () => move),
          );
          const after = await this.#capture(paneId);
          if (
            !this.#showsSame(after, kind, question) ||
            cursorIndex(after, question.options) !== plan.index
          ) {
            throw new ActionError(409, CHANGED);
          }
        }
        await this.#keys(paneId, ['Enter']);
      }
      this.#source.markAnswered(id);
    });
  }

  reply(id: string, text: string): Promise<void> {
    return this.#locked(id, async (t) => {
      if (t.status === 'ended' || !t.paneId) throw new ActionError(409, ENDED);
      // Escape on the trust screen exits Claude: startup screens take their buttons only.
      if (t.question?.startup || (t.promptKind && STARTUP_KINDS.has(t.promptKind))) {
        throw new ActionError(409, 'Answer this screen with its buttons.');
      }
      if (t.status === 'running') {
        throw new ActionError(409, 'Claude is still working. Wait for it to finish, or stop it.');
      }
      const { paneId } = t;
      if (t.status === 'needs-you') {
        // Escape while Claude works would interrupt it: only at a prompt that is on screen.
        const before = await this.#capture(paneId);
        if (parsePermissionPrompt(before) === null || parseStartupScreen(before) !== null) {
          throw new ActionError(409, CHANGED);
        }
        await this.#keys(paneId, ['Escape']);
        const back = await this.#poll(
          paneId,
          (pane) => inputLine(pane) !== null && !showsPrompt(pane),
        );
        if (!back) throw new ActionError(409, "Claude didn't return to its input box.");
      } else {
        const now = await this.#capture(paneId);
        if (inputLine(now) === null) throw new ActionError(409, "Claude isn't at its input box.");
      }
      // A ghost suggestion looks like typed text: Enter goes only after the text shows (K9, K10).
      await this.#tmux.sendText(paneId, text);
      let last = '';
      const shown = await this.#poll(
        paneId,
        (pane) => {
          last = pane;
          return inputShows(pane, text);
        },
        false,
      );
      if (!shown) {
        // K8: nothing clears the box (no C-u, no second Escape); the user sees why.
        throw new ActionError(
          409,
          inputLine(last) === ''
            ? "Couldn't type into Claude's input box. Check the terminal."
            : "Your text is still in Claude's input box; send or clear it in the terminal.",
        );
      }
      await this.#keys(paneId, ['Enter']);
      this.#source.markReplied(id);
    });
  }

  stop(id: string): Promise<void> {
    return this.#locked(id, async (t) => {
      if (t.external || !t.kageId)
        throw new ActionError(403, 'Kage only stops sessions it started.');
      if (t.status === 'ended' || !t.windowId) {
        throw new ActionError(409, 'This session has already ended.');
      }
      const { windowId, kageId } = t;
      let held: string | null;
      try {
        held = await this.#tmux.windowKageId(windowId);
      } catch (e) {
        if (GONE_RE.test(firstLine(e)))
          throw new ActionError(409, 'This session has already ended.');
        throw e;
      }
      if (held !== kageId) throw new ActionError(403, "That window isn't Kage's any more.");
      // killOwnedWindow re-reads the tag right before kill-window (Review Focus 3).
      if (!(await this.#tmux.killOwnedWindow(windowId, kageId))) {
        throw new ActionError(409, 'This session has already ended.');
      }
      this.#source.markStopped(id);
    });
  }

  /** 404 for an unknown id, 409 while another action runs; any other failure is tmux's: 422. */
  async #locked(id: string, run: (t: ControlTarget) => Promise<void>): Promise<void> {
    const t = this.#source.target(id);
    if (!t) throw new ActionError(404, `No session with id ${id}`);
    if (this.#busy.has(id)) {
      throw new ActionError(409, 'Kage is still sending the last action to this session.');
    }
    this.#busy.add(id);
    try {
      await run(t);
    } catch (e) {
      if (e instanceof ActionError) throw e;
      throw new ActionError(422, `tmux couldn't send the keys: ${firstLine(e)}`);
    } finally {
      this.#busy.delete(id);
    }
  }

  #capture(paneId: string): Promise<string> {
    return this.#tmux.capturePane(paneId, CAPTURE_LINES);
  }

  #keys(paneId: string, keys: Key[]): Promise<void> {
    return this.#tmux.sendKeys(paneId, keys);
  }

  /**
   * Captures until `ok` holds, at most POLLS times: `wait` first sleeps before each capture
   * (after Escape); otherwise the first capture is at once and later ones 100 ms apart.
   */
  async #poll(paneId: string, ok: (pane: string) => boolean, wait = true): Promise<boolean> {
    for (let i = 0; i < POLLS; i++) {
      if (wait || i > 0) await this.#sleep(POLL_MS);
      if (ok(await this.#capture(paneId))) return true;
    }
    return false;
  }

  /** The capture shows the prompt the board showed: the same kind and the same option labels. */
  #showsSame(pane: string, kind: PromptKind, question: Question): boolean {
    if (kind === 'permission' || kind === 'ask') {
      if (parseStartupScreen(pane) !== null) return false;
      const p = parsePermissionPrompt(pane);
      return p !== null && sameOptions(p.options, question.options);
    }
    const s = parseStartupScreen(pane);
    return s !== null && s.screen === kind && sameOptions(s.options, question.options);
  }
}
