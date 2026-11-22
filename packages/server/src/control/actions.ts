import type { Question, SessionStatus } from '@kage/shared';
import { firstLine } from '../git/exec.ts';
import type { LiveSource } from '../live-source.ts';
import { parsePermissionPrompt, parseStartupScreen, showsPrompt } from '../pane/prompt.ts';
import type { Key, TmuxClient } from '../tmux/client.ts';
import {
  answerPlan,
  boxWorking,
  cursorIndex,
  DEFAULT_ATTACH,
  hasCheckboxes,
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

/**
 * One action at a time per session (F5): answer, reply and stop, the finish actions (pin,
 * archive, restore, delete) and resume share one lock, built once in serve.ts and injected.
 */
export class ActionLock {
  readonly #held = new Map<string, symbol>();

  /** A release function when `id` was free (call it once, in a finally); null while held. */
  tryAcquire(id: string): (() => void) | null {
    if (this.#held.has(id)) return null;
    const token = Symbol(id);
    this.#held.set(id, token);
    return () => {
      // A stale release never frees a later holder.
      if (this.#held.get(id) === token) this.#held.delete(id);
    };
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
  /** An AskUserQuestion that allows several choices (from the hook's or transcript's multiSelect). */
  multiSelect: boolean;
  external: boolean;
}

export type ControlTmux = Pick<
  TmuxClient,
  'capturePane' | 'sendKeys' | 'sendText' | 'windowKageId' | 'killOwnedWindow'
>;
export type ControlSource = Pick<
  LiveSource,
  'target' | 'markAnswered' | 'markReplying' | 'markReplied' | 'markStopped'
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
/** R63: a startup screen is answered once two captures this far apart match… */
const STABLE_MS = 300;
/** …comparing at most this many times (about 1.5 s). */
const STABLE_TRIES = 5;

const CHANGED = 'The prompt on screen changed. Look again.';
/** R36: the card's question is not the one on the server or on screen any more. */
const QUESTION_CHANGED = 'The question changed. Look again before answering.';
const MULTI = 'This question allows several choices. Answer it in the terminal.';
const WORKING = "Claude is working. Wait until it's done.";
const NO_BOX = "Claude isn't at its input box.";
const ENDED = 'This session has ended.';
/** tmux's answer for a window, pane or session that no longer exists. */
export const GONE_RE =
  /no such window|can't find window|can't find pane|can't find session|no server running/i;
/** A failed tmux run (execFile attaches its stderr); anything else is a bug, not tmux's. */
export const isExecError = (e: unknown): boolean =>
  e instanceof Error && typeof (e as { stderr?: unknown }).stderr === 'string';
/** Whitespace collapsed, for comparing question texts. */
const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();
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
  readonly #lock: ActionLock;

  constructor(d: {
    tmux: ControlTmux;
    source: ControlSource;
    sleep?: (ms: number) => Promise<void>;
    /** The command the login refusal names (default `tmux attach -t kage`). */
    attach?: string;
    /** The per-session lock shared with the finish actions and resume (F5). */
    lock?: ActionLock;
  }) {
    this.#tmux = d.tmux;
    this.#source = d.source;
    this.#lock = d.lock ?? new ActionLock();
    this.#sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.#attach = d.attach ?? DEFAULT_ATTACH;
  }

  /**
   * Answers option `option` of the question whose text the card showed (`shown`, R36): only when
   * the server's question has that text and the fresh capture shows that same question, with the
   * same options.
   */
  answer(id: string, option: number, shown: string): Promise<void> {
    return this.#locked(id, async (t) => {
      if (t.status === 'ended' || !t.paneId) throw new ActionError(409, ENDED);
      if (t.status !== 'needs-you' || !t.question || !t.promptKind) {
        throw new ActionError(409, "This session isn't waiting for an answer.");
      }
      const { paneId, question, promptKind: kind } = t;
      if (norm(question.text) !== norm(shown)) throw new ActionError(409, QUESTION_CHANGED);
      if (kind === 'ask' && t.multiSelect) throw new ActionError(409, MULTI);
      const plan = answerPlan(kind, question.options, option, this.#attach);
      if (plan.kind === 'refuse') throw new ActionError(409, plan.reason);

      // R63: a startup screen drops a key sent while it draws; wait until it holds still.
      const before = STARTUP_KINDS.has(kind)
        ? await this.#stableCapture(paneId)
        : await this.#capture(paneId);
      if (kind === 'ask' && hasCheckboxes(parsePermissionPrompt(before)?.options ?? [])) {
        throw new ActionError(409, MULTI);
      }
      if (!this.#showsSame(before, kind, question)) throw new ActionError(409, QUESTION_CHANGED);
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
          // The TUI redraws a moment after the keys (R47): look until the ❯ is on the option, at
          // most 10 times. The screen going away, or the ❯ never getting there, refuses the Enter.
          let gone = false;
          const there = await this.#poll(paneId, (after) => {
            if (!this.#showsSame(after, kind, question)) {
              gone = true;
              return true;
            }
            return cursorIndex(after, question.options) === plan.index;
          });
          if (gone || !there) throw new ActionError(409, CHANGED);
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
        // The transcript's interrupt record for this Escape is not a denial (Review Focus 6).
        this.#source.markReplying(id);
        await this.#keys(paneId, ['Escape']);
        const back = await this.#poll(
          paneId,
          (pane) => inputLine(pane) !== null && !showsPrompt(pane),
        );
        if (!back) throw new ActionError(409, "Claude didn't return to its input box.");
      }
      // Right before typing: the idle box, no prompt, and Claude not working (a turn in progress
      // would queue the text, and a prompt could take a typed character as its answer).
      const ready = await this.#capture(paneId);
      if (showsPrompt(ready)) throw new ActionError(409, CHANGED);
      if (inputLine(ready) === null) throw new ActionError(409, NO_BOX);
      if (boxWorking(ready)) throw new ActionError(409, WORKING);
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

  /**
   * 404 for an unknown id, 409 while another action runs. A tmux run that fails because the
   * window or pane is gone is 409 (ended); any other failed tmux run is 422. Other errors are
   * bugs and go through as they are (the route answers 500).
   */
  async #locked(id: string, run: (t: ControlTarget) => Promise<void>): Promise<void> {
    const t = this.#source.target(id);
    if (!t) throw new ActionError(404, `No session with id ${id}.`);
    const release = this.#lock.tryAcquire(id);
    if (!release) {
      throw new ActionError(409, 'Kage is still sending the last action to this session.');
    }
    try {
      await run(t);
    } catch (e) {
      if (e instanceof ActionError || !isExecError(e)) throw e;
      if (GONE_RE.test(firstLine(e))) throw new ActionError(409, ENDED);
      throw new ActionError(422, `tmux couldn't send the keys: ${firstLine(e)}`);
    } finally {
      release();
    }
  }

  #capture(paneId: string): Promise<string> {
    return this.#tmux.capturePane(paneId, CAPTURE_LINES);
  }

  /**
   * R63: a capture equal to the one STABLE_MS before it, comparing at most STABLE_TRIES times;
   * a screen that never holds still is 409, with no key sent.
   */
  async #stableCapture(paneId: string): Promise<string> {
    let prev = await this.#capture(paneId);
    for (let i = 0; i < STABLE_TRIES; i++) {
      await this.#sleep(STABLE_MS);
      const next = await this.#capture(paneId);
      if (next === prev) return next;
      prev = next;
    }
    throw new ActionError(409, 'The screen is still drawing. Try again in a moment.');
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

  /**
   * The capture shows the question the board showed: the same kind, the same question text
   * (whitespace collapsed, R36) and the same option labels. An AskUserQuestion's text comes from
   * the hook in full (it may span lines or paragraphs) while the screen parse keeps only its last
   * line and the lines wrapped into it, so for `ask` the server text must end with the (non-empty)
   * screen text; permission prompts and startup screens compare exactly.
   */
  #showsSame(pane: string, kind: PromptKind, question: Question): boolean {
    let seen: Question | null;
    if (kind === 'permission' || kind === 'ask') {
      seen = parseStartupScreen(pane) === null ? parsePermissionPrompt(pane) : null;
    } else {
      const s = parseStartupScreen(pane);
      seen = s !== null && s.screen === kind ? s : null;
    }
    if (seen === null || !sameOptions(seen.options, question.options)) return false;
    const onScreen = norm(seen.text);
    const expected = norm(question.text);
    if (kind === 'ask') {
      // At a word boundary: a screen line "shes?" must not match "…use dashes?".
      return onScreen !== '' && (expected === onScreen || expected.endsWith(` ${onScreen}`));
    }
    return onScreen === expected;
  }
}
