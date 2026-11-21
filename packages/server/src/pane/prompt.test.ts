import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  paneLines,
  parsePermissionPrompt,
  parseStartupScreen,
  showsPrompt,
  stripAnsi,
} from './prompt.ts';

const pane = (name: string): string =>
  readFileSync(join(import.meta.dirname, '../../test/fixtures/panes', `${name}.txt`), 'utf8');

describe('stripAnsi', () => {
  it('removes CSI colour codes and cursor moves', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m \x1b[2K\x1b[1;5Hhere\x1b[?25l')).toBe('red here');
  });
  it('removes OSC sequences with BEL and ST terminators, including OSC 8 hyperlinks', () => {
    expect(stripAnsi('\x1b]0;title\x07text')).toBe('text');
    expect(stripAnsi('\x1b]8;;https://x.test\x1b\\link\x1b]8;;\x1b\\ok')).toBe('linkok');
    expect(stripAnsi('\x1b]8;;https://x.test\x07link\x1b]8;;\x07!')).toBe('link!');
  });
  it('removes C0 control characters except tab', () => {
    expect(stripAnsi('a\x00b\x07c\x08d\re\tf\x7fg')).toBe('abcde\tfg');
  });
  it('removes other two-character escapes', () => {
    expect(stripAnsi('a\x1b7b\x1b(Bc\x1bcd')).toBe('abcd');
  });
  it('keeps hostile markup as plain text', () => {
    expect(stripAnsi('<img src=x onerror=alert(1)>')).toBe('<img src=x onerror=alert(1)>');
  });
});

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
