import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DisplayLine } from '@kage/shared';
import { describe, expect, it } from 'vitest';
import { interrupted, nowLine, questionFrom, toDisplayLines } from './lines.ts';

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
