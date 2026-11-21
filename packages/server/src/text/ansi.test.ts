import { describe, expect, it } from 'vitest';
import { stripAnsi } from './ansi.ts';

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
