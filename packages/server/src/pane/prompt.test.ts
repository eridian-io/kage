import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  paneLines,
  parsePermissionPrompt,
  parseStartupScreen,
  showsDenial,
  showsIdleBox,
  showsPrompt,
} from './prompt.ts';

const pane = (name: string): string =>
  readFileSync(join(import.meta.dirname, '../../test/fixtures/panes', `${name}.txt`), 'utf8');

describe('parsePermissionPrompt', () => {
  it('reads a Bash prompt: question with the command, every option, hints trimmed', () => {
    expect(parsePermissionPrompt(pane('permission-bash'))).toEqual({
      text: 'Do you want to proceed? — npm test',
      options: [
        'Yes',
        'Yes, and don’t ask again for: npm test *',
        'Yes, and switch to auto mode',
        'No',
      ],
    });
  });
  it('reads an Edit prompt with the file name', () => {
    expect(parsePermissionPrompt(pane('permission-edit'))).toEqual({
      text: 'Do you want to make this edit to slug.js? — src/slug.js',
      options: [
        'Yes',
        'Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)',
        'No',
      ],
    });
  });
  it('reads an AskUserQuestion pane: labels only, without descriptions or UI options', () => {
    expect(parsePermissionPrompt(pane('ask-question'))).toEqual({
      text: 'Which separator should slug() use?',
      options: ['Dash', 'Underscore'],
    });
  });
  it('truncates a long command to 120 characters', () => {
    const cmd = 'x'.repeat(300);
    const rule = '╌'.repeat(40);
    const p = ` Bash command\n Run it\n${rule}\n ${cmd}\n${rule}\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel`;
    expect(parsePermissionPrompt(p)?.text).toBe(`Do you want to proceed? — ${'x'.repeat(119)}…`);
  });
  it('returns null without numbered choices, or after the exit', () => {
    expect(parsePermissionPrompt('hello\nworld\n')).toBeNull();
    expect(parsePermissionPrompt(pane('after-exit'))).toBeNull();
  });
  it("ignores a numbered list in Claude's own output (no footer)", () => {
    expect(parsePermissionPrompt('Steps:\n1. one\n2. two\n3. three\n\n❯ \n')).toBeNull();
  });
  it('uses only the last prompt on screen', () => {
    const old = 'Do you want to proceed?\n 1. Yes\n 2. No\n Esc to cancel\n';
    const q = parsePermissionPrompt(
      `${old}\n later\n\n Pick one?\n ❯ 1. A\n   2. B\n Esc to cancel`,
    );
    expect(q).toEqual({ text: 'Pick one?', options: ['A', 'B'] });
  });
  it('needs a run that reaches option 1', () => {
    expect(parsePermissionPrompt('Q?\n 3. c\n 4. d\n Esc to cancel')).toBeNull();
  });
  it('keeps hostile text as plain text', () => {
    const q = parsePermissionPrompt('<b>Q?</b>\n 1. <img onerror=x>\n 2. No\n Esc to cancel');
    expect(q).toEqual({ text: '<b>Q?</b>', options: ['<img onerror=x>', 'No'] });
  });
});

describe('live screen only', () => {
  const rule = '─'.repeat(80);
  const idle = `${rule}\n❯ commit this\n${rule}\n  ⏸ manual mode on · ? for shortcuts\n`;
  it('ignores a dismissed prompt above Claude output and an idle input box', () => {
    const old = 'Do you want to proceed?\n ❯ 1. Yes\n   2. No\n Esc to cancel · Tab to amend\n';
    const p = `${old}\n● Ran it.\n\n${idle}`;
    expect(parsePermissionPrompt(p)).toBeNull();
    expect(showsPrompt(p)).toBe(false);
  });
  it('still finds a prompt followed only by blank lines', () => {
    expect(parsePermissionPrompt('Q?\n 1. A\n 2. B\n Esc to cancel\n\n\n')).not.toBeNull();
  });
  it('ignores a startup phrase quoted above an idle input box', () => {
    const p = `● The screen says "Select login method" on first run.\n\n${idle}`;
    expect(parseStartupScreen(p)).toBeNull();
    expect(showsPrompt(p)).toBe(false);
  });
});

describe('parseStartupScreen', () => {
  it('folder trust', () => {
    const p =
      ' Accessing workspace:\n\n /home/dev/projects/demo\n\n Is this a project you created or one you trust?\n\n ❯ No, exit\n   Yes, I trust this folder\n\n Enter to confirm · Esc to cancel';
    expect(parseStartupScreen(p)).toEqual({
      text: 'Trust this folder?',
      options: ['No, exit', 'Yes, I trust this folder'],
    });
  });
  it('theme: Continue by default, numbered options when shown', () => {
    const p =
      ' Welcome.\n\n Choose the text style that looks best with your terminal\n\n ❯ Auto\n   Dark\n';
    expect(parseStartupScreen(p)).toEqual({ text: 'Choose a text style', options: ['Continue'] });
    const n =
      ' Choose the text style that looks best with your terminal\n ❯ 1. Auto\n   2. Dark mode\n   3. Light mode\n';
    expect(parseStartupScreen(n)).toEqual({
      text: 'Choose a text style',
      options: ['Auto', 'Dark mode', 'Light mode'],
    });
  });
  it('security notes', () => {
    const p = ' Security notes:\n\n 1. Claude can make mistakes\n\n Press Enter to continue…';
    expect(parseStartupScreen(p)).toEqual({ text: 'Security notes', options: ['Continue'] });
  });
  it('renderer offer', () => {
    const p = ' Try the new fullscreen renderer?\n\n ❯ 1. Yes, try it\n   2. Not now\n';
    expect(parseStartupScreen(p)).toEqual({
      text: 'Try the new fullscreen renderer?',
      options: ['Yes, try it', 'Not now'],
    });
  });
  it('login', () => {
    const p = ' Select login method:\n\n ❯ 1. Claude account\n   2. Anthropic Console\n';
    expect(parseStartupScreen(p)).toEqual({
      text: 'Sign in to Claude Code in the terminal',
      options: [],
    });
  });
  it('null for ordinary panes', () => {
    expect(parseStartupScreen(pane('permission-bash'))).toBeNull();
    expect(parseStartupScreen(pane('after-exit'))).toBeNull();
    expect(parseStartupScreen('')).toBeNull();
  });
  it('ignores a startup phrase far up in the scrollback', () => {
    const p = `Select login method\n${'filler\n'.repeat(40)}❯ \n`;
    expect(parseStartupScreen(p)).toBeNull();
  });
});

describe('real 2.1.330 captures at 80 columns (R23)', () => {
  it('folder trust is a startup screen', () => {
    expect(parseStartupScreen(pane('real-trust-80'))).toEqual({
      text: 'Trust this folder?',
      options: ['No, exit', 'Yes, I trust this folder'],
    });
    expect(showsPrompt(pane('real-trust-80'))).toBe(true);
    expect(parsePermissionPrompt(pane('real-trust-80'))).toBeNull();
  });
  it('the Edit prompt joins the wrapped option 2 into one label', () => {
    expect(parsePermissionPrompt(pane('real-edit-80'))).toEqual({
      text: 'Do you want to make this edit to notes.txt? — notes.txt',
      options: [
        'Yes',
        'Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)',
        'No',
      ],
    });
    expect(parseStartupScreen(pane('real-edit-80'))).toBeNull();
  });
  it('the finished turn shows no prompt and no startup screen', () => {
    expect(parsePermissionPrompt(pane('real-done-80'))).toBeNull();
    expect(parseStartupScreen(pane('real-done-80'))).toBeNull();
    expect(showsPrompt(pane('real-done-80'))).toBe(false);
    expect(showsIdleBox(pane('real-done-80'))).toBe(true);
    expect(showsIdleBox(pane('real-trust-80'))).toBe(false);
  });
});

describe('wrapped text (F2, F4)', () => {
  const RULE80 = '─'.repeat(80);
  it('joins a wrapped question line', () => {
    const p = [
      RULE80,
      ' Do you want to make this edit to a/very/long/path/that/goes/on/and/on/for/quite/',
      ' a/while/file.ts?',
      ' ❯ 1. Yes',
      '   2. No',
      '',
      ' Esc to cancel',
    ].join('\n');
    expect(parsePermissionPrompt(p)?.text).toBe(
      'Do you want to make this edit to a/very/long/path/that/goes/on/and/on/for/quite/ a/while/file.ts?',
    );
  });
  it('keeps short description lines under an option apart from its label', () => {
    const p = [
      RULE80,
      ' Which one?',
      ' ❯ 1. Dash',
      '      Turn spaces into dashes.',
      '   2. Underscore',
      '      Keep the underscores.',
      ' Enter to select · Esc to cancel',
    ].join('\n');
    expect(parsePermissionPrompt(p)).toEqual({
      text: 'Which one?',
      options: ['Dash', 'Underscore'],
    });
  });
  it('finds the trust screen when a long path wraps over many lines', () => {
    const path = Array.from({ length: 12 }, (_, i) => ` /home/dev/projects/segment-${i}/`).join(
      '\n',
    );
    const p = ` Accessing workspace:\n\n${path}\n\n Quick safety check: Is this a project you created or one you\n trust? (Like your own code, a well-known open source project, or work from\n your team). If not, take a moment to review what's in this folder first.\n\n Claude Code'll be able to read, edit, and execute files here.\n\n Security guide\n\n ❯ No, exit\n   Yes, I trust this folder\n\n Enter to confirm · Esc to cancel\n`;
    expect(parseStartupScreen(p)?.text).toBe('Trust this folder?');
  });
  it('finds the trust screen by its short lines when the question wraps mid-phrase', () => {
    const p =
      ' Accessing workspace:\n\n /home/dev/x\n\n Quick safety check: Is this a\n project you created or one you\n trust?\n\n ❯ No, exit\n   Yes, I trust this folder\n\n Enter to confirm · Esc to cancel\n';
    expect(parseStartupScreen(p)?.text).toBe('Trust this folder?');
  });
  it('bounds a prompt: question 500 characters, 10 options of 200, no control characters', () => {
    const opts = Array.from({ length: 12 }, (_, i) => `   ${i + 1}. ${'o'.repeat(300)}\x07`);
    const p = [`${'q'.repeat(700)}?`, ...opts, ' Esc to cancel'].join('\n');
    const q = parsePermissionPrompt(p);
    expect(q?.text).toHaveLength(500);
    expect(q?.options).toHaveLength(10);
    for (const o of q?.options ?? []) {
      expect(o.length).toBeLessThanOrEqual(200);
      expect(o).not.toContain('\x07');
    }
  });
});

describe('showsPrompt', () => {
  it('is true for permission, question and startup screens', () => {
    expect(showsPrompt(pane('permission-bash'))).toBe(true);
    expect(showsPrompt(pane('permission-edit'))).toBe(true);
    expect(showsPrompt(pane('ask-question'))).toBe(true);
    expect(
      showsPrompt(' Try the new fullscreen renderer?\n ❯ 1. Yes, try it\n   2. Not now\n'),
    ).toBe(true);
  });
  it('is false otherwise', () => {
    expect(showsPrompt(pane('after-exit'))).toBe(false);
    expect(showsPrompt('')).toBe(false);
  });
});

/** The pane after No or Esc on a prompt, as the spec records it (§1, "Denial, cancel and failure"). */
const RULE = '─'.repeat(60);
const DENIED = [
  '● Bash(npm run clean)',
  '  ⎿  Interrupted · What should Claude do instead?',
  '',
  RULE,
  '❯ ',
  RULE,
  '  ? for shortcuts',
  '',
].join('\n');
/** The pane right after Yes: the tool runs and no hook has fired yet. */
const APPROVED = ['● Bash(npm run clean)', '  ⎿  Running…', '', RULE, '❯ ', RULE, ''].join('\n');

describe('showsDenial', () => {
  it('is true when the denial line sits at the bottom, above the input box', () => {
    expect(showsDenial(DENIED)).toBe(true);
  });
  it('is false for a running tool, a prompt, an exited pane or an empty one', () => {
    expect(showsDenial(APPROVED)).toBe(false);
    expect(showsDenial(pane('permission-bash'))).toBe(false);
    expect(showsDenial(pane('after-exit'))).toBe(false);
    expect(showsDenial('')).toBe(false);
  });
  it('ignores an old denial further up the scrollback', () => {
    const later = Array.from({ length: 12 }, (_, i) => `  ⎿  line ${i + 1}`).join('\n');
    expect(showsDenial(`${DENIED}\n● Bash(npm test)\n${later}\n${APPROVED}`)).toBe(false);
  });
});

describe('paneLines', () => {
  it('keeps the last max non-empty lines, as out lines', () => {
    expect(paneLines('a\n\nb  \n\x1b[31mc\x1b[0m\n\n\n', 2)).toEqual([
      { kind: 'out', text: 'b' },
      { kind: 'out', text: 'c' },
    ]);
  });
  it('drops the input box, its rules and the footer', () => {
    const rule = '─'.repeat(80);
    const p = `● Done.\n\n✻ Baked for 8s · done 4:28 PM\n\n${rule}\n❯ commit this   \n${rule}\n  ⏸ manual mode on · ? for shortcuts\n\n\n`;
    expect(paneLines(p, 10).map((l) => l.text)).toEqual([
      '● Done.',
      '✻ Baked for 8s · done 4:28 PM',
    ]);
  });
  it('keeps text after an exit and clips long lines to 200 characters', () => {
    const texts = paneLines(pane('after-exit'), 50).map((l) => l.text);
    expect(texts).toContain('Resume this session with:');
    expect(texts.at(-1)).toBe('dev@devbox:~/projects/demo$');
    expect(texts.some((t) => /^─+$/.test(t))).toBe(false);
    expect(paneLines('y'.repeat(500), 5)[0]?.text).toHaveLength(200);
  });
  it('strips control characters and keeps markup as text', () => {
    expect(paneLines('\x1b]0;t\x07<img onerror=x>\x00', 5)).toEqual([
      { kind: 'out', text: '<img onerror=x>' },
    ]);
  });
  it('returns [] for an empty pane', () => {
    expect(paneLines('', 5)).toEqual([]);
  });
});

describe('paneLines: bidi and format characters (R28)', () => {
  it('a pane line comes out without U+202E (and U+FEFF, U+2061)', () => {
    expect(paneLines('rm \u202Etxt.exe\uFEFF\nok\u2061\n', 5)).toEqual([
      { kind: 'out', text: 'rm txt.exe' },
      { kind: 'out', text: 'ok' },
    ]);
  });
});
