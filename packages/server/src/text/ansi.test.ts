import { describe, expect, it } from 'vitest';
import { stripAnsi } from './ansi.ts';
import { plainLine } from './bounds.ts';

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
  it('drops a lone trailing ESC and C1 controls', () => {
    expect(stripAnsi('ab\x1b')).toBe('ab');
    expect(stripAnsi('a\x80b\x9bc\x9fd\u00a0e')).toBe('abcd\u00a0e');
  });
  it('keeps hostile markup as plain text', () => {
    expect(stripAnsi('<img src=x onerror=alert(1)>')).toBe('<img src=x onerror=alert(1)>');
  });
});

describe('plainLine: bidi and format characters (Trojan Source)', () => {
  const FORMAT = [
    '\u200b',
    '\u200c',
    '\u200d',
    '\u200e',
    '\u200f',
    '\u202a',
    '\u202b',
    '\u202c',
    '\u202d',
    '\u202e',
    '\u2066',
    '\u2067',
    '\u2068',
    '\u2069',
    '\u2028',
    '\u2029',
  ];
  it('strips each of U+200B–U+200F, U+202A–U+202E, U+2066–U+2069, U+2028 and U+2029', () => {
    for (const c of FORMAT) expect(plainLine(`a${c}b`, 50)).toBe('ab');
  });
  it('keeps other non-ASCII text (no-break space, emoji, accents, RTL letters)', () => {
    expect(plainLine('café \u00a0\u{1f600} שלום', 50)).toBe('café \u00a0\u{1f600} שלום');
  });
  it('strips them after the escape sequences: no escape fragment survives', () => {
    expect(plainLine('\x1b[31m\u202eevil\u202c\x1b[0m', 50)).toBe('evil');
    expect(plainLine('a\x1b]8;;https://x.test/\u2066\x07link\x1b]8;;\x07b', 50)).toBe('alinkb');
  });
  it('cuts after stripping: a long escape sequence does not eat the visible text', () => {
    const link = `\x1b]8;;https://x.test/${'p'.repeat(1000)}\x07`;
    expect(plainLine(`${link}visible\x1b]8;;\x07`, 50)).toBe('visible');
    expect(plainLine(`${'\u200b'.repeat(300)}visible`, 50)).toBe('visible');
  });
  it('clips to max after stripping, ending with …', () => {
    expect(plainLine(`\x1b[1m${'x'.repeat(60)}`, 10)).toBe(`${'x'.repeat(9)}…`);
  });
});

describe('stripAnsi: bidi and format characters (R28)', () => {
  it('strips them always, and keeps line feeds unless oneLine', () => {
    for (const c of [
      '\u061C',
      '\u180E',
      '\u2060',
      '\u2061',
      '\u2062',
      '\u2063',
      '\u2064',
      '\uFEFF',
      '\u202E',
      '\u200B',
    ]) {
      expect(stripAnsi(`a${c}b`)).toBe('ab');
      expect(plainLine(`a${c}b`, 10)).toBe('ab');
    }
    expect(stripAnsi('a\u202E\nb', { oneLine: true })).toBe('a b');
  });
});
