import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DisplayLine } from '@kage/shared';
import { describe, expect, it } from 'vitest';
import { endsTurn, interrupted, nowLine, questionFrom, toDisplayLines } from './lines.ts';

const FIXTURES = join(import.meta.dirname, '../../test/fixtures/transcripts');

/** Parsed records of a fixture; a line that doesn't parse (noise's partial tail) is left out. */
function records(file: string): unknown[] {
  const out: unknown[] = [];
  for (const line of readFileSync(join(FIXTURES, file), 'utf8').split('\n')) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

const CWD = '/home/dev/projects/demo';
const assistant = (block: unknown, cwd = CWD) => ({
  type: 'assistant',
  cwd,
  message: { role: 'assistant', content: [block] },
});
const toolUse = (name: string, input: unknown, cwd = CWD) =>
  assistant({ type: 'tool_use', id: 'toolu_x', name, input }, cwd);
const toolResult = (content: unknown, extra: Record<string, unknown> = {}) => ({
  type: 'user',
  cwd: CWD,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content }] },
  ...extra,
});

describe('toDisplayLines', () => {
  it('edit-and-test.jsonl → prompt, say, Read, Update with its diff, Bash with PASS output, thinking, say', () => {
    const lines = records('edit-and-test.jsonl').flatMap(toDisplayLines);
    expect(lines).toEqual<DisplayLine[]>([
      { kind: 'say', text: '> Make slug() use dashes, then run the tests' },
      { kind: 'say', text: "I'll switch the separator and run the tests." },
      { kind: 'tool', text: 'Read', detail: 'src/slug.js' },
      { kind: 'tool', text: 'Update', detail: 'src/slug.js' },
      { kind: 'del', text: "  return text.toLowerCase().replace(/ /g, '_');" },
      { kind: 'add', text: "  return text.toLowerCase().replace(/ /g, '-');" },
      { kind: 'tool', text: 'Bash', detail: 'npm test' },
      { kind: 'out', text: 'PASS test/slug.test.js' },
      { kind: 'out', text: 'Tests: 3 passed, 3 total' },
      { kind: 'think', text: 'Thinking…' },
      { kind: 'say', text: 'slug() now uses dashes, and all 3 tests pass.' },
    ]);
  });

  it('noise.jsonl → no throw; ignored records, meta and local-command records give nothing', () => {
    const recs = records('noise.jsonl');
    const lines = recs.flatMap(toDisplayLines);
    expect(lines).toEqual<DisplayLine[]>([
      { kind: 'say', text: '> Show me what is in missing.txt' },
      { kind: 'tool', text: 'Bash', detail: 'cat missing.txt' },
      { kind: 'out', text: 'Exit code 1' },
      { kind: 'out', text: 'cat: missing.txt: No such file or directory' },
    ]);
  });

  it('denied.jsonl → the rejected tool gives a single Denied line', () => {
    const lines = records('denied.jsonl').flatMap(toDisplayLines);
    expect(lines).toEqual<DisplayLine[]>([
      { kind: 'say', text: '> Delete the build folder' },
      { kind: 'tool', text: 'Bash', detail: 'rm -rf build' },
      { kind: 'out', text: 'Denied' },
    ]);
  });

  it('gives [] for anything it does not know', () => {
    for (const r of [
      null,
      undefined,
      42,
      'x',
      [],
      {},
      {
        type: 'api-request-blob',
        message: { role: 'user', content: [{ type: 'text', text: 'x' }] },
      },
      { type: 'attachment', message: { role: 'user', content: 'hello' } },
      { type: 'cost-state' },
      { type: 'system', subtype: 'stop_hook_summary' },
      { type: 'system', subtype: 'turn_duration', durationMs: 1 },
      { type: 'assistant', message: { content: [{ type: 'mystery_block', x: 1 }] } },
      { type: 'assistant', message: { content: 'not an array' } },
      { type: 'assistant', message: null },
      { type: 'assistant' },
      { type: 'user', message: { content: [{ type: 'image' }] } },
      { type: 'user', isMeta: true, message: { content: 'meta text' } },
      { type: 'user', message: { content: '<command-name>/clear</command-name>' } },
      { type: 'user', message: { content: '<local-command-stdout>Bye!</local-command-stdout>' } },
      { type: 'user', message: { content: '<local-command-caveat>x</local-command-caveat>' } },
      assistant({ type: 'tool_use', name: 42, input: null }),
    ]) {
      expect(toDisplayLines(r), JSON.stringify(r)).toEqual([]);
    }
  });

  it('names tools: Write → Write with a relative path; Grep/Glob → pattern; others → name only', () => {
    expect(toDisplayLines(toolUse('Write', { file_path: `${CWD}/a/b.ts`, content: 'x' }))).toEqual([
      { kind: 'tool', text: 'Write', detail: 'a/b.ts' },
    ]);
    expect(toDisplayLines(toolUse('Grep', { pattern: 'TODO\\b' }))).toEqual([
      { kind: 'tool', text: 'Grep', detail: 'TODO\\b' },
    ]);
    expect(toDisplayLines(toolUse('Glob', { pattern: '**/*.ts' }))).toEqual([
      { kind: 'tool', text: 'Glob', detail: '**/*.ts' },
    ]);
    expect(toDisplayLines(toolUse('WebFetch', { url: 'https://example.com' }))).toEqual([
      { kind: 'tool', text: 'WebFetch' },
    ]);
  });

  it('keeps a path outside cwd absolute, and does not treat a sibling prefix as inside', () => {
    expect(toDisplayLines(toolUse('Read', { file_path: '/etc/hosts' }))).toEqual([
      { kind: 'tool', text: 'Read', detail: '/etc/hosts' },
    ]);
    expect(toDisplayLines(toolUse('Read', { file_path: `${CWD}-other/x.ts` }))).toEqual([
      { kind: 'tool', text: 'Read', detail: `${CWD}-other/x.ts` },
    ]);
    expect(toDisplayLines(toolUse('Edit', { file_path: `${CWD}/x.ts` }, `${CWD}/`))).toEqual([
      { kind: 'tool', text: 'Update', detail: 'x.ts' },
    ]);
  });

  it('takes at most 12 diff lines per edit, skipping context lines', () => {
    const lines: string[] = [' context'];
    for (let i = 0; i < 10; i++) lines.push(`-old ${i}`, `+new ${i}`);
    const r = toolResult('The file x has been updated successfully.', {
      toolUseResult: {
        structuredPatch: [{ lines: lines.slice(0, 11) }, { lines: lines.slice(11) }],
      },
    });
    const out = toDisplayLines(r);
    expect(out).toHaveLength(12);
    expect(out[0]).toEqual({ kind: 'del', text: 'old 0' });
    expect(out[1]).toEqual({ kind: 'add', text: 'new 0' });
    expect(out.every((l) => l.kind === 'add' || l.kind === 'del')).toBe(true);
  });

  it('a 5 MB tool result gives at most 3 out lines of at most 200 characters', () => {
    const big = `${'x'.repeat(5 * 1024 * 1024)}\n${'line\n'.repeat(1000)}`;
    const out = toDisplayLines(toolResult(big));
    expect(out.length).toBeLessThanOrEqual(3);
    expect(out.length).toBeGreaterThan(0);
    for (const l of out) {
      expect(l.kind).toBe('out');
      expect(l.text.length).toBeLessThanOrEqual(200);
    }
  });

  it('reads text blocks in an array tool_result content, and skips blank lines', () => {
    const out = toDisplayLines(
      toolResult([
        { type: 'text', text: '\n\nfirst\n\n' },
        { type: 'image', source: {} },
        { type: 'text', text: 'second\nthird\nfourth' },
      ]),
    );
    expect(out).toEqual([
      { kind: 'out', text: 'first' },
      { kind: 'out', text: 'second' },
      { kind: 'out', text: 'third' },
    ]);
  });

  it('strips terminal colour codes from tool output', () => {
    expect(toDisplayLines(toolResult('\u001b[32mPASS\u001b[0m ok'))).toEqual([
      { kind: 'out', text: 'PASS ok' },
    ]);
    expect(toDisplayLines(toolResult('\u001b]0;title\u0007done\u0000\r'))).toEqual([
      { kind: 'out', text: 'done' },
    ]);
  });

  it('passes markup through as plain text', () => {
    const html = '<img src=x onerror=alert(1)>';
    expect(toDisplayLines(assistant({ type: 'text', text: html }))).toEqual([
      { kind: 'say', text: html },
    ]);
    expect(toDisplayLines(toolResult(html))).toEqual([{ kind: 'out', text: html }]);
  });

  it('clips say text to 2000 characters without splitting a surrogate pair', () => {
    const long = `${'a'.repeat(1998)}😀tail`;
    const [line] = toDisplayLines(assistant({ type: 'text', text: long }));
    expect(line?.text).toBe(`${'a'.repeat(1998)}…`);
    expect(line?.text.length).toBeLessThanOrEqual(2000);
    const [prompt] = toDisplayLines({ type: 'user', message: { content: 'b'.repeat(5000) } });
    expect(prompt?.text.length).toBe(2000);
  });

  it('strips escape sequences and control characters from say, diff and detail text', () => {
    expect(
      toDisplayLines(
        assistant({ type: 'text', text: '\u001b[1mBold\u001b[0m\u0007 line\nnext\r' }),
      ),
    ).toEqual([{ kind: 'say', text: 'Bold line\nnext' }]);
    expect(
      toDisplayLines({ type: 'user', message: { content: 'hi\u001b]0;x\u0007 there' } }),
    ).toEqual([{ kind: 'say', text: '> hi there' }]);
    expect(toDisplayLines(toolUse('Bash', { command: 'echo \u001b[31mred\u001b[0m\nls' }))).toEqual(
      [{ kind: 'tool', text: 'Bash', detail: 'echo red ls' }],
    );
    expect(toDisplayLines(toolUse('Read', { file_path: `${CWD}/a\u0000b.ts` }))).toEqual([
      { kind: 'tool', text: 'Read', detail: 'ab.ts' },
    ]);
    expect(
      toDisplayLines(
        toolResult('ok', {
          toolUseResult: { structuredPatch: [{ lines: ['-\u001b[2Kold', '+\tnew\u0008'] }] },
        }),
      ),
    ).toEqual([
      { kind: 'del', text: 'old' },
      { kind: 'add', text: '\tnew' },
    ]);
  });

  it('emits one think line per thinking block, never two in a row within a record', () => {
    const r = {
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: '' },
          { type: 'thinking', thinking: '' },
        ],
      },
    };
    expect(toDisplayLines(r)).toEqual([{ kind: 'think', text: 'Thinking…' }]);
  });
});

describe('questionFrom', () => {
  it('ask-question.jsonl → the question and both options in order', () => {
    const qs = records('ask-question.jsonl').map(questionFrom);
    expect(qs.filter(Boolean)).toEqual([
      { text: 'Which separator should slug() use?', options: ['Dash', 'Underscore'] },
    ]);
  });

  it('is null for other records and malformed input', () => {
    for (const r of [
      ...records('edit-and-test.jsonl'),
      null,
      toolUse('AskUserQuestion', {}),
      toolUse('AskUserQuestion', { questions: [] }),
      toolUse('AskUserQuestion', { questions: [{ question: 7 }] }),
    ]) {
      expect(questionFrom(r)).toBeNull();
    }
  });

  it('skips options without a string label', () => {
    expect(
      questionFrom(
        toolUse('AskUserQuestion', {
          questions: [{ question: 'Q?', options: [{ label: 'A' }, { x: 1 }, { label: 'B' }] }],
        }),
      ),
    ).toEqual({ text: 'Q?', options: ['A', 'B'] });
  });
});

describe('nowLine', () => {
  it('Bash → Running <first 60 chars of the command>', () => {
    expect(nowLine(toolUse('Bash', { command: 'npm test' }))).toBe('Running npm test');
    expect(nowLine(toolUse('Bash', { command: 'a'.repeat(100) }))).toBe(
      `Running ${'a'.repeat(60)}`,
    );
  });

  it('Edit/Write → Editing, Read → Reading, Grep/Glob → Searching, AskUserQuestion, thinking', () => {
    expect(nowLine(toolUse('Edit', { file_path: `${CWD}/src/a.ts` }))).toBe('Editing src/a.ts');
    expect(nowLine(toolUse('Write', { file_path: `${CWD}/b.ts` }))).toBe('Editing b.ts');
    expect(nowLine(toolUse('Read', { file_path: `${CWD}/c.ts` }))).toBe('Reading c.ts');
    expect(nowLine(toolUse('Grep', { pattern: 'foo' }))).toBe('Searching foo');
    expect(nowLine(toolUse('Glob', { pattern: '*.ts' }))).toBe('Searching *.ts');
    expect(nowLine(toolUse('AskUserQuestion', { questions: [] }))).toBe('Asking a question');
    expect(nowLine(assistant({ type: 'thinking', thinking: '' }))).toBe('Thinking');
  });

  it('is null for turn_duration and for records that say nothing about activity', () => {
    expect(nowLine({ type: 'system', subtype: 'turn_duration' })).toBeNull();
    expect(nowLine(assistant({ type: 'text', text: 'hi' }))).toBeNull();
    expect(nowLine(null)).toBeNull();
  });
});

describe('interrupted (R11)', () => {
  it('is true for the user-rejected tool_result and the interrupt text in denied.jsonl', () => {
    expect(records('denied.jsonl').map(interrupted)).toEqual([false, false, true, true]);
  });

  it('is true for a plain "[Request interrupted by user]" string prompt; false otherwise', () => {
    expect(
      interrupted({ type: 'user', message: { content: '[Request interrupted by user]' } }),
    ).toBe(true);
    expect(records('edit-and-test.jsonl').some(interrupted)).toBe(false);
    expect(records('noise.jsonl').some(interrupted)).toBe(false);
    expect(interrupted(null)).toBe(false);
  });
});

describe('endsTurn', () => {
  it('turn_duration, stop_hook_summary and an end_turn assistant record end the turn', () => {
    expect(endsTurn({ type: 'system', subtype: 'turn_duration' })).toBe(true);
    expect(endsTurn({ type: 'system', subtype: 'stop_hook_summary' })).toBe(true);
    expect(
      endsTurn({
        type: 'assistant',
        message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] },
      }),
    ).toBe(true);
  });
  it('a tool_use assistant record, other system records and junk do not', () => {
    expect(endsTurn({ type: 'assistant', message: { stop_reason: 'tool_use', content: [] } })).toBe(
      false,
    );
    expect(endsTurn({ type: 'assistant', message: { stop_reason: null, content: [] } })).toBe(
      false,
    );
    expect(endsTurn({ type: 'system', subtype: 'informational' })).toBe(false);
    expect(endsTurn(null)).toBe(false);
  });
});

describe('real-short-turn.jsonl (2.1.330, R23)', () => {
  it('reads the prompt, Read, Update with its diff and the reply', () => {
    expect(records('real-short-turn.jsonl').flatMap(toDisplayLines)).toEqual([
      {
        kind: 'say',
        text: '> Use the Edit tool to change the line bravo to BRAVO in notes.txt. Do nothing else and reply with one short sentence.',
      },
      { kind: 'think', text: 'Thinking…' },
      { kind: 'tool', text: 'Read', detail: 'notes.txt' },
      { kind: 'tool', text: 'Update', detail: 'notes.txt' },
      { kind: 'del', text: 'bravo' },
      { kind: 'add', text: 'BRAVO' },
      { kind: 'say', text: 'I changed `bravo` to `BRAVO` in `notes.txt`.' },
    ]);
  });
  it('the reply (end_turn), stop_hook_summary and turn_duration each end the turn', () => {
    const ends = records('real-short-turn.jsonl').filter(endsTurn) as {
      type: string;
      subtype?: string;
    }[];
    expect(ends.map((r) => r.subtype ?? r.type)).toEqual([
      'assistant',
      'stop_hook_summary',
      'turn_duration',
    ]);
  });
});

describe('bounds (review minor)', () => {
  it('questionFrom: 500-character text, at most 10 options of 200, plain text', () => {
    const q = questionFrom(
      assistant({
        type: 'tool_use',
        id: 't',
        name: 'AskUserQuestion',
        input: {
          questions: [
            {
              question: `${'q'.repeat(700)}\x1b[31m`,
              options: Array.from({ length: 12 }, () => ({ label: `${'o'.repeat(300)}\x07` })),
            },
          ],
        },
      }),
    );
    expect(q?.text).toHaveLength(500);
    expect(q?.options).toHaveLength(10);
    expect(q?.options.every((o) => o.length <= 200 && !o.includes('\x07'))).toBe(true);
  });
  it('nowLine: paths and commands are plain text and clipped', () => {
    expect(nowLine(toolUse('Bash', { command: 'echo \x1b[31mred\x07\nnext' }))).toBe(
      'Running echo red next',
    );
    const now = nowLine(toolUse('Read', { file_path: `${CWD}/${'d/'.repeat(300)}x.ts` }));
    expect(now?.length).toBeLessThanOrEqual(208);
    expect(nowLine(toolUse('Read', { file_path: `${CWD}/a\x1b]0;t\x07b.ts` }))).toBe(
      'Reading ab.ts',
    );
  });
  it('plain text drops bidi and format characters, after the escape sequences', () => {
    expect(nowLine(toolUse('Bash', { command: 'rm \u202e\x1b[31mtxt.exe\u202c\u200b' }))).toBe(
      'Running rm txt.exe',
    );
    expect(nowLine(toolUse('Read', { file_path: `${CWD}/a\u2066\u2028b.ts` }))).toBe(
      'Reading ab.ts',
    );
    const link = `\x1b]8;;https://x.test/${'p'.repeat(1000)}\x07`;
    expect(nowLine(toolUse('Grep', { pattern: `${link}needle` }))).toBe('Searching needle');
  });
});

describe('bidi and format characters on every text path (R28)', () => {
  it('a say line, its line breaks kept, comes out without U+202E', () => {
    const lines = toDisplayLines(
      assistant({ type: 'text', text: 'safe \u202Etxt.exe\nnext \uFEFFline' }),
    );
    expect(lines).toEqual([{ kind: 'say', text: 'safe txt.exe\nnext line' }]);
  });
  it('tool out lines and diff lines come out without them', () => {
    expect(toDisplayLines(toolResult('ok\u202E\u2060 \u061Cdone\u180E'))).toEqual([
      { kind: 'out', text: 'ok done' },
    ]);
    expect(
      toDisplayLines(
        toolResult('ok', {
          toolUseResult: { structuredPatch: [{ lines: ['-a\u202Eb', '+c\u2064d'] }] },
        }),
      ),
    ).toEqual([
      { kind: 'del', text: 'ab' },
      { kind: 'add', text: 'cd' },
    ]);
  });
});
