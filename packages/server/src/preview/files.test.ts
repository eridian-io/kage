import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LIMITS } from '@kage/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GitExec } from '../git/exec.ts';
import {
  type Change,
  changedFiles,
  listChanges,
  mergeBase,
  parseNumstat,
  readUntracked,
  UNTRACKED_CACHE_MAX,
  UntrackedCache,
} from './files.ts';

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

/** A repo on main with a few files, and a worktree-like branch `task` checked out. */
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
  root = await mkdtemp(join(tmpdir(), 'kage-files-'));
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

describe('parseNumstat', () => {
  it('reads -z records: plain, renamed (the new path) and binary (0)', () => {
    const out = '3\t1\tsrc/a.ts\x000\t0\t\x00old name.txt\x00new name.txt\x00-\t-\timg.png\x00';
    expect(parseNumstat(out)).toEqual([
      { path: 'src/a.ts', added: 3, removed: 1 },
      { path: 'new name.txt', added: 0, removed: 0 },
      { path: 'img.png', added: 0, removed: 0 },
    ]);
    expect(parseNumstat('')).toEqual([]);
  });
});

describe('changedFiles', () => {
  it('counts committed and uncommitted edits, a rename, a binary file and untracked files', async () => {
    const dir = await repo('mixed');
    // Committed on the branch: one line added to a.txt.
    await writeFile(join(dir, 'a.txt'), 'one\ntwo\nthree\nfour\n');
    git(dir, 'commit', '-q', '-am', 'edit a');
    // Uncommitted: b.txt loses a line and gains two; old.txt renamed (staged); a binary file.
    await writeFile(join(dir, 'b.txt'), 'alpha\ngamma\ndelta\n');
    git(dir, 'mv', 'old.txt', 'new.txt');
    await writeFile(join(dir, 'bin.dat'), Buffer.from([0, 1, 2, 3, 0, 255]));
    git(dir, 'add', 'bin.dat');
    // Untracked: a 3-line file, one without a final newline, and an ignored one.
    await writeFile(join(dir, 'notes.md'), 'x\ny\nz\n');
    await mkdir(join(dir, 'sub'));
    await writeFile(join(dir, 'sub', 'tail.txt'), 'p\nq');
    await writeFile(join(dir, '.gitignore'), 'ignored.log\n');
    await writeFile(join(dir, 'ignored.log'), 'nope\n');

    const r = await changedFiles(dir, 'main');
    expect(r).toEqual({
      files: [
        { path: '.gitignore', added: 1, removed: 0 },
        { path: 'a.txt', added: 1, removed: 0 },
        { path: 'b.txt', added: 2, removed: 1 },
        { path: 'bin.dat', added: 0, removed: 0 },
        { path: 'new.txt', added: 0, removed: 0 },
        { path: 'notes.md', added: 3, removed: 0 },
        { path: 'sub/tail.txt', added: 2, removed: 0 },
      ],
      total: 7,
    });
  });

  it('diffs against the merge base, so commits on the base after the branch are not counted', async () => {
    const dir = await repo('moved-base');
    git(dir, 'checkout', '-q', 'main');
    await writeFile(join(dir, 'main-only.txt'), 'm\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'main moves on');
    git(dir, 'checkout', '-q', 'task');
    await writeFile(join(dir, 'a.txt'), 'changed\n');
    expect(await changedFiles(dir, 'main')).toEqual({
      files: [{ path: 'a.txt', added: 1, removed: 3 }],
      total: 1,
    });
  });

  it('a missing or null base diffs against HEAD', async () => {
    const dir = await repo('no-base');
    await writeFile(join(dir, 'b.txt'), 'alpha\nbeta\nmore\n');
    git(dir, 'commit', '-q', '-am', 'committed on task');
    await writeFile(join(dir, 'a.txt'), 'one\ntwo\nthree\nfour\n');
    const want = { files: [{ path: 'a.txt', added: 1, removed: 0 }], total: 1 };
    expect(await changedFiles(dir, 'no-such-branch')).toEqual(want);
    expect(await changedFiles(dir, null)).toEqual(want);
  });

  it('caps the list at LIMITS.files and reports the full total', async () => {
    const dir = await repo('many');
    for (let i = 0; i < 150; i++) {
      await writeFile(join(dir, `f${String(i).padStart(3, '0')}.txt`), 'line\n');
    }
    const r = await changedFiles(dir, 'main');
    expect(r.files).toHaveLength(100);
    expect(r.total).toBe(150);
    expect(r.files[0]?.path).toBe('f000.txt');
    // At most 100 untracked files are read; those are counted, the rest show 0.
    expect(r.files.every((f) => f.added === 1)).toBe(true);
  });

  it('counts 0 for an untracked file over 1 MiB or with a NUL in its first 8 KiB', async () => {
    const dir = await repo('big');
    await writeFile(join(dir, 'big.txt'), 'a\n'.repeat(600 * 1024));
    await writeFile(join(dir, 'nul.txt'), Buffer.concat([Buffer.from('a\nb\n'), Buffer.from([0])]));
    expect((await changedFiles(dir, 'main')).files).toEqual([
      { path: 'big.txt', added: 0, removed: 0 },
      { path: 'nul.txt', added: 0, removed: 0 },
    ]);
  });

  it.skipIf(process.platform === 'win32')(
    'an untracked symlink pointing outside the worktree is counted 0 and never read',
    async () => {
      const dir = await repo('link');
      const outside = join(root, 'secret.txt');
      await writeFile(outside, 'one\ntwo\nthree\n');
      await symlink(outside, join(dir, 'leak.txt'));
      expect((await changedFiles(dir, 'main')).files).toEqual([
        { path: 'leak.txt', added: 0, removed: 0 },
      ]);
    },
  );

  it('runs git with argument arrays: merge-base on refs/heads, diff and ls-files in the worktree', async () => {
    const calls: { args: string[]; cwd: string | undefined }[] = [];
    const exec: GitExec = async (args, opts) => {
      calls.push({ args, cwd: opts?.cwd });
      if (args.includes('merge-base')) return { stdout: 'abc1234def\n', stderr: '' };
      return { stdout: '', stderr: '' };
    };
    expect(await changedFiles('/w', '--evil', exec)).toEqual({ files: [], total: 0 });
    expect(calls.every((c) => c.cwd === '/w')).toBe(true);
    const mb = calls.find((c) => c.args.includes('merge-base'));
    expect(mb?.args.slice(-2)).toEqual(['refs/heads/--evil', 'HEAD']);
    const diff = calls.find((c) => c.args.includes('diff'));
    expect(diff?.args).toContain('-z');
    expect(diff?.args.slice(-2)).toEqual(['abc1234def', '--']);
  });
});

describe('changedFiles: arguments (F4, F8)', () => {
  it('numstat passes --no-ext-diff and --no-textconv; fsmonitor is left to gitExec', async () => {
    const calls: string[][] = [];
    const exec: GitExec = async (args) => {
      calls.push(args);
      return { stdout: '', stderr: '' };
    };
    await changedFiles('/w', null, exec);
    expect(calls).toEqual([
      [
        'diff',
        '--numstat',
        '-z',
        '-M',
        '--relative',
        '--no-ext-diff',
        '--no-textconv',
        '--no-color',
        '--ignore-submodules=none',
        'HEAD',
        '--',
      ],
      ['ls-files', '--others', '--exclude-standard', '-z'],
    ]);
  });
});

describe('mergeBase and listChanges (shared by the list and the diff)', () => {
  it('mergeBase is the hash of the fork point, or HEAD for a null or missing base', async () => {
    const dir = await repo('mb');
    const fork = git(dir, 'rev-parse', 'HEAD').trim();
    await writeFile(join(dir, 'a.txt'), 'x\n');
    git(dir, 'commit', '-q', '-am', 'on task');
    expect(await mergeBase(dir, 'main')).toBe(fork);
    expect(await mergeBase(dir, null)).toBe('HEAD');
    expect(await mergeBase(dir, 'gone')).toBe('HEAD');
  });

  it('listChanges keeps rename sources and marks untracked files, sorted and uncapped', async () => {
    const dir = await repo('lc');
    git(dir, 'mv', 'old.txt', 'new.txt');
    await writeFile(join(dir, 'b.txt'), 'alpha\n');
    await writeFile(join(dir, 'u.txt'), 'u\n');
    for (let i = 0; i < LIMITS.files + 5; i++) await writeFile(join(dir, `z${i}.txt`), 'z\n');
    const { mb, changes } = await listChanges(dir, 'main');
    expect(mb).toMatch(/^[0-9a-f]{40}$/);
    expect(changes).toHaveLength(LIMITS.files + 8);
    expect(changes.slice(0, 3)).toEqual([
      { path: 'b.txt', added: 0, removed: 1, untracked: false },
      { path: 'new.txt', oldPath: 'old.txt', added: 0, removed: 0, untracked: false },
      { path: 'u.txt', added: 1, removed: 0, untracked: true },
    ]);
    const paths = changes.map((c) => c.path);
    expect(paths).toEqual([...paths].sort());
    const list = await changedFiles(dir, 'main');
    expect(list.files).toEqual(
      changes.slice(0, LIMITS.files).map(({ path, added, removed }) => ({ path, added, removed })),
    );
    expect(list.total).toBe(changes.length);
  });
});

describe('the untracked line-count cache (B37)', () => {
  /** A counting reader around the real one (ruling F12). */
  const counting = () => {
    const reads: string[] = [];
    const read: typeof readUntracked = (r, rel) => {
      reads.push(rel);
      return readUntracked(r, rel);
    };
    return { reads, read };
  };
  const counts = (changes: Change[]) =>
    Object.fromEntries(changes.filter((c) => c.untracked).map((c) => [c.path, c.added]));

  it('a second listChanges with unchanged untracked files reads none of them', async () => {
    const dir = await repo('cache-same');
    for (const n of ['u1.txt', 'u2.txt', 'u3.txt']) await writeFile(join(dir, n), 'a\nb\n');
    const cache = new UntrackedCache();
    const { reads, read } = counting();
    const first = await listChanges(dir, 'main', undefined, { cache, read });
    expect(reads.sort()).toEqual(['u1.txt', 'u2.txt', 'u3.txt']);
    reads.length = 0;
    const second = await listChanges(dir, 'main', undefined, { cache, read });
    expect(reads).toEqual([]);
    expect(counts(second.changes)).toEqual(counts(first.changes));
    expect(counts(second.changes)).toEqual({ 'u1.txt': 2, 'u2.txt': 2, 'u3.txt': 2 });
  });

  it('a changed mtimeMs re-reads that file only', async () => {
    const dir = await repo('cache-mtime');
    for (const n of ['u1.txt', 'u2.txt']) await writeFile(join(dir, n), 'a\nb\n');
    const cache = new UntrackedCache();
    const { reads, read } = counting();
    await listChanges(dir, 'main', undefined, { cache, read });
    reads.length = 0;
    // Same size, new content and a new mtime: only the mtime tells it changed.
    await writeFile(join(dir, 'u2.txt'), 'abc\n');
    const later = new Date(Date.now() + 60_000);
    await utimes(join(dir, 'u2.txt'), later, later);
    const { changes } = await listChanges(dir, 'main', undefined, { cache, read });
    expect(reads).toEqual(['u2.txt']);
    expect(counts(changes)).toEqual({ 'u1.txt': 2, 'u2.txt': 1 });
  });

  it('holds at most its bound, and forget(worktree) drops that worktree only', async () => {
    const a = await repo('cache-a');
    const b = await repo('cache-b');
    for (const n of ['u1.txt', 'u2.txt', 'u3.txt']) await writeFile(join(a, n), 'a\n');
    await writeFile(join(b, 'v.txt'), 'v\n');
    const cache = new UntrackedCache(2);
    const { reads, read } = counting();
    await listChanges(a, 'main', undefined, { cache, read });
    expect(cache.size).toBe(2);
    reads.length = 0;
    await listChanges(a, 'main', undefined, { cache, read });
    expect(reads.length).toBeGreaterThan(0);

    const big = new UntrackedCache();
    await listChanges(a, 'main', undefined, { cache: big, read });
    await listChanges(b, 'main', undefined, { cache: big, read });
    expect(big.size).toBe(4);
    big.forget(a);
    expect(big.size).toBe(1);
    reads.length = 0;
    await listChanges(b, 'main', undefined, { cache: big, read });
    expect(reads).toEqual([]);
  });

  it('the default bound is 2,000 entries', () => {
    expect(UNTRACKED_CACHE_MAX).toBe(2000);
  });
});
