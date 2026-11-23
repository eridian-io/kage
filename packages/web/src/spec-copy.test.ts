// @vitest-environment node
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the strings quote source text, ${…} and all
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The copy check (phase 5, Task 9): every sentence spec §6.6 and §6.7 collect is in the code, and
 * the server's error sentences keep the house style. A change of copy is a change in both places.
 */

const ROOT = join(import.meta.dirname, '../../..');
const SPEC = readFileSync(join(ROOT, 'docs/specs/2026-11-21-kage-design.md'), 'utf8');

/** The body of the spec section whose heading starts with `### <n> `, up to the next heading. */
function section(n: string): string {
  const start = SPEC.indexOf(`\n### ${n} `);
  if (start < 0) throw new Error(`spec has no section ${n}`);
  const end = SPEC.slice(start + 1).search(/\n#{2,3} /);
  return end < 0 ? SPEC.slice(start) : SPEC.slice(start, start + 1 + end);
}

/**
 * Every double-quoted sentence of a section, except a parenthesised history note that quotes
 * old copy ("It first read …").
 */
function quoted(body: string): string[] {
  const text = body.replace(/\(It first read [^)]*\)/g, '');
  return [...text.matchAll(/"([^"\n]+)"/g)].map((m) => m[1] as string);
}

/** Source files under packages/<pkg>/src, tests left out. */
function sources(): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (
        /\.tsx?$/.test(e.name) &&
        !/\.test\.tsx?$/.test(e.name) &&
        !e.name.endsWith('.d.ts')
      ) {
        out.push({ file: relative(ROOT, p).replaceAll('\\', '/'), text: readFileSync(p, 'utf8') });
      }
    }
  };
  for (const pkg of readdirSync(join(ROOT, 'packages'))) {
    try {
      walk(join(ROOT, 'packages', pkg, 'src'));
    } catch {
      // a package without src
    }
  }
  return out;
}

const SRC = sources();
/** All source text, with escaped quotes read as the characters they stand for. */
const CORPUS = SRC.map((s) => s.text)
  .join('\n')
  .replace(/\\(['"`])/g, '$1');
/**
 * The installer's sentences too (F10): install.sh at the repo root, with its shell escapes
 * (`\"`, `\$`) read as the characters they stand for.
 */
const INSTALL_SH = readFileSync(join(ROOT, 'install.sh'), 'utf8').replace(/\\(["$`\\])/g, '$1');

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * A spec sentence as a pattern over the source: `<…>` and `…` stand for text the code fills in
 * (an interpolation, a JSX expression, the next part of a split string), `N` for a number or
 * the expression that counts it.
 */
function pattern(sentence: string): RegExp {
  const hole = '[\\s\\S]{1,80}?';
  const parts = sentence.split(/(<[^>]+>|…|\bN\b)/);
  const src = parts
    .map((p) => (p === '…' || /^<[^>]+>$/.test(p) ? hole : p === 'N' ? `(?:\\d+|${hole})` : esc(p)))
    .join('');
  return new RegExp(src);
}

/**
 * Sentences the code builds from parts too far apart for one pattern (a shared prefix, JSX
 * around a path, a constant): each part must be in the code as written here.
 */
const ASSEMBLED: Record<string, string[]> = {
  // app.ts: action(…, "<fallback>", …) answers a 500 with `${failed}: ${firstLine(err)}`.
  "Kage couldn't change the session: …": [
    `"Kage couldn't change the session"`,
    '`${failed}: ${firstLine(err)}`',
  ],
  "Kage couldn't send that to the session: …": [
    `"Kage couldn't send that to the session"`,
    '`${failed}: ${firstLine(err)}`',
  ],
  "Removed the worktree, but git couldn't delete the branch: …": [
    '`Removed the worktree, but ${what}`',
    "`git couldn't delete the branch: ${firstLine(e)}`",
  ],
  'Delete this session? This removes the tmux window, the worktree <path> and the branch <branch>.':
    [
      '<b>Delete this session?</b>',
      "' This removes the tmux window, the worktree '",
      "' and the branch '",
      '<code>{s.branch}</code>.',
    ],
  "N more lines in this file aren't shown.": [
    'more ${f.clipped === 1 ? "line in this file isn\'t" : "lines in this file aren\'t"} shown.',
  ],
  "Kage's terminal speaks kage.term.v1.": [
    "`Kage's terminal speaks ${TERM_PROTOCOL}.`",
    "TERM_PROTOCOL = 'kage.term.v1'",
  ],
};

describe('spec §6.6 copy is in the code', () => {
  const sentences = quoted(section('6.6'));

  it('finds the sentences (the section is there)', () => {
    expect(sentences.length).toBeGreaterThan(40);
  });

  it('every sentence occurs in packages/*/src outside tests', () => {
    const missing = sentences.filter((s) => !(s in ASSEMBLED) && !pattern(s).test(CORPUS));
    expect(missing).toEqual([]);
  });

  it('every assembled sentence is still in the spec, and each of its parts is in the code', () => {
    for (const [sentence, parts] of Object.entries(ASSEMBLED)) {
      expect(sentences).toContain(sentence);
      for (const p of parts) expect(CORPUS, `${sentence} needs ${p}`).toContain(p);
    }
  });
});

describe('spec §6.7 copy (phase 5) is in the code', () => {
  it('every sentence occurs in packages/*/src outside tests', () => {
    const sentences = quoted(section('6.7'));
    expect(sentences.length).toBeGreaterThan(5);
    expect(sentences.filter((s) => !pattern(s).test(CORPUS))).toEqual([]);
  });
});

/**
 * §6.8's sentences: the straight-quoted ones as in §6.6, plus the curly-quoted ones, which may
 * hold straight double quotes (`“Run "kage serve" yourself.”`).
 */
function quoted68(body: string): string[] {
  const curly = [...body.matchAll(/“([^”\n]+)”/g)].map((m) => m[1] as string);
  const rest = body.replace(/“[^”\n]+”/g, '');
  return [...curly, ...quoted(rest)];
}

describe('spec §6.8 copy (phase 6) is in the code or install.sh', () => {
  const sentences = quoted68(section('6.8'));

  it('finds the sentences (the section is there), the curly-quoted ones too', () => {
    expect(sentences.length).toBeGreaterThan(150);
    expect(sentences).toContain(
      'launchctl isn\'t on PATH, so Kage can\'t install its service. Run "kage serve" yourself.',
    );
  });

  it('every sentence occurs in packages/*/src outside tests, or in install.sh', () => {
    const missing = sentences.filter(
      (s) => !pattern(s).test(CORPUS) && !pattern(s).test(INSTALL_SH),
    );
    expect(missing).toEqual([]);
  });

  it("install.sh's own sentences are in §6.8", () => {
    // Every message install.sh prints through die or say, as written, with $words as holes.
    const said = [
      ...INSTALL_SH.matchAll(/\b(?:die|say) (["'])(.+?)\1(?:\s*;|\s*$| &&| \|\|)/gm),
    ].map((m) => (m[2] as string).replace(/\$\{?\w+\}?/g, '<x>'));
    expect(said.length).toBeGreaterThan(15);
    const spec = sentences.map((s) => s.replace(/<[^>]+>/g, '<x>'));
    expect(said.filter((s) => !spec.includes(s))).toEqual([]);
  });
});

describe('spec §6.9 copy (hardening) is in the code or install.sh', () => {
  const sentences = quoted68(section('6.9'));

  it('finds the sentences (the section is there)', () => {
    expect(sentences.length).toBeGreaterThanOrEqual(1);
    expect(sentences).toContain('Sign out');
  });

  it('every sentence occurs in packages/*/src outside tests, or in install.sh', () => {
    const missing = sentences.filter(
      (s) => !pattern(s).test(CORPUS) && !pattern(s).test(INSTALL_SH),
    );
    expect(missing).toEqual([]);
  });
});

describe('the house style of error sentences', () => {
  const server = SRC.filter((s) => s.file.startsWith('packages/server/'));
  const web = SRC.filter((s) => s.file.startsWith('packages/web/'));
  /** A string literal's text: '…', "…" or `…` (an interpolation kept as written). */
  const LIT = String.raw`('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|\x60(?:[^\x60\\]|\\.)*\x60)`;
  const literals = (re: RegExp) =>
    server.flatMap(({ file, text }) =>
      [...text.matchAll(re)].map((m) => ({ file, text: (m[1] as string).slice(1, -1) })),
    );
  const sentences = [
    ...literals(new RegExp(String.raw`\{\s*error:\s*${LIT}\s*\}`, 'g')),
    ...literals(new RegExp(String.raw`ActionError\(\s*\d+\s*,\s*${LIT}`, 'g')),
  ];

  it('finds the server error literals', () => {
    expect(sentences.length).toBeGreaterThan(10);
  });

  it('server error sentences end in a full stop, with no "!" and no "Error:" prefix', () => {
    // "git couldn't show the diff: ${firstLine(e)}" ends in the tool's own line, quoted as it
    // came (§6.6 writes it "…"): only Kage's own words are held to the full stop.
    const quotesTool = (t: string) => /: \$\{[^}]+\}$/.test(t);
    const bad = sentences.filter(
      (s) =>
        (!/\.$/.test(s.text) && !quotesTool(s.text)) ||
        s.text.includes('!') ||
        /^Error:/i.test(s.text),
    );
    expect(bad).toEqual([]);
  });

  it('no web string starts with "Error"', () => {
    const bad = web.flatMap(({ file, text }) =>
      [...text.matchAll(new RegExp(LIT, 'g'))]
        .map((m) => (m[1] as string).slice(1))
        .filter((t) => /^Error\b/.test(t))
        .map((t) => `${file}: ${t}`),
    );
    expect(bad).toEqual([]);
  });
});
