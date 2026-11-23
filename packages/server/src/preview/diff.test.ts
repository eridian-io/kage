import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LIMITS } from '@kage/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gitStream, UNPINNED, UnpinnedError } from '../git/exec.ts';
import {
  DiffError,
  DiffService,
  diffPage,
  parseUnified,
  STILL_WORKING,
  untrackedDiff,
} from './diff.ts';
import { changedFiles } from './files.ts';

let root: string;
let home: string;
const saved: Record<string, string | undefined> = {};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', ...args], {
    cwd,
    stdio: 'pipe',
    encoding: 'utf8',
  });
}

/** A repo on main with a few files, and a branch `task` checked out. */
async function repo(name: string): Promise<string> {
  const dir = join(root, name);
  await mkdir(dir);
  git(dir, 'init', '-q', '-b', 'main');
  await writeFile(join(dir, 'a.txt'), 'one\ntwo\nthree\n');
  await writeFile(join(dir, 'b.txt'), 'alpha\nbeta\n');
  await writeFile(join(dir, 'old.txt'), 'keep\nthis\ncontent\nfor\nrename\ndetection\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  git(dir, 'checkout', '-q', '-b', 'task');
  return dir;
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'kage-diff-'));
  home = await mkdtemp(join(tmpdir(), 'kage-home-'));
  const env = {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    HOME: home,
    USERPROFILE: home,
  };
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
});
afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

const O = { maxLines: 1000, maxLineChars: 2000 };

describe('parseUnified', () => {
  it('reads a modified file with two hunks', () => {
    const text = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1111111..2222222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,3 +1,3 @@ function top()',
      ' one',
      '-two',
      '+TWO',
      ' three',
      '@@ -20,2 +20,3 @@',
      ' x',
      '+y',
      ' z',
      '',
    ].join('\n');
    expect(parseUnified(text, O)).toEqual([
      {
        path: 'src/a.ts',
        kind: 'modified',
        added: 2,
        removed: 1,
        clipped: 0,
        lines: [
          ['hunk', '@@ -1,3 +1,3 @@ function top()'],
          ['ctx', 'one'],
          ['del', 'two'],
          ['add', 'TWO'],
          ['ctx', 'three'],
          ['hunk', '@@ -20,2 +20,3 @@'],
          ['ctx', 'x'],
          ['add', 'y'],
          ['ctx', 'z'],
        ],
      },
    ]);
  });

  it('reads a new file, a deleted file, a rename with changes and a binary file', () => {
    const text = [
      'diff --git a/new.txt b/new.txt',
      'new file mode 100644',
      'index 0000000..3333333',
      '--- /dev/null',
      '+++ b/new.txt',
      '@@ -0,0 +1,2 @@',
      '+hello',
      '+world',
      '\\ No newline at end of file',
      'diff --git a/gone.txt b/gone.txt',
      'deleted file mode 100644',
      'index 4444444..0000000',
      '--- a/gone.txt',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-bye',
      'diff --git a/old name.txt b/new name.txt',
      'similarity index 80%',
      'rename from old name.txt',
      'rename to new name.txt',
      'index 5555555..6666666 100644',
      '--- a/old name.txt',
      '+++ b/new name.txt',
      '@@ -1,2 +1,2 @@',
      ' keep',
      '-was',
      '+is',
      'diff --git a/img.png b/img.png',
      'index 7777777..8888888 100644',
      'Binary files a/img.png and b/img.png differ',
      '',
    ].join('\n');
    const files = parseUnified(text, O);
    expect(files.map((f) => [f.path, f.oldPath, f.kind, f.added, f.removed])).toEqual([
      ['new.txt', undefined, 'added', 2, 0],
      ['gone.txt', undefined, 'deleted', 0, 1],
      ['new name.txt', 'old name.txt', 'renamed', 1, 1],
      ['img.png', undefined, 'binary', 0, 0],
    ]);
    expect(files[0]?.lines).toEqual([
      ['hunk', '@@ -0,0 +1,2 @@'],
      ['add', 'hello'],
      ['add', 'world'],
    ]);
    expect(files[3]?.lines).toEqual([]);
  });

  it('a type change (two sections for one path) becomes one file with both sides', () => {
    const text = [
      'diff --git a/b.txt b/b.txt',
      'deleted file mode 100644',
      '--- a/b.txt',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-alpha',
      '-beta',
      'diff --git a/b.txt b/b.txt',
      'new file mode 120000',
      '--- /dev/null',
      '+++ b/b.txt',
      '@@ -0,0 +1 @@',
      '+a.txt',
      '\\ No newline at end of file',
      '',
    ].join('\n');
    expect(parseUnified(text, O)).toEqual([
      {
        path: 'b.txt',
        kind: 'modified',
        added: 1,
        removed: 2,
        clipped: 0,
        lines: [
          ['hunk', '@@ -1,2 +0,0 @@'],
          ['del', 'alpha'],
          ['del', 'beta'],
          ['hunk', '@@ -0,0 +1 @@'],
          ['add', 'a.txt'],
        ],
      },
    ]);
  });

  it('a pure rename (no hunks) keeps both paths', () => {
    const text = [
      'diff --git a/x.txt b/y.txt',
      'similarity index 100%',
      'rename from x.txt',
      'rename to y.txt',
      '',
    ].join('\n');
    expect(parseUnified(text, O)).toEqual([
      {
        path: 'y.txt',
        oldPath: 'x.txt',
        kind: 'renamed',
        added: 0,
        removed: 0,
        lines: [],
        clipped: 0,
      },
    ]);
  });

  it('caps a file of 1,500 changed lines at maxLines and counts the rest as clipped', () => {
    const body = Array.from({ length: 1500 }, (_, i) => `+line ${i}`);
    const text = [
      'diff --git a/big.txt b/big.txt',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/big.txt',
      '@@ -0,0 +1,1500 @@',
      ...body,
      '',
    ].join('\n');
    const [f] = parseUnified(text, O);
    expect(f?.added).toBe(1500);
    expect(f?.clipped).toBe(500);
    expect(f?.lines.filter(([k]) => k === 'add')).toHaveLength(1000);
    expect(f?.lines[1]).toEqual(['add', 'line 0']);
    expect(f?.lines.at(-1)).toEqual(['add', 'line 999']);
  });

  it('clips a 5,000-character line to 2,000 characters plus …', () => {
    const text = [
      'diff --git a/min.js b/min.js',
      '--- a/min.js',
      '+++ b/min.js',
      '@@ -1 +1 @@',
      `+${'x'.repeat(5000)}`,
      '',
    ].join('\n');
    const [f] = parseUnified(text, O);
    expect(f?.lines[1]).toEqual(['add', `${'x'.repeat(2000)}…`]);
  });

  it('reads a path with spaces and a C-quoted path ("a\\tb", octal UTF-8)', () => {
    const text = [
      'diff --git a/my file.txt b/my file.txt',
      '--- a/my file.txt',
      '+++ b/my file.txt',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      'diff --git "a/a\\tb" "b/a\\tb"',
      'new file mode 100644',
      '--- /dev/null',
      '+++ "b/a\\tb"',
      '@@ -0,0 +1 @@',
      '+x',
      'diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"',
      'deleted file mode 100644',
      '--- "a/caf\\303\\251.txt"',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-y',
      '',
    ].join('\n');
    expect(parseUnified(text, O).map((f) => f.path)).toEqual(['my file.txt', 'a\tb', 'café.txt']);
  });

  it('strips terminal escapes, controls and bidi characters from every text field', () => {
    const text = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1 +1 @@ ‮evil',
      '-\u001b[31mred\u001b[0m\r',
      '+ok⁦\u0007',
      '',
    ].join('\n');
    expect(parseUnified(text, O)[0]?.lines).toEqual([
      ['hunk', '@@ -1 +1 @@ evil'],
      ['del', 'red'],
      ['add', 'ok'],
    ]);
  });

  it('a "--- " or "+++ " line inside a hunk is content, not a header', () => {
    const text = [
      'diff --git a/a.md b/a.md',
      '--- a/a.md',
      '+++ b/a.md',
      '@@ -1,2 +1,2 @@',
      '--- old rule',
      '+++ new rule',
      '',
    ].join('\n');
    expect(parseUnified(text, O)[0]?.lines).toEqual([
      ['hunk', '@@ -1,2 +1,2 @@'],
      ['del', '-- old rule'],
      ['add', '++ new rule'],
    ]);
  });
});

describe('untrackedDiff', () => {
  it('a 3-line file is one hunk of 3 add lines', async () => {
    const dir = await repo('u-three');
    await writeFile(join(dir, 'n.txt'), 'a\nb\nc\n');
    expect(await untrackedDiff(dir, 'n.txt', O)).toEqual({
      path: 'n.txt',
      kind: 'untracked',
      added: 3,
      removed: 0,
      clipped: 0,
      lines: [
        ['hunk', '@@ -0,0 +1,3 @@'],
        ['add', 'a'],
        ['add', 'b'],
        ['add', 'c'],
      ],
    });
  });

  it.skipIf(process.platform === 'win32')(
    'a symlink (to /etc/passwd) is kind link and never read',
    async () => {
      const dir = await repo('u-link');
      await symlink('/etc/passwd', join(dir, 'pw'));
      expect(await untrackedDiff(dir, 'pw', O)).toEqual({
        path: 'pw',
        kind: 'link',
        added: 0,
        removed: 0,
        clipped: 0,
        lines: [],
      });
    },
  );

  it('a 2 MiB file is binary with no lines (over the size cap); so is a file with a NUL', async () => {
    const dir = await repo('u-big');
    await writeFile(join(dir, 'big.txt'), 'a\n'.repeat(1024 * 1024));
    await writeFile(join(dir, 'nul.txt'), Buffer.from('a\nb\0c\n'));
    for (const p of ['big.txt', 'nul.txt']) {
      const f = await untrackedDiff(dir, p, O);
      expect([f.kind, f.lines, f.added]).toEqual(['binary', [], 0]);
    }
  });

  it('caps lines at maxLines and clips long lines', async () => {
    const dir = await repo('u-cap');
    await writeFile(join(dir, 'n.txt'), `${'y'.repeat(30)}\n${'z\n'.repeat(9)}`);
    const f = await untrackedDiff(dir, 'n.txt', { maxLines: 4, maxLineChars: 10 });
    expect(f.added).toBe(10);
    expect(f.clipped).toBe(6);
    expect(f.lines).toEqual([
      ['hunk', '@@ -0,0 +1,10 @@'],
      ['add', `${'y'.repeat(10)}…`],
      ['add', 'z'],
      ['add', 'z'],
      ['add', 'z'],
    ]);
  });
});

/** The temp repo of the brief: a commit on the branch, an uncommitted edit, a rename, an untracked file. */
async function mixed(name: string): Promise<string> {
  const dir = await repo(name);
  await writeFile(join(dir, 'a.txt'), 'one\ntwo\nthree\nfour\n');
  git(dir, 'commit', '-q', '-am', 'edit a');
  await writeFile(join(dir, 'b.txt'), 'alpha\ngamma\ndelta\n');
  git(dir, 'mv', 'old.txt', 'new.txt');
  await writeFile(join(dir, 'untracked.txt'), 'u1\nu2\n');
  return dir;
}

const target = (worktree: string, base: string | null = 'main') => ({
  worktree,
  base,
  branch: 'task',
});

describe('diffPage', () => {
  it('lists the same paths in the same order as changedFiles, with their diffs', async () => {
    const dir = await mixed('p-mixed');
    const page = await diffPage(target(dir), 0);
    const list = await changedFiles(dir, 'main');
    expect(page.files.map((f) => f.path)).toEqual(list.files.map((f) => f.path));
    expect(page).toMatchObject({
      base: 'main',
      branch: 'task',
      from: 0,
      next: null,
      filesTotal: 4,
    });
    const by = Object.fromEntries(page.files.map((f) => [f.path, f]));
    expect(by['a.txt']?.lines).toContainEqual(['add', 'four']);
    expect(by['b.txt']?.lines).toEqual(
      expect.arrayContaining([
        ['del', 'beta'],
        ['add', 'gamma'],
      ]),
    );
    expect(by['new.txt']).toMatchObject({ kind: 'renamed', oldPath: 'old.txt' });
    expect(by['untracked.txt']).toMatchObject({ kind: 'untracked', added: 2 });
  });

  it('from past the end is an empty page with next null', async () => {
    const dir = await mixed('p-end');
    const page = await diffPage(target(dir), 99);
    expect(page).toMatchObject({ from: 99, next: null, filesTotal: 4, files: [] });
  });

  it('30 files of 100 lines each page as 9, 9, 9 and 3 files', async () => {
    const dir = await repo('p-thirty');
    for (let i = 0; i < 30; i++) {
      const lines = Array.from({ length: 100 }, (_, j) => `f${i} line ${j}`).join('\n');
      await writeFile(join(dir, `f${String(i).padStart(2, '0')}.txt`), `${lines}\n`);
    }
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'thirty');
    const sizes: number[] = [];
    const nexts: (number | null)[] = [];
    let from: number | null = 0;
    while (from !== null) {
      const page = await diffPage(target(dir), from);
      sizes.push(page.files.length);
      nexts.push(page.next);
      expect(page.files.every((f) => f.lines.length === 101 && f.clipped === 0)).toBe(true);
      from = page.next;
    }
    expect(sizes).toEqual([9, 9, 9, 3]);
    expect(nexts).toEqual([9, 18, 27, null]);
  });

  it('never runs a textconv or external diff program the repo names (list and diff)', async () => {
    const dir = await repo('p-evil');
    const marker = join(root, `pwned-${Math.random().toString(36).slice(2)}`).replace(/\\/g, '/');
    await writeFile(join(dir, '.gitattributes'), '*.txt diff=evil\n');
    git(dir, 'add', '.gitattributes');
    git(dir, 'commit', '-q', '-m', 'attrs');
    git(dir, 'config', 'diff.evil.textconv', `touch ${marker}`);
    git(dir, 'config', 'diff.evil.command', `touch ${marker}`);
    await writeFile(join(dir, 'a.txt'), 'changed\n');
    const page = await diffPage(target(dir), 0);
    await changedFiles(dir, 'main');
    expect(page.files.map((f) => f.path)).toEqual(['.gitattributes', 'a.txt']);
    expect(existsSync(marker)).toBe(false);
    // The trap is live: a plain git diff runs it.
    git(dir, '-c', 'core.fsmonitor=false', 'diff', '--no-ext-diff', 'main');
    expect(existsSync(marker)).toBe(true);
  });

  it('a missing base diffs against HEAD (and reports no base)', async () => {
    const dir = await repo('p-nobase');
    await writeFile(join(dir, 'a.txt'), 'one\n');
    git(dir, 'commit', '-q', '-am', 'committed');
    await writeFile(join(dir, 'b.txt'), 'alpha\n');
    const page = await diffPage(target(dir, 'no-such-branch'), 0);
    expect(page.base).toBeNull();
    expect(page.files.map((f) => f.path)).toEqual(['b.txt']);
  });

  it('a stream clip cuts only the first file; the next file ends the page and starts the next one', async () => {
    const dir = await repo('p-clip');
    await writeFile(join(dir, 'a.txt'), 'A\n'.repeat(200));
    await writeFile(join(dir, 'b.txt'), 'B\n'.repeat(200));
    git(dir, 'commit', '-q', '-am', 'two');
    const real = gitStream;
    const stream: typeof gitStream = (args, o) => real(args, { ...o, maxBytes: 300 });
    const page = await diffPage(target(dir), 0, { stream });
    expect(page.next).toBe(1);
    expect(page.files.map((f) => f.path)).toEqual(['a.txt']);
    const [a] = page.files;
    expect(a?.lines.length).toBeGreaterThan(0);
    expect(a?.clipped).toBeGreaterThan(0);
    const second = await diffPage(target(dir), 1, { stream });
    expect(second.files[0]?.path).toBe('b.txt');
    expect(second.files[0]?.lines.length).toBeGreaterThan(0);
  });

  it('a partial file counts only added and removed lines as clipped, not context', async () => {
    const dir = await repo('p-partial');
    const lines = Array.from({ length: 30 }, (_, i) => `l${i}`);
    await writeFile(join(dir, 'a.txt'), `${lines.join('\n')}\n`);
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'base');
    lines.splice(15, 0, ...Array.from({ length: 10 }, (_, i) => `new${i}`));
    await writeFile(join(dir, 'a.txt'), `${lines.join('\n')}\n`);
    // 10 added lines; the stream stops after three context lines and two of them.
    const cutShort = [
      'diff --git a/a.txt b/a.txt',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -13,6 +13,16 @@',
      ' l12',
      ' l13',
      ' l14',
      '+new0',
      '+new1',
      '+new',
    ].join('\n');
    const page = await diffPage(target(dir, null), 0, {
      stream: async () => ({ stdout: cutShort, clipped: true }),
    });
    expect(page.files[0]).toMatchObject({ path: 'a.txt', added: 10, removed: 0, clipped: 8 });
  });

  it('a tracked file git printed no text for, with a non-zero count, is shown as left out', async () => {
    const dir = await repo('p-notext');
    await writeFile(join(dir, 'a.txt'), 'one\ntwo\nthree\nfour\n');
    const page = await diffPage(target(dir, null), 0, {
      stream: async () => ({ stdout: '', clipped: false }),
    });
    expect(page.files[0]).toMatchObject({ path: 'a.txt', added: 1, lines: [], clipped: 1 });
  });

  it('scattered edits across 10 files: every file appears with all its lines on some page', async () => {
    const dir = await repo('p-scatter');
    const body = (n: number, edit: boolean) =>
      Array.from({ length: 600 }, (_, j) =>
        edit && j % 10 === 5 ? `f${n} edited ${j}` : `f${n} line ${j}`,
      ).join('\n');
    for (let n = 0; n < 10; n++) await writeFile(join(dir, `s${n}.txt`), `${body(n, false)}\n`);
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'base');
    for (let n = 0; n < 10; n++) await writeFile(join(dir, `s${n}.txt`), `${body(n, true)}\n`);
    const seen = new Map<string, number>();
    const starts: number[] = [];
    let from: number | null = 0;
    while (from !== null) {
      starts.push(from);
      const page = await diffPage(target(dir, null), from);
      expect(page.files.length).toBeGreaterThan(0);
      for (const f of page.files) {
        expect(f.clipped).toBe(0);
        seen.set(f.path, f.lines.filter(([k]) => k === 'add').length);
      }
      from = page.next;
    }
    expect([...seen.keys()]).toEqual(Array.from({ length: 10 }, (_, n) => `s${n}.txt`));
    expect([...seen.values()].every((adds) => adds === 60)).toBe(true);
    expect(starts.length).toBeGreaterThan(1);
  });

  it.skipIf(process.platform === 'win32')(
    'a file turned into a symlink keeps both sides (one entry, delete and add)',
    async () => {
      const dir = await repo('p-typechange');
      await rm(join(dir, 'b.txt'));
      await symlink('a.txt', join(dir, 'b.txt'));
      const page = await diffPage(target(dir, null), 0);
      expect(page.files.map((f) => f.path)).toEqual(['b.txt']);
      const [b] = page.files;
      expect(b?.lines).toEqual(
        expect.arrayContaining([
          ['del', 'alpha'],
          ['del', 'beta'],
          ['add', 'a.txt'],
        ]),
      );
    },
  );

  it('matches files with spaces and non-ASCII names in real git output (renamed, deleted, modified)', async () => {
    const dir = await repo('p-names');
    await writeFile(join(dir, 'my file.txt'), 'one\n');
    await writeFile(join(dir, 'café.txt'), 'two\n');
    await writeFile(join(dir, 'rename me.txt'), 'keep\nthis\ncontent\nfor\nrename\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'names');
    await writeFile(join(dir, 'my file.txt'), 'one!\n');
    git(dir, 'rm', '-q', 'café.txt');
    git(dir, 'mv', 'rename me.txt', 'renamed ö.txt');
    const page = await diffPage(target(dir, null), 0);
    const list = await changedFiles(dir, null);
    expect(page.files.map((f) => f.path)).toEqual(list.files.map((f) => f.path));
    const by = Object.fromEntries(page.files.map((f) => [f.path, f]));
    expect(by['my file.txt']?.lines).toContainEqual(['add', 'one!']);
    expect(by['café.txt']).toMatchObject({ kind: 'deleted' });
    expect(by['café.txt']?.lines).toContainEqual(['del', 'two']);
    expect(by['renamed ö.txt']).toMatchObject({ kind: 'renamed', oldPath: 'rename me.txt' });
  });

  it('pathspecs are literal: a path that looks like a glob diffs only itself', async () => {
    const dir = await repo('p-literal');
    await writeFile(join(dir, '[ab].txt'), 'star\n');
    await writeFile(join(dir, 'a.txt'), 'changed\n');
    git(dir, 'add', '.');
    const calls: string[][] = [];
    const page = await diffPage(target(dir), 0, {
      stream: (args, o) => {
        calls.push(args);
        return gitStream(args, o);
      },
    });
    expect(page.files.map((f) => [f.path, f.lines.length])).toEqual([
      ['[ab].txt', 2],
      ['a.txt', 5],
    ]);
    expect(calls[0]).toEqual(
      expect.arrayContaining([
        '--no-ext-diff',
        '--no-textconv',
        '--no-color',
        '--ignore-submodules=all',
        '-U3',
        ':(literal)[ab].txt',
        ':(literal)a.txt',
      ]),
    );
  });
});

describe('DiffService', () => {
  const page = (from: number) => ({
    base: null,
    branch: '',
    from,
    next: null,
    filesTotal: 0,
    files: [],
  });

  it('unknown id → 404; a missing folder → 422; a git failure → 422 with its first line', async () => {
    const dir = await repo('s-errors');
    const svc = new DiffService({
      target: (id) =>
        id === 'k'
          ? { worktree: dir, base: null, branch: null, repo: null }
          : id === 'gone'
            ? { worktree: join(root, 'nope'), base: null, branch: 'x', repo: null }
            : null,
      page: async () => {
        throw Object.assign(new Error('Command failed'), {
          stderr: 'fatal: bad \u001b[31mthing\nmore',
        });
      },
    });
    await expect(svc.page('x', 0)).rejects.toMatchObject({ status: 404 });
    await expect(svc.page('gone', 0)).rejects.toMatchObject({ status: 422 });
    const err = await svc.page('k', 0).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DiffError);
    expect(err).toMatchObject({
      status: 422,
      message: "git couldn't show the diff: fatal: bad thing",
    });
  });

  it("a redirected .git answers 409 with the refusal; the page gets the record's repo (M4)", async () => {
    const dir = await repo('s-unpinned');
    const got: unknown[] = [];
    const svc = new DiffService({
      target: () => ({ worktree: dir, base: null, branch: 'kage/x', repo: '/projects/app' }),
      page: async (t) => {
        got.push(t.repo);
        throw new UnpinnedError();
      },
    });
    const err = await svc.page('k', 0).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DiffError);
    expect(err).toMatchObject({ status: 409, message: UNPINNED });
    expect(got).toEqual(['/projects/app']);
  });

  it('a third pending request for one session gets 429; an aborted waiter never runs git', async () => {
    const dir = await repo('s-queue');
    const ran: number[] = [];
    let open = () => {};
    const gate = new Promise<void>((r) => {
      open = r;
    });
    const svc = new DiffService({
      target: () => ({ worktree: dir, base: null, branch: 'x', repo: null }),
      page: async (_t, from) => {
        ran.push(from);
        if (from === 0) await gate;
        return page(from);
      },
    });
    const ctl = new AbortController();
    const first = svc.page('a', 0);
    const second = svc.page('a', 1, ctl.signal);
    const third = await svc.page('a', 2).catch((e: unknown) => e);
    expect(third).toMatchObject({ status: 429, message: STILL_WORKING });
    expect(STILL_WORKING).toBe('Kage is still working on the last diff.');
    ctl.abort();
    open();
    await first;
    await expect(second).rejects.toMatchObject({ status: 422 });
    expect(ran).toEqual([0]);
    // The queue is free again.
    expect((await svc.page('a', 3)).from).toBe(3);
  });

  it('one diff at a time per session, two at a time in all', async () => {
    const dir = await repo('s-limits');
    let running = 0;
    let peak = 0;
    const perSession = new Map<string, number>();
    let sessionPeak = 0;
    const releases: (() => void)[] = [];
    const svc = new DiffService({
      target: (id) => ({ worktree: dir, base: null, branch: id, repo: null }),
      page: async (t, from) => {
        running++;
        peak = Math.max(peak, running);
        const n = (perSession.get(t.branch) ?? 0) + 1;
        perSession.set(t.branch, n);
        sessionPeak = Math.max(sessionPeak, n);
        await new Promise<void>((r) => releases.push(r));
        perSession.set(t.branch, n - 1);
        running--;
        return page(from);
      },
    });
    const all = [svc.page('a', 0), svc.page('a', 1), svc.page('b', 0), svc.page('c', 0)];
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 20));
      releases.shift()?.();
    }
    const done = await Promise.all(all);
    expect(done.map((p) => p.from)).toEqual([0, 1, 0, 0]);
    expect(peak).toBe(2);
    expect(sessionPeak).toBe(1);
  });
});

describe('LIMITS used by the diff', () => {
  it('are the Task 2 values', () => {
    expect([LIMITS.diffLines, LIMITS.diffBytes, LIMITS.diffLineChars]).toEqual([
      1000, 524_288, 2000,
    ]);
  });
});
