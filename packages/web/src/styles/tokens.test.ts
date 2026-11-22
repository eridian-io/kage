import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (name: string) => readFileSync(join(import.meta.dirname, name), 'utf8');
const tokens = read('tokens.css');
const board = read('board.css');

// Spec §6.2.
const TOKENS: Record<string, string> = {
  '--bg': '#0f1114',
  '--line': '#1b1e23',
  '--line-strong': '#2a2f37',
  '--fg': '#c9ced6',
  '--fg-strong': '#eef0f3',
  '--fg-2': '#8a919c',
  '--fg-3': '#5f6672',
  '--lime': '#cdf35a',
  '--amber': '#d9a650',
  '--red': '#e08a8a',
  '--add': '#9cc59f',
  '--del': '#c98d8d',
};

// Every hex literal board.css may use. Each one is a deliberate choice copied from the design
// target (docs/design/kage-board.html) and is not equal to any token.
const ALLOWED_LITERALS: Record<string, string> = {
  '#f2b544': 'needs-you status dot (target page --amber, brighter than the text token)',
  '#5d6573': 'done status dot (target page --grey)',
  '#565d68': 'session time, meta line, worktree path, empty-state text (dimmer than --fg-3)',
  '#6f7681': 'tool lines in the transcript',
  '#9aa1ac': 'transcript body text, changed-file paths',
  '#aeb4be': 'session row text, confirm text, toast text',
  '#d4d8de': 'button text, assistant lines, option buttons',
  '#23272e': 'port card and follow-up field outline',
  '#353b45': 'follow-up field outline on hover',
  '#2f343c': 'toast outline',
  '#4a515c': 'button outline on hover',
  '#14171b': 'action button background',
  '#181b20': 'action button background on hover',
  '#15181c': 'session row hover background',
  '#1a1d22': 'selected session row background',
  '#20242a': 'host pill outline and toast background',
  '#fff': 'action button text on hover',
  '#1a0d0d': 'text on the solid red Delete button',
  '#eb9a9a': 'solid red Delete button on hover',
};

describe('tokens.css', () => {
  for (const [name, value] of Object.entries(TOKENS)) {
    it(`defines ${name}: ${value}`, () => {
      expect(tokens).toMatch(new RegExp(`${name}: *${value};`));
    });
  }
  it('defines the font stacks', () => {
    expect(tokens).toMatch(/--sans:\s*"Geist"/);
    expect(tokens).toMatch(/--mono:\s*"Geist Mono"/);
  });
});

describe('board.css', () => {
  const hexes = [...new Set(board.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [])].map((h) => h.toLowerCase());
  it('uses no hex colour outside the allow-list', () => {
    expect(hexes.filter((h) => !(h in ALLOWED_LITERALS))).toEqual([]);
  });
  it('allow-lists nothing it does not use, and nothing that is a token', () => {
    expect(Object.keys(ALLOWED_LITERALS).filter((h) => !hexes.includes(h))).toEqual([]);
    expect(Object.keys(ALLOWED_LITERALS).filter((h) => Object.values(TOKENS).includes(h))).toEqual(
      [],
    );
  });
  it('has a visible focus style and no v1- prefix', () => {
    expect(board).toContain(':focus-visible');
    expect(board).not.toMatch(/\.v1/);
  });
  it('keeps a focus ring on every all:unset control', () => {
    for (const sel of ['.k-new', '.k-act', '.k-opts button', '.k-arch > .k-g', '.k-restore']) {
      expect(board).toContain(`${sel}:focus-visible`);
    }
    expect(board.match(/all: unset/g)?.length).toBe(5);
  });
  it('self-hosts Geist', () => {
    for (const f of [
      'geist-latin-400-normal',
      'geist-latin-500-normal',
      'geist-latin-600-normal',
      'geist-latin-700-normal',
      'geist-mono-latin-400-normal',
      'geist-mono-latin-500-normal',
    ]) {
      expect(board).toContain(`/fonts/${f}.woff2`);
    }
  });
});
