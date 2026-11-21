import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { answerPlan, cursorIndex, inputLine, inputShows } from './keys.ts';

const pane = (name: string): string =>
  readFileSync(join(import.meta.dirname, '../../test/fixtures/panes', `${name}.txt`), 'utf8');

const TRUST = ['No, exit', 'Yes, I trust this folder'];
const RULE = '─'.repeat(80);
const NBSP = ' ';

/** trust.txt with the cursor moved to "Yes, I trust this folder" (as `Down` leaves it). */
const trustOnYes = (): string =>
  pane('trust')
    .replace(' ❯ No, exit', '   No, exit')
    .replace('   Yes, I trust this folder', ' ❯ Yes, I trust this folder');

/** An idle input box holding `text` (Claude puts a no-break space after the ❯). */
const idle = (text: string, footer = '  ⏸ manual mode on · ? for shortcuts'): string =>
  ['● Done.', '', RULE, `❯${NBSP}${text}`, RULE, footer, '', ''].join('\n');

describe('answerPlan', () => {
  const attach = 'tmux attach -t kage';

  it('a digit for permission prompts, AskUserQuestion and the renderer offer (no Enter)', () => {
    expect(answerPlan('permission', ['Yes', 'Yes, and…', 'No'], 3, attach)).toEqual({
      kind: 'digit',
      digit: 3,
    });
    expect(answerPlan('ask', ['Dashes', 'Underscores'], 2, attach)).toEqual({
      kind: 'digit',
      digit: 2,
    });
    expect(answerPlan('renderer', ['Yes, try it', 'Not now'], 2, attach)).toEqual({
      kind: 'digit',
      digit: 2,
    });
  });

  it('Enter for the security notes and the theme screen whose only option is Continue', () => {
    expect(answerPlan('security', ['Continue'], 1, attach)).toEqual({ kind: 'enter' });
    expect(answerPlan('theme', ['Continue'], 1, attach)).toEqual({ kind: 'enter' });
  });

  it('the cursor for the trust screen and a theme screen with options (0-based index)', () => {
    expect(answerPlan('trust', TRUST, 2, attach)).toEqual({ kind: 'cursor', index: 1 });
    expect(answerPlan('trust', TRUST, 1, attach)).toEqual({ kind: 'cursor', index: 0 });
    expect(answerPlan('theme', ['Auto', 'Dark mode', 'Light mode'], 3, attach)).toEqual({
      kind: 'cursor',
      index: 2,
    });
  });

  it('refuses the login screen with the attach command', () => {
    expect(answerPlan('login', [], 1, attach)).toEqual({
      kind: 'refuse',
      reason: 'Sign in to Claude Code in the terminal: tmux attach -t kage.',
    });
    expect(answerPlan('login', [], 1, 'tmux -L work attach -t agents')).toEqual({
      kind: 'refuse',
      reason: 'Sign in to Claude Code in the terminal: tmux -L work attach -t agents.',
    });
  });

  it('refuses an option the prompt does not have: 0, 5 of 4, 10', () => {
    const four = ['Yes', 'Yes, and…', 'Yes, and switch…', 'No'];
    expect(answerPlan('permission', four, 0, attach)).toEqual({
      kind: 'refuse',
      reason: "There's no option 0.",
    });
    expect(answerPlan('permission', four, 5, attach)).toEqual({
      kind: 'refuse',
      reason: "There's no option 5.",
    });
    expect(answerPlan('permission', four, 10, attach)).toEqual({
      kind: 'refuse',
      reason: "There's no option 10.",
    });
    expect(answerPlan('trust', TRUST, 3, attach)).toEqual({
      kind: 'refuse',
      reason: "There's no option 3.",
    });
    expect(answerPlan('security', ['Continue'], 2, attach).kind).toBe('refuse');
    expect(answerPlan('permission', four, 1.5, attach).kind).toBe('refuse');
  });
});

describe('cursorIndex', () => {
  it('trust.txt: the ❯ is on "No, exit" (index 0), as recorded', () => {
    expect(cursorIndex(pane('trust'), TRUST)).toBe(0);
    expect(cursorIndex(pane('real-trust-80'), TRUST)).toBe(0);
  });

  it('the same screen with the ❯ moved: index 1', () => {
    expect(cursorIndex(trustOnYes(), TRUST)).toBe(1);
  });

  it('numbered options (a theme screen)', () => {
    const p =
      ' Choose the text style that looks best with your terminal\n\n   1. Auto\n ❯ 2. Dark mode\n   3. Light mode\n';
    expect(cursorIndex(p, ['Auto', 'Dark mode', 'Light mode'])).toBe(1);
  });

  it('null when an option is missing, none or two carry the ❯, or the order differs', () => {
    expect(cursorIndex(pane('idle-typed'), TRUST)).toBeNull();
    expect(cursorIndex(pane('trust').replace(' ❯ No, exit', '   No, exit'), TRUST)).toBeNull();
    expect(
      cursorIndex(
        pane('trust').replace('   Yes, I trust this folder', ' ❯ Yes, I trust this folder'),
        TRUST,
      ),
    ).toBeNull();
    expect(cursorIndex(pane('trust'), ['Yes, I trust this folder', 'No, exit'])).toBeNull();
    expect(cursorIndex(pane('trust'), [])).toBeNull();
  });

  it('reads only the live screen: an old trust screen above other output does not count', () => {
    const old = `${pane('trust')}\n● Hi\n${idle('')}`;
    expect(cursorIndex(old, TRUST)).toBeNull();
  });
});

describe('inputLine', () => {
  it('idle-typed.txt: the typed text after "❯" and its no-break space', () => {
    expect(inputLine(pane('idle-typed'))).toBe('fix the typo in notes');
  });

  it('"" for an empty box (no-break space or plain space after ❯, or none)', () => {
    expect(inputLine(idle(''))).toBe('');
    expect(inputLine(idle('').replace(`❯${NBSP}`, '❯ '))).toBe('');
  });

  it('a ghost suggestion reads like typed text (real-done-80: "commit this")', () => {
    expect(inputLine(pane('real-done-80'))).toBe('commit this');
  });

  it('the placeholder of a pasted reply', () => {
    expect(inputLine(pane('idle-pasted'))).toBe('[Pasted text #1]');
  });

  it('joins the rows of a wrapped box', () => {
    const p = [
      '',
      RULE,
      `❯${NBSP}first row of a long reply that`,
      '  wraps onto a second row',
      RULE,
      '  ? for shortcuts',
    ].join('\n');
    expect(inputLine(p)).toBe('first row of a long reply that wraps onto a second row');
  });

  it('null at a permission prompt, an AskUserQuestion, the trust screen, after exit, or empty', () => {
    expect(inputLine(pane('permission-bash'))).toBeNull();
    expect(inputLine(pane('permission-edit'))).toBeNull();
    expect(inputLine(pane('ask'))).toBeNull();
    expect(inputLine(pane('trust'))).toBeNull();
    expect(inputLine(pane('after-exit'))).toBeNull();
    expect(inputLine('')).toBeNull();
  });

  it('null when the box is not at the bottom (scrolled-up conversation text)', () => {
    const p = `${idle('old')}\n● More output\n● and more\n● and more\n● and more\n`;
    expect(inputLine(p)).toBeNull();
  });
});

describe('inputShows', () => {
  it('true when the box starts with the first 20 characters of the text', () => {
    expect(inputShows(pane('idle-typed'), 'fix the typo in notes')).toBe(true);
    expect(inputShows(idle('use the other script'), 'use the other script')).toBe(true);
  });

  it('collapses whitespace on both sides', () => {
    expect(inputShows(idle('use  the   other script'), 'use the other  script')).toBe(true);
    const p = [
      '',
      RULE,
      `❯${NBSP}a long reply that the box`,
      '  wraps onto two rows',
      RULE,
      '',
    ].join('\n');
    expect(inputShows(p, 'a long reply that the box wraps onto two rows')).toBe(true);
  });

  it('false for an empty box, other text, or a ghost suggestion that differs', () => {
    expect(inputShows(idle(''), 'use the other script')).toBe(false);
    expect(inputShows(idle('commit this'), 'use the other script')).toBe(false);
    expect(inputShows(pane('permission-bash'), 'Yes')).toBe(false);
  });

  it('false when other text sits before or after the reply (leftover typing would be sent)', () => {
    expect(inputShows(idle('rm -rf build use the other script'), 'use the other script')).toBe(
      false,
    );
    expect(inputShows(idle('use the other script and also rm -rf ~'), 'use the other script')).toBe(
      false,
    );
  });

  it('a reply over 800 UTF-16 units may show as one paste placeholder (K9)', () => {
    const long = 'x'.repeat(801);
    expect(inputShows(pane('idle-pasted'), long)).toBe(true);
    expect(inputShows(idle('[Pasted text #12]'), long)).toBe(true);
    // 800 units show as text: a placeholder is no proof for them.
    expect(inputShows(pane('idle-pasted'), 'x'.repeat(800))).toBe(false);
    // Two placeholders, or one after typed text, hold more than this reply.
    expect(inputShows(idle('[Pasted text #1][Pasted text #2]'), long)).toBe(false);
    expect(inputShows(idle('rm -rf ~ [Pasted text #3]'), long)).toBe(false);
  });

  it('ignores characters a capture drops (format characters)', () => {
    expect(inputShows(idle('ab'), 'a​b')).toBe(true);
  });
});
