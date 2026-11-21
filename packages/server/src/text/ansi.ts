/** Plain text from terminal output: shared by pane captures and transcripts. */

const ESC = 0x1b;
const BEL = 0x07;

/** Removes terminal escape sequences (CSI, OSC including OSC 8 links, others) and control characters other than tab. */
export function stripAnsi(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
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
      if (c === 0x09 || (c >= 0x20 && c < 0x7f) || c > 0x9f) out += text[i];
      i++;
    }
  }
  return out;
}
