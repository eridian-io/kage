/** Plain text from terminal output: shared by pane captures and transcripts. */

const ESC = 0x1b;
const BEL = 0x07;
const LF = 0x0a;

/**
 * Unicode bidi controls and invisible format characters that can make text read differently
 * from what it is (Trojan Source): U+061C, U+180E, U+200B–U+200F, U+202A–U+202E,
 * U+2060–U+2064, U+2066–U+2069, U+FEFF, and the line and paragraph separators U+2028 and U+2029.
 */
export function isFormatChar(c: number): boolean {
  return (
    c === 0x061c ||
    c === 0x180e ||
    (c >= 0x200b && c <= 0x200f) ||
    (c >= 0x202a && c <= 0x202e) ||
    (c >= 0x2060 && c <= 0x2064) ||
    (c >= 0x2066 && c <= 0x2069) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0xfeff
  );
}

export interface StripOptions {
  /** One line: a line feed becomes a space (otherwise it is dropped like other controls). */
  oneLine?: boolean;
  /** Stop once the output has this many characters (bounds the work on huge input). */
  limit?: number;
}

/**
 * Removes terminal escape sequences (CSI, OSC including OSC 8 links, others), control
 * characters other than tab, and bidi and format characters (R28: every displayed text path).
 * The character filter runs after the escape parsing, so a format character can neither hide an
 * escape sequence nor be left over from one. With `oneLine`, line feeds become spaces.
 */
export function stripAnsi(text: string, opts: StripOptions = {}): string {
  const oneLine = opts.oneLine === true;
  const limit = opts.limit ?? Number.POSITIVE_INFINITY;
  let out = '';
  let i = 0;
  while (i < text.length && out.length < limit) {
    const c = text.charCodeAt(i);
    const next = text[i + 1];
    if (c === ESC && next === '[') {
      // CSI: parameter and intermediate bytes, then one final byte in @–~.
      i += 2;
      while (i < text.length && (text.charCodeAt(i) < 0x40 || text.charCodeAt(i) > 0x7e)) i++;
      i++;
    } else if (c === ESC && (next === ']' || next === 'P' || next === '_' || next === '^')) {
      // OSC, DCS, APC, PM: up to BEL or ESC \.
      i += 2;
      while (i < text.length && text.charCodeAt(i) !== BEL && text.charCodeAt(i) !== ESC) i++;
      if (text.charCodeAt(i) === ESC && text[i + 1] === '\\') i += 2;
      else if (text.charCodeAt(i) === BEL) i++;
    } else if (c === ESC) {
      // Other escapes: intermediate bytes (space to /), then one final byte.
      i++;
      while (i < text.length && text.charCodeAt(i) >= 0x20 && text.charCodeAt(i) <= 0x2f) i++;
      i++;
    } else {
      if (oneLine && c === LF) out += ' ';
      else if (isFormatChar(c)) {
        // dropped
      } else if (c === 0x09 || (c >= 0x20 && c < 0x7f) || c > 0x9f) out += text[i];
      i++;
    }
  }
  return out;
}
