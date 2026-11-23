import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Close } from '../live-source.ts';
import { parsePermissionPrompt } from '../pane/prompt.ts';
import type { Key } from '../tmux/client.ts';
import { ActionError, attachCommand, type ControlTarget, SessionControls } from './actions.ts';

const pane = (name: string): string =>
  readFileSync(join(import.meta.dirname, '../../test/fixtures/panes', `${name}.txt`), 'utf8');

const RULE = '─'.repeat(80);
const NBSP = String.fromCodePoint(0xa0);
/** An idle input box holding `text`. */
const idle = (text: string): string =>
  ['● Done.', '', RULE, `❯${NBSP}${text}`, RULE, '  ⏸ manual mode on · ? for shortcuts', ''].join(
    '\n',
  );
/** What Claude shows right after Escape at a Bash prompt: the denial, then the empty box. */
const DENIED = [
  '● Bash(npm test)',
  `  ⎿ ${NBSP}Interrupted · What should Claude do instead?`,
  '',
  RULE,
  `❯${NBSP}`,
  RULE,
  '  ⏸ manual mode on · ? for shortcuts',
  '',
].join('\n');
const trustOnYes = (): string =>
  pane('trust')
    .replace(' ❯ No, exit', '   No, exit')
    .replace('   Yes, I trust this folder', ' ❯ Yes, I trust this folder');

const BASH_OPTIONS = [
  'Yes',
  'Yes, and don’t ask again for: npm test *',
  'Yes, and switch to auto mode',
  'No',
];
const TRUST = ['No, exit', 'Yes, I trust this folder'];

type Call =
  | { op: 'capture' }
  | { op: 'keys'; keys: Key[] }
  | { op: 'text'; text: string }
  | { op: 'kageId'; windowId: string }
  | { op: 'kill'; windowId: string; kageId: string };

/** A tmux whose captures are scripted (each call takes the next; the last one repeats). */
class FakeTmux {
  calls: Call[] = [];
  captures: string[] = [];
  /** What the window's @kage_id holds. */
  held: string | null = 'k-1';
  killResult = true;
  keysError: Error | null = null;
  /** Runs inside each sendKeys, before it resolves (to interleave a second action). */
  duringKeys: (() => Promise<void>) | null = null;
  /** Panes the next capture returns after the given call kinds (a scripted terminal). */
  async capturePane(_paneId: string, _lines: number): Promise<string> {
    this.calls.push({ op: 'capture' });
    if (this.captures.length === 0) return '';
    return (this.captures.length > 1 ? this.captures.shift() : this.captures[0]) as string;
  }
  async sendKeys(_paneId: string, keys: Key[]): Promise<void> {
    this.calls.push({ op: 'keys', keys });
    if (this.duringKeys) await this.duringKeys();
    if (this.keysError) throw this.keysError;
  }
  async sendText(_paneId: string, text: string): Promise<void> {
    this.calls.push({ op: 'text', text });
  }
  async windowKageId(windowId: string): Promise<string | null> {
    this.calls.push({ op: 'kageId', windowId });
    return this.held;
  }
  async killOwnedWindow(windowId: string, kageId: string): Promise<boolean> {
    this.calls.push({ op: 'kill', windowId, kageId });
    return this.killResult;
  }
  /** The calls as short strings, for order assertions. */
  log(): string[] {
    return this.calls.map((c) =>
      c.op === 'keys'
        ? `keys ${c.keys.join(',')}`
        : c.op === 'text'
          ? `text ${c.text}`
          : c.op === 'kill'
            ? `kill ${c.windowId}`
            : c.op,
    );
  }
}

class FakeSource {
  targets = new Map<string, ControlTarget>();
  marks: string[] = [];
  target(id: string): ControlTarget | null {
    const t = this.targets.get(id);
    return t ? { ...t, question: t.question ? { ...t.question } : null } : null;
  }
  markAnswered(id: string): void {
    this.marks.push(`answered ${id}`);
  }
  markReplying(id: string): void {
    this.marks.push(`replying ${id}`);
  }
  markReplied(id: string): void {
    this.marks.push(`replied ${id}`);
  }
  /** Task 9: the source runs the close, then ends the session; a throw aborts with no mark. */
  stops: string[] = [];
  async stopSession(id: string, close: Close): Promise<void> {
    this.stops.push(id);
    await close();
    this.marks.push(`stopped ${id}`);
  }
}

const target = (over: Partial<ControlTarget> = {}): ControlTarget => ({
  id: 'k-1',
  kageId: 'k-1',
  windowId: '@2',
  paneId: '%2',
  status: 'needs-you',
  question: { text: 'Do you want to proceed? — npm test', options: BASH_OPTIONS },
  promptKind: 'permission',
  multiSelect: false,
  external: false,
  ...over,
});

/** The source of the last setup(): `shown` reads the card's question text from it. */
let current: FakeSource;
/** The question text the board shows for a session (what the answer body carries, R36). */
const shown = (id: string): string => current.targets.get(id)?.question?.text ?? 'none';

function setup(t: ControlTarget | null = target(), ...captures: string[]) {
  const tmux = new FakeTmux();
  tmux.captures = captures;
  const source = new FakeSource();
  current = source;
  if (t) source.targets.set(t.id, t);
  const sleeps: number[] = [];
  const controls = new SessionControls({
    tmux,
    source,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    attach: 'tmux attach -t kage',
  });
  return { tmux, source, controls, sleeps };
}

/** The ActionError an action rejects with (fails the test when it resolves). */
async function refusal(p: Promise<void>): Promise<ActionError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ActionError);
    return e as ActionError;
  }
  throw new Error('expected the action to be refused');
}

/** Every key call follows a capture (Review Focus 2: the screen is read before every key). */
function expectCaptureBeforeEveryKey(tmux: FakeTmux): void {
  tmux.calls.forEach((c, i) => {
    if (c.op === 'keys' || c.op === 'text') expect(tmux.calls[i - 1]?.op).toBe('capture');
  });
}

const CHANGED = 'The prompt on screen changed. Look again.';
const QCHANGED = 'The question changed. Look again before answering.';

describe('SessionControls.answer', () => {
  it('option 1 on a permission prompt: exactly ["1"] after one capture, then markAnswered', async () => {
    const { tmux, source, controls } = setup(target(), pane('permission-bash'));
    await controls.answer('k-1', 1, shown('k-1'));
    expect(tmux.log()).toEqual(['capture', 'keys 1']);
    expect(source.marks).toEqual(['answered k-1']);
  });

  it('option 4 (No) is the digit too: never Enter at a permission prompt', async () => {
    const { tmux, controls } = setup(target(), pane('permission-bash'));
    await controls.answer('k-1', 4, shown('k-1'));
    expect(tmux.log()).toEqual(['capture', 'keys 4']);
  });

  it('an AskUserQuestion takes the digit, checked against the recorded ask.txt', async () => {
    const t = target({
      promptKind: 'ask',
      question: {
        text: 'Should slug() use dashes or underscores as the word separator?',
        options: ['Dashes', 'Underscores'],
      },
    });
    const { tmux, controls } = setup(t, pane('ask'));
    await controls.answer('k-1', 2, shown('k-1'));
    expect(tmux.log()).toEqual(['capture', 'keys 2']);
  });

  it('R52: a card for a command alike in its first 120 characters is stale → 409, no keys', async () => {
    const rule = '╌'.repeat(40);
    const head = `rm -rf ${'a'.repeat(113)}`;
    const prompt = (cmd: string) =>
      [
        ' Bash command',
        ' Run it',
        rule,
        ...(cmd.match(/.{1,78}/g) ?? []).map((l) => ` ${l}`),
        rule,
        '',
        ' Do you want to proceed?',
        ' ❯ 1. Yes',
        '   2. No',
        '',
        ' Esc to cancel',
      ].join('\n');
    const oldScreen = prompt(`${head} /safe/build`);
    const newScreen = prompt(`${head} /home/dev`);
    const oldQ = parsePermissionPrompt(oldScreen);
    const newQ = parsePermissionPrompt(newScreen);
    if (!oldQ || !newQ) throw new Error('no prompt');
    // The card still shows the earlier command: same first 120 characters, another tail.
    const one = setup(target({ question: newQ }), newScreen);
    const e = await refusal(one.controls.answer('k-1', 1, oldQ.text));
    expect([e.status, e.message]).toEqual([409, QCHANGED]);
    expect(one.tmux.log()).toEqual([]);
    expect(one.source.marks).toEqual([]);
    // The server still holds the old question but the screen shows the new one → 409 too.
    const two = setup(target({ question: oldQ }), newScreen);
    const e2 = await refusal(two.controls.answer('k-1', 1, oldQ.text));
    expect([e2.status, e2.message]).toEqual([409, QCHANGED]);
    expect(two.tmux.log()).toEqual(['capture']);
    // The card that matches answers.
    const three = setup(target({ question: newQ }), newScreen);
    await three.controls.answer('k-1', 1, newQ.text);
    expect(three.tmux.log()).toEqual(['capture', 'keys 1']);
  });

  it('different options on screen → 409, no keys', async () => {
    const t = target({ question: { text: 'Edit?', options: ['Yes', 'No'] } });
    const { tmux, source, controls } = setup(t, pane('permission-bash'));
    const e = await refusal(controls.answer('k-1', 1, shown('k-1')));
    expect([e.status, e.message]).toEqual([409, QCHANGED]);
    expect(tmux.log()).toEqual(['capture']);
    expect(source.marks).toEqual([]);
  });

  it('no prompt on screen any more (answered in the terminal) → 409, no keys', async () => {
    const { tmux, controls } = setup(target(), idle(''));
    const e = await refusal(controls.answer('k-1', 1, shown('k-1')));
    expect([e.status, e.message]).toEqual([409, QCHANGED]);
    expect(tmux.log()).toEqual(['capture']);
  });

  it('a permission question answered while the screen shows the trust screen → 409', async () => {
    const { tmux, controls } = setup(target(), pane('trust'));
    expect((await refusal(controls.answer('k-1', 1, shown('k-1')))).message).toBe(QCHANGED);
    expect(tmux.log()).toEqual(['capture']);
  });

  it('trust option 2: ["Down"], then a capture, then ["Enter"]', async () => {
    const t = target({
      question: { text: 'Trust this folder?', options: TRUST, startup: true },
      promptKind: 'trust',
    });
    const { tmux, source, controls, sleeps } = setup(t, pane('trust'), pane('trust'), trustOnYes());
    await controls.answer('k-1', 2, shown('k-1'));
    // R63: two equal captures 300 ms apart before the first key.
    expect(tmux.log()).toEqual(['capture', 'capture', 'keys Down', 'capture', 'keys Enter']);
    expect(sleeps).toEqual([300, 100]);
    expectCaptureBeforeEveryKey(tmux);
    expect(source.marks).toEqual(['answered k-1']);
  });

  it('trust option 1 with the ❯ already there: Enter after the verified capture', async () => {
    const t = target({
      question: { text: 'Trust this folder?', options: TRUST, startup: true },
      promptKind: 'trust',
    });
    const { tmux, controls } = setup(t, pane('trust'));
    await controls.answer('k-1', 1, shown('k-1'));
    expect(tmux.log()).toEqual(['capture', 'capture', 'keys Enter']);
  });

  it('the delta comes from the observed ❯: from "Yes" to "No" is Up', async () => {
    const t = target({
      question: { text: 'Trust this folder?', options: TRUST, startup: true },
      promptKind: 'trust',
    });
    const { tmux, controls } = setup(t, trustOnYes(), trustOnYes(), pane('trust'));
    await controls.answer('k-1', 1, shown('k-1'));
    expect(tmux.log()).toEqual(['capture', 'capture', 'keys Up', 'capture', 'keys Enter']);
  });

  it('trust where the ❯ never leaves "No, exit" after Down → 409 after 10 looks, no Enter', async () => {
    const t = target({
      question: { text: 'Trust this folder?', options: TRUST, startup: true },
      promptKind: 'trust',
    });
    const { tmux, source, controls, sleeps } = setup(t, pane('trust'), pane('trust'));
    const e = await refusal(controls.answer('k-1', 2, shown('k-1')));
    expect([e.status, e.message]).toEqual([409, CHANGED]);
    expect(tmux.log()).toEqual(['capture', 'capture', 'keys Down', ...Array(10).fill('capture')]);
    expect(sleeps).toEqual([300, ...Array(10).fill(100)]);
    expect(source.marks).toEqual([]);
  });

  it('R47: the screen redraws late after Down: Enter once a later capture shows ❯ on "Yes"', async () => {
    const t = target({
      question: { text: 'Trust this folder?', options: TRUST, startup: true },
      promptKind: 'trust',
    });
    // The TUI hasn't redrawn yet when the first two captures after Down run.
    const { tmux, source, controls } = setup(
      t,
      pane('trust'),
      pane('trust'),
      pane('trust'),
      pane('trust'),
      trustOnYes(),
    );
    await controls.answer('k-1', 2, shown('k-1'));
    expect(tmux.log()).toEqual([
      'capture',
      'capture',
      'keys Down',
      'capture',
      'capture',
      'capture',
      'keys Enter',
    ]);
    expectCaptureBeforeEveryKey(tmux);
    expect(source.marks).toEqual(['answered k-1']);
  });

  it('trust where the screen went away after Down → 409 at once, no Enter', async () => {
    const t = target({
      question: { text: 'Trust this folder?', options: TRUST, startup: true },
      promptKind: 'trust',
    });
    const { tmux, controls } = setup(t, pane('trust'), pane('trust'), idle(''));
    expect((await refusal(controls.answer('k-1', 2, shown('k-1')))).message).toBe(CHANGED);
    expect(tmux.log()).toEqual(['capture', 'capture', 'keys Down', 'capture']);
  });

  it('the renderer offer takes the digit; the security notes take Enter', async () => {
    const renderer = target({
      question: { text: 'Try the new fullscreen renderer?', options: ['Yes, try it', 'Not now'] },
      promptKind: 'renderer',
    });
    const a = setup(
      renderer,
      ' Try the new fullscreen renderer?\n\n ❯ 1. Yes, try it\n   2. Not now\n',
    );
    await a.controls.answer('k-1', 2, shown('k-1'));
    expect(a.tmux.log()).toEqual(['capture', 'capture', 'keys 2']);

    const security = target({
      question: { text: 'Security notes', options: ['Continue'] },
      promptKind: 'security',
    });
    const b = setup(
      security,
      ' Security notes:\n\n 1. Claude can make mistakes\n\n Press Enter to continue…',
    );
    await b.controls.answer('k-1', 1, shown('k-1'));
    expect(b.tmux.log()).toEqual(['capture', 'capture', 'keys Enter']);
  });

  it('a startup screen of another kind on screen → 409 (security notes asked, theme shown)', async () => {
    const security = target({
      question: { text: 'Security notes', options: ['Continue'] },
      promptKind: 'security',
    });
    const { tmux, controls } = setup(
      security,
      ' Welcome.\n\n Choose the text style that looks best with your terminal\n\n ❯ Auto\n   Dark\n',
    );
    expect((await refusal(controls.answer('k-1', 1, shown('k-1')))).message).toBe(QCHANGED);
    expect(tmux.log()).toEqual(['capture', 'capture']);
  });

  it('R63: a startup screen still drawing: the first key waits until two captures 300 ms apart match', async () => {
    const t = target({
      question: { text: 'Trust this folder?', options: TRUST, startup: true },
      promptKind: 'trust',
    });
    // Half drawn, then drawn, then drawn again (stable), then the ❯ moved after Down.
    const half = pane('trust').split('\n').slice(0, 3).join('\n');
    const { tmux, controls, sleeps } = setup(t, half, pane('trust'), pane('trust'), trustOnYes());
    await controls.answer('k-1', 2, shown('k-1'));
    expect(tmux.log()).toEqual([
      'capture',
      'capture',
      'capture',
      'keys Down',
      'capture',
      'keys Enter',
    ]);
    expect(sleeps).toEqual([300, 300, 100]);
  });

  it('R63: a startup screen that never holds still → 409 after 5 comparisons, no key', async () => {
    const t = target({
      question: { text: 'Trust this folder?', options: TRUST, startup: true },
      promptKind: 'trust',
    });
    const frames = Array.from({ length: 6 }, (_, i) => `${pane('trust')}\n${'·'.repeat(i + 1)}`);
    const { tmux, source, controls, sleeps } = setup(t, ...frames, pane('trust'));
    const e = await refusal(controls.answer('k-1', 2, shown('k-1')));
    expect([e.status, e.message]).toEqual([
      409,
      'The screen is still drawing. Try again in a moment.',
    ]);
    expect(tmux.log()).toEqual(Array(6).fill('capture'));
    expect(sleeps).toEqual(Array(5).fill(300));
    expect(source.marks).toEqual([]);
  });

  it('R63: a permission prompt is answered after one capture (no stability wait)', async () => {
    const { tmux, sleeps, controls } = setup(target(), pane('permission-bash'));
    await controls.answer('k-1', 1, shown('k-1'));
    expect(tmux.log()).toEqual(['capture', 'keys 1']);
    expect(sleeps).toEqual([]);
  });

  it('login → 409 with the attach command, no keys and no capture', async () => {
    const t = target({
      question: { text: 'Sign in to Claude Code in the terminal', options: [], startup: true },
      promptKind: 'login',
    });
    const { tmux, controls } = setup(t, ' Select login method:\n');
    const e = await refusal(controls.answer('k-1', 1, shown('k-1')));
    expect([e.status, e.message]).toEqual([
      409,
      'Sign in to Claude Code in the terminal: tmux attach -t kage.',
    ]);
    expect(tmux.calls).toEqual([]);
  });

  it('an option the prompt lacks → 409, no keys', async () => {
    const { tmux, controls } = setup(target(), pane('permission-bash'));
    const e = await refusal(controls.answer('k-1', 5, shown('k-1')));
    expect([e.status, e.message]).toEqual([409, "There's no option 5."]);
    expect(tmux.calls).toEqual([]);
  });

  it('not waiting → 409 "This session isn\'t waiting for an answer."', async () => {
    for (const t of [
      target({ status: 'running', question: null, promptKind: null }),
      target({ status: 'done', question: null, promptKind: null }),
      target({ question: null }),
      target({ promptKind: null }),
    ]) {
      const { tmux, controls } = setup(t, pane('permission-bash'));
      const e = await refusal(controls.answer('k-1', 1, shown('k-1')));
      expect([e.status, e.message]).toEqual([409, "This session isn't waiting for an answer."]);
      expect(tmux.calls).toEqual([]);
    }
  });

  it('ended or windowless → 409 "This session has ended."', async () => {
    for (const t of [target({ status: 'ended' }), target({ windowId: null, paneId: null })]) {
      const { tmux, controls } = setup(t, pane('permission-bash'));
      const e = await refusal(controls.answer('k-1', 1, shown('k-1')));
      expect([e.status, e.message]).toEqual([409, 'This session has ended.']);
      expect(tmux.calls).toEqual([]);
    }
  });

  it('an external session can be answered (only Stop is Kage-only)', async () => {
    const t = target({ id: 'ext-@5', kageId: null, external: true });
    const { tmux, controls } = setup(t, pane('permission-bash'));
    await controls.answer('ext-@5', 1, shown('ext-@5'));
    expect(tmux.log()).toEqual(['capture', 'keys 1']);
  });
});

describe('SessionControls.reply', () => {
  it('at a permission prompt: Escape, captures until the idle box shows, sendText, a capture, Enter', async () => {
    const { tmux, source, controls, sleeps } = setup(
      target(),
      pane('permission-bash'), // checked before Escape
      pane('permission-bash'), // 1st poll: still drawn
      DENIED, // 2nd poll: the box is back
      DENIED, // re-read right before typing
      idle('use the other script'), // after typing
    );
    await controls.reply('k-1', 'use the other script');
    expect(tmux.log()).toEqual([
      'capture',
      'keys Escape',
      'capture',
      'capture',
      'capture',
      'text use the other script',
      'capture',
      'keys Enter',
    ]);
    expect(sleeps).toEqual([100, 100]);
    expectCaptureBeforeEveryKey(tmux);
    // markReplying comes before the Escape, so its interrupt record is not read as a No.
    expect(source.marks).toEqual(['replying k-1', 'replied k-1']);
  });

  it('at an AskUserQuestion: the same, Escape first', async () => {
    const t = target({
      promptKind: 'ask',
      question: { text: 'Separator?', options: ['Dashes', 'Underscores'] },
    });
    const { tmux, controls } = setup(t, pane('ask'), idle(''), idle('neither, use camelCase'));
    await controls.reply('k-1', 'neither, use camelCase');
    expect(tmux.log()).toEqual([
      'capture',
      'keys Escape',
      'capture',
      'capture',
      'text neither, use camelCase',
      'capture',
      'keys Enter',
    ]);
  });

  it('at needs-you when the screen shows no prompt → 409 and no Escape (it would interrupt Claude)', async () => {
    const { tmux, controls } = setup(target(), '● Bash(npm test)\n  ⎿  Running…\n');
    expect((await refusal(controls.reply('k-1', 'hi'))).message).toBe(CHANGED);
    expect(tmux.log()).toEqual(['capture']);
  });

  it('the box never comes back after Escape → 409 after 10 polls, nothing typed', async () => {
    const { tmux, controls, sleeps } = setup(target(), pane('permission-bash'));
    const e = await refusal(controls.reply('k-1', 'hi'));
    expect([e.status, e.message]).toEqual([409, "Claude didn't return to its input box."]);
    expect(sleeps).toHaveLength(10);
    expect(tmux.log().filter((l) => l.startsWith('keys') || l.startsWith('text'))).toEqual([
      'keys Escape',
    ]);
  });

  it('at done: a capture, sendText, a capture, Enter: never Enter before the text (ghost guard)', async () => {
    const t = target({ status: 'done', question: null, promptKind: null });
    const { tmux, source, controls } = setup(t, idle('commit this'), idle('add a test for slug'));
    await controls.reply('k-1', 'add a test for slug');
    expect(tmux.log()).toEqual(['capture', 'text add a test for slug', 'capture', 'keys Enter']);
    expect(source.marks).toEqual(['replied k-1']);
  });

  it('at done when inputShows stays false → 409 and no Enter (K8: the text stays in the box)', async () => {
    const t = target({ status: 'done', question: null, promptKind: null });
    const { tmux, source, controls } = setup(t, idle(''), idle('rm -rf build add a test'));
    const e = await refusal(controls.reply('k-1', 'add a test'));
    expect([e.status, e.message]).toEqual([
      409,
      "Your text is still in Claude's input box; send or clear it in the terminal.",
    ]);
    expect(tmux.log()).not.toContain('keys Enter');
    expect(tmux.log().filter((l) => l.startsWith('keys'))).toEqual([]);
    expect(source.marks).toEqual([]);
  });

  it('at done when the text never reached the box → 409 "Couldn\'t type…", no Enter', async () => {
    const t = target({ status: 'done', question: null, promptKind: null });
    const { tmux, controls } = setup(t, idle(''));
    const e = await refusal(controls.reply('k-1', 'add a test'));
    expect([e.status, e.message]).toEqual([
      409,
      "Couldn't type into Claude's input box. Check the terminal.",
    ]);
    expect(tmux.log()).not.toContain('keys Enter');
  });

  it('the typed text may take a moment to show: polls before Enter', async () => {
    const t = target({ status: 'done', question: null, promptKind: null });
    const { tmux, controls } = setup(t, idle(''), idle(''), idle('add a test'));
    await controls.reply('k-1', 'add a test');
    expect(tmux.log()).toEqual(['capture', 'text add a test', 'capture', 'capture', 'keys Enter']);
  });

  it('at done without the input box → 409 "Claude isn\'t at its input box.", nothing typed', async () => {
    const t = target({ status: 'done', question: null, promptKind: null });
    const { tmux, controls } = setup(t, pane('after-exit'));
    const e = await refusal(controls.reply('k-1', 'hi'));
    expect([e.status, e.message]).toEqual([409, "Claude isn't at its input box."]);
    expect(tmux.log()).toEqual(['capture']);
  });

  it('a long reply goes in one sendText and the paste placeholder is proof (K9, K10)', async () => {
    const t = target({ status: 'done', question: null, promptKind: null });
    const long = 'word '.repeat(400).trim();
    const { tmux, controls } = setup(t, idle(''), idle('[Pasted text #3]'));
    await controls.reply('k-1', long);
    expect(tmux.calls.filter((c) => c.op === 'text')).toEqual([{ op: 'text', text: long }]);
    expect(tmux.log().at(-1)).toBe('keys Enter');
  });

  it('hostile text is typed literally, as one sendText (F15)', async () => {
    const t = target({ status: 'done', question: null, promptKind: null });
    const text = 'ok; rm -rf ~ $(id) `id` --dangerously-skip-permissions';
    const { tmux, controls } = setup(t, idle(''), idle(text));
    await controls.reply('k-1', text);
    expect(tmux.calls.filter((c) => c.op === 'text')).toEqual([{ op: 'text', text }]);
  });

  it('while running → 409, no tmux call', async () => {
    const t = target({ status: 'running', question: null, promptKind: null });
    const { tmux, controls } = setup(t, idle(''));
    const e = await refusal(controls.reply('k-1', 'hi'));
    expect([e.status, e.message]).toEqual([
      409,
      'Claude is still working. Wait for it to finish, or stop it.',
    ]);
    expect(tmux.calls).toEqual([]);
  });

  it('at a startup screen → 409 "Answer this screen with its buttons." (Escape would exit Claude)', async () => {
    const t = target({
      question: { text: 'Trust this folder?', options: TRUST, startup: true },
      promptKind: 'trust',
    });
    const { tmux, controls } = setup(t, pane('trust'));
    const e = await refusal(controls.reply('k-1', 'hi'));
    expect([e.status, e.message]).toEqual([409, 'Answer this screen with its buttons.']);
    expect(tmux.calls).toEqual([]);
  });

  it('ended or windowless → 409 "This session has ended."', async () => {
    for (const t of [target({ status: 'ended' }), target({ windowId: null, paneId: null })]) {
      const { tmux, controls } = setup(t, idle(''));
      const e = await refusal(controls.reply('k-1', 'hi'));
      expect([e.status, e.message]).toEqual([409, 'This session has ended.']);
      expect(tmux.calls).toEqual([]);
    }
  });
});

describe('SessionControls.stop', () => {
  it('re-reads @kage_id, kills the owned window, then markStopped', async () => {
    const t = target({ status: 'running', question: null, promptKind: null });
    const { tmux, source, controls } = setup(t);
    await controls.stop('k-1');
    expect(tmux.calls).toEqual([
      { op: 'kageId', windowId: '@2' },
      { op: 'kill', windowId: '@2', kageId: 'k-1' },
    ]);
    expect(source.marks).toEqual(['stopped k-1']);
  });

  it('an external session → 403, no tmux call', async () => {
    const t = target({ id: 'ext-@5', kageId: null, external: true });
    const { tmux, controls } = setup(t);
    const e = await refusal(controls.stop('ext-@5'));
    expect([e.status, e.message]).toEqual([403, 'Kage only stops sessions it started.']);
    expect(tmux.calls).toEqual([]);
  });

  it('windowKageId returns another UUID → 403, no kill', async () => {
    const { tmux, source, controls } = setup(target());
    tmux.held = '7f1c2a90-0000-4000-8000-000000000002';
    const e = await refusal(controls.stop('k-1'));
    expect([e.status, e.message]).toEqual([403, "That window isn't Kage's any more."]);
    expect(tmux.log()).toEqual(['kageId']);
    expect(source.marks).toEqual([]);
  });

  it('an untagged window → 403, no kill', async () => {
    const { tmux, controls } = setup(target());
    tmux.held = null;
    expect((await refusal(controls.stop('k-1'))).status).toBe(403);
    expect(tmux.log()).toEqual(['kageId']);
  });

  it('ended or windowless → 409 "This session has already ended."', async () => {
    for (const t of [target({ status: 'ended' }), target({ windowId: null, paneId: null })]) {
      const { tmux, controls } = setup(t);
      const e = await refusal(controls.stop('k-1'));
      expect([e.status, e.message]).toEqual([409, 'This session has already ended.']);
      expect(tmux.calls).toEqual([]);
    }
  });

  it('the window closed between the re-read and the kill → 409 already ended', async () => {
    const { tmux, source, controls } = setup(target());
    tmux.killResult = false;
    const e = await refusal(controls.stop('k-1'));
    expect([e.status, e.message]).toEqual([409, 'This session has already ended.']);
    expect(source.marks).toEqual([]);
  });

  it('stop hands killOwnedWindow to source.stop; a window already gone is 409 with nothing changed', async () => {
    const { tmux, source, controls } = setup(target());
    let killsBefore = -1;
    const run = source.stopSession.bind(source);
    source.stopSession = async (id, close) => {
      killsBefore = tmux.calls.filter((c) => c.op === 'kill').length;
      await run(id, close);
    };
    await controls.stop('k-1');
    // The 403 check ran before; the kill itself runs inside the source's operation.
    expect(killsBefore).toBe(0);
    expect(tmux.log()).toEqual(['kageId', 'kill @2']);
    expect(source.stops).toEqual(['k-1']);
    expect(source.marks).toEqual(['stopped k-1']);
    const gone = setup(target());
    gone.tmux.killResult = false;
    const e = await refusal(gone.controls.stop('k-1'));
    expect([e.status, e.message]).toEqual([409, 'This session has already ended.']);
    expect(gone.source.stops).toEqual(['k-1']);
    expect(gone.source.marks).toEqual([]);
  });

  it('a done session can be stopped (409 only once ended)', async () => {
    const t = target({ status: 'done', question: null, promptKind: null });
    const { source, controls } = setup(t);
    await controls.stop('k-1');
    expect(source.marks).toEqual(['stopped k-1']);
  });
});

describe('SessionControls: all actions', () => {
  it('an unknown session → 404 "No session with id <id>"', async () => {
    const { tmux, controls } = setup(null);
    for (const p of [
      controls.answer('nope', 1, shown('nope')),
      controls.reply('nope', 'hi'),
      controls.stop('nope'),
    ]) {
      const e = await refusal(p);
      expect([e.status, e.message]).toEqual([404, 'No session with id nope.']);
    }
    expect(tmux.calls).toEqual([]);
  });

  it('two concurrent answers: the second is 409 and sends nothing', async () => {
    const { tmux, controls } = setup(target(), pane('permission-bash'));
    let second: Promise<ActionError> | null = null;
    tmux.duringKeys = async () => {
      tmux.duringKeys = null;
      second = refusal(controls.answer('k-1', 1, shown('k-1')));
      await second;
    };
    await controls.answer('k-1', 1, shown('k-1'));
    const e = await (second as unknown as Promise<ActionError>);
    expect([e.status, e.message]).toEqual([
      409,
      'Kage is still sending the last action to this session.',
    ]);
    expect(tmux.log()).toEqual(['capture', 'keys 1']);
  });

  it('a second action of another kind while one runs is refused too (stop during an answer)', async () => {
    const { tmux, controls } = setup(target(), pane('permission-bash'));
    let stop: Promise<ActionError> | null = null;
    tmux.duringKeys = async () => {
      tmux.duringKeys = null;
      stop = refusal(controls.stop('k-1'));
      await stop;
    };
    await controls.answer('k-1', 1, shown('k-1'));
    expect((await (stop as unknown as Promise<ActionError>)).status).toBe(409);
    expect(tmux.log()).toEqual(['capture', 'keys 1']);
  });

  it("a sendKeys rejection → 422 with tmux's first line, and the lock is released", async () => {
    const { tmux, source, controls } = setup(target(), pane('permission-bash'));
    tmux.keysError = Object.assign(new Error('Command failed'), {
      stderr: 'server exited unexpectedly\nmore detail\n',
    });
    const e = await refusal(controls.answer('k-1', 1, shown('k-1')));
    expect([e.status, e.message]).toEqual([
      422,
      "tmux couldn't send the keys: server exited unexpectedly",
    ]);
    expect(source.marks).toEqual([]);
    tmux.keysError = null;
    await controls.answer('k-1', 1, shown('k-1'));
    expect(source.marks).toEqual(['answered k-1']);
  });

  it('a capture failure → 422 and nothing sent', async () => {
    const { tmux, controls } = setup(target());
    tmux.capturePane = async () => {
      tmux.calls.push({ op: 'capture' });
      throw Object.assign(new Error('x'), { stderr: 'lost server\n' });
    };
    const e = await refusal(controls.answer('k-1', 1, shown('k-1')));
    expect([e.status, e.message]).toEqual([422, "tmux couldn't send the keys: lost server"]);
    expect(tmux.log()).toEqual(['capture']);
  });

  it('a window gone at the @kage_id re-read → 409 already ended', async () => {
    const { tmux, controls } = setup(
      target({ status: 'running', question: null, promptKind: null }),
    );
    tmux.windowKageId = async () => {
      throw Object.assign(new Error('x'), { stderr: "can't find window: @2\n" });
    };
    const e = await refusal(controls.stop('k-1'));
    expect([e.status, e.message]).toEqual([409, 'This session has already ended.']);
  });

  it('actions on different sessions do not block each other', async () => {
    const { tmux, source, controls } = setup(target(), pane('permission-bash'));
    source.targets.set('k-2', target({ id: 'k-2', kageId: 'k-2' }));
    let other: Promise<void> | null = null;
    tmux.duringKeys = async () => {
      tmux.duringKeys = null;
      other = controls.answer('k-2', 1, shown('k-2'));
      await other;
    };
    await controls.answer('k-1', 1, shown('k-1'));
    await other;
    expect(source.marks.sort()).toEqual(['answered k-1', 'answered k-2']);
  });
});

describe('attachCommand', () => {
  it('names the session, and the socket when one is set, quoted for a shell when needed', () => {
    expect(attachCommand('kage', null)).toBe('tmux attach -t kage');
    expect(attachCommand('agents', 'kage-test-1')).toBe('tmux -L kage-test-1 attach -t agents');
    expect(attachCommand("my work's", null)).toBe(String.raw`tmux attach -t 'my work'\''s'`);
    expect(attachCommand('$(id)', 'a b')).toBe("tmux -L 'a b' attach -t '$(id)'");
  });
});

describe('fix round 1: SessionControls', () => {
  /** permission-bash.txt with another command: prompt B, with the same labels as prompt A. */
  const promptB = (): string =>
    pane('permission-bash')
      .replaceAll(' npm test', ' npm run deploy')
      .replace(
        'Yes, and don’t ask again for: npm run deploy *',
        'Yes, and don’t ask again for: npm test *',
      );
  const A_TEXT = 'Do you want to proceed? — npm test';

  it('R36: prompt A answered in the terminal, prompt B with the same labels appears: the old click is 409, no key', async () => {
    // The server already holds prompt B; the board still shows A.
    const b = target({
      question: { text: 'Do you want to proceed? — npm run deploy', options: BASH_OPTIONS },
    });
    const { tmux, source, controls } = setup(b, promptB());
    const e = await refusal(controls.answer('k-1', 1, A_TEXT));
    expect([e.status, e.message]).toEqual([409, QCHANGED]);
    expect(tmux.calls).toEqual([]);
    expect(source.marks).toEqual([]);
  });

  it('R36: the server still holds A but the screen shows B (same labels): 409 after the capture, no key', async () => {
    const { tmux, controls } = setup(target(), promptB());
    expect(promptB()).toContain('npm run deploy');
    const e = await refusal(controls.answer('k-1', 1, A_TEXT));
    expect([e.status, e.message]).toEqual([409, QCHANGED]);
    expect(tmux.log()).toEqual(['capture']);
  });

  it('R36: the question text is compared with whitespace collapsed', async () => {
    const { tmux, controls } = setup(target(), pane('permission-bash'));
    await controls.answer('k-1', 1, '  Do you want   to proceed?  —  npm test ');
    expect(tmux.log()).toEqual(['capture', 'keys 1']);
  });

  it('R39: "Yes, and switch to auto mode" is refused: 409 "Switch modes in the terminal.", no capture', async () => {
    const { tmux, controls } = setup(target(), pane('permission-bash'));
    const e = await refusal(controls.answer('k-1', 3, A_TEXT));
    expect([e.status, e.message]).toEqual([409, 'Switch modes in the terminal.']);
    expect(tmux.calls).toEqual([]);
  });

  it('R39: the renderer offer refuses "Yes, try it"; "Not now" goes', async () => {
    const renderer = target({
      question: { text: 'Try the new fullscreen renderer?', options: ['Yes, try it', 'Not now'] },
      promptKind: 'renderer',
    });
    const screen = ' Try the new fullscreen renderer?\n\n ❯ 1. Yes, try it\n   2. Not now\n';
    const { tmux, controls } = setup(renderer, screen);
    const e = await refusal(controls.answer('k-1', 1, shown('k-1')));
    expect(e.status).toBe(409);
    expect(tmux.calls).toEqual([]);
    await controls.answer('k-1', 2, shown('k-1'));
    expect(tmux.log()).toEqual(['capture', 'capture', 'keys 2']);
  });

  it('a multi-select AskUserQuestion (multiSelect from the hook) → 409, no capture', async () => {
    const t = target({
      promptKind: 'ask',
      multiSelect: true,
      question: {
        text: 'Should slug() use dashes or underscores as the word separator?',
        options: ['Dashes', 'Underscores'],
      },
    });
    const { tmux, controls } = setup(t, pane('ask'));
    const e = await refusal(controls.answer('k-1', 1, shown('k-1')));
    expect([e.status, e.message]).toEqual([
      409,
      'This question allows several choices. Answer it in the terminal.',
    ]);
    expect(tmux.calls).toEqual([]);
  });

  it('checkboxes on the options on screen → 409 multi-select, no key', async () => {
    const t = target({
      promptKind: 'ask',
      question: {
        text: 'Should slug() use dashes or underscores as the word separator?',
        options: ['Dashes', 'Underscores'],
      },
    });
    const boxed = pane('ask')
      .replace('1. Dashes', '1. ☐ Dashes')
      .replace('2. Underscores', '2. ☐ Underscores');
    const { tmux, controls } = setup(t, boxed);
    const e = await refusal(controls.answer('k-1', 1, shown('k-1')));
    expect(e.message).toBe('This question allows several choices. Answer it in the terminal.');
    expect(tmux.log()).toEqual(['capture']);
  });

  it('reply at done while the footer says Claude is working → 409, nothing typed', async () => {
    const t = target({ status: 'done', question: null, promptKind: null });
    const working = idle('').replace('? for shortcuts', 'esc to interrupt');
    const { tmux, controls } = setup(t, working);
    const e = await refusal(controls.reply('k-1', 'add a test'));
    expect([e.status, e.message]).toEqual([409, "Claude is working. Wait until it's done."]);
    expect(tmux.log()).toEqual(['capture']);
  });

  it('reply: a prompt that shows on the re-read right before typing → 409, nothing typed', async () => {
    const { tmux, controls } = setup(
      target(),
      pane('permission-bash'),
      DENIED,
      pane('permission-edit'),
    );
    const e = await refusal(controls.reply('k-1', 'use the other script'));
    expect([e.status, e.message]).toEqual([409, CHANGED]);
    expect(tmux.log()).toEqual(['capture', 'keys Escape', 'capture', 'capture']);
  });

  it('a window that dies mid-action (tmux: can\'t find pane) → 409 "This session has ended."', async () => {
    const { tmux, source, controls } = setup(target(), pane('permission-bash'));
    tmux.keysError = Object.assign(new Error('Command failed'), {
      stderr: "can't find pane: %2\n",
    });
    const e = await refusal(controls.answer('k-1', 1, shown('k-1')));
    expect([e.status, e.message]).toEqual([409, 'This session has ended.']);
    expect(source.marks).toEqual([]);
    const s2 = setup(target());
    s2.tmux.capturePane = async () => {
      throw Object.assign(new Error('x'), { stderr: 'no server running on /tmp/tmux-1/kage\n' });
    };
    expect((await refusal(s2.controls.answer('k-1', 1, shown('k-1')))).status).toBe(409);
  });

  it('an error that is not a failed tmux run is not dressed up as 422 (the route answers 500)', async () => {
    const { tmux, controls } = setup(target(), pane('permission-bash'));
    tmux.keysError = new TypeError('key not allowed: "C-u"');
    await expect(controls.answer('k-1', 1, shown('k-1'))).rejects.toThrow(TypeError);
    // The lock is still released.
    tmux.keysError = null;
    await controls.answer('k-1', 1, shown('k-1'));
  });
});

describe('fix round 2: AskUserQuestion text over several lines', () => {
  /** ask-question.txt with a line of context above the question, as a two-line question draws. */
  const twoLine = (): string =>
    pane('ask-question').replace(
      'Which separator should slug() use?',
      'The tests use both styles today.\n\nWhich separator should slug() use?',
    );
  const ask = (text: string) =>
    target({ promptKind: 'ask', question: { text, options: ['Dash', 'Underscore'] } });
  const FULL = 'The tests use both styles today. Which separator should slug() use?';

  it('the hook holds the whole question, the screen parse only its last line: answered', async () => {
    expect(twoLine()).toContain('The tests use both styles today.');
    const { tmux, source, controls } = setup(ask(FULL), twoLine());
    await controls.answer('k-1', 2, FULL);
    expect(tmux.log()).toEqual(['capture', 'keys 2']);
    expect(source.marks).toEqual(['answered k-1']);
  });

  it('the card text must still equal the server text exactly (whitespace collapsed)', async () => {
    const { tmux, controls } = setup(ask(FULL), twoLine());
    const e = await refusal(controls.answer('k-1', 2, 'Which separator should slug() use?'));
    expect([e.status, e.message]).toEqual([409, QCHANGED]);
    expect(tmux.calls).toEqual([]);
  });

  it('A vs B with the same labels but a different last line: 409, no key', async () => {
    const a = 'The tests use both styles today. Which separator should slug() use?';
    const screenB = twoLine().replace(
      'Which separator should slug() use?',
      'Which separator should the CLI flags use?',
    );
    const { tmux, controls } = setup(ask(a), screenB);
    const e = await refusal(controls.answer('k-1', 1, a));
    expect([e.status, e.message]).toEqual([409, QCHANGED]);
    expect(tmux.log()).toEqual(['capture']);
  });

  it('the screen line must end the server text at a word boundary', async () => {
    const t = ask('Should the slug use dashes?');
    const screen = pane('ask-question').replace('Which separator should slug() use?', 'shes?');
    const { tmux, controls } = setup(t, screen);
    expect((await refusal(controls.answer('k-1', 1, 'Should the slug use dashes?'))).message).toBe(
      QCHANGED,
    );
    expect(tmux.log()).toEqual(['capture']);
  });

  it('permission prompts still compare the whole text exactly', async () => {
    const t = target({
      question: {
        text: 'Run the tests first. Do you want to proceed? — npm test',
        options: BASH_OPTIONS,
      },
    });
    const { tmux, controls } = setup(t, pane('permission-bash'));
    const e = await refusal(controls.answer('k-1', 1, shown('k-1')));
    expect([e.status, e.message]).toEqual([409, QCHANGED]);
    expect(tmux.log()).toEqual(['capture']);
  });
});
