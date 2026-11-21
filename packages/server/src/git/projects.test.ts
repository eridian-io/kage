import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { firstLine, gitExec } from './exec.ts';
import { findProject, listProjects, PROJECT_NAME } from './projects.ts';

let root: string;
let home: string;
const saved: Record<string, string | undefined> = {};

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', ...args], {
    cwd,
    stdio: 'pipe',
  });
}

async function repo(name: string, branch = 'main', extra: string[] = []): Promise<string> {
  const dir = join(root, name);
  await mkdir(dir);
  git(dir, 'init', '-q', '-b', branch);
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'init');
  for (const b of extra) git(dir, 'branch', b);
  return dir;
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'kage-git-'));
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
  await repo('api', 'main', ['feat/x']);
  await repo('web', 'develop');
  await mkdir(join(root, 'notes'));
  await writeFile(join(root, 'afile'), 'x');
  await mkdir(join(root, 'bad name'));
  const empty = join(root, 'empty');
  await mkdir(empty);
  git(empty, 'init', '-q', '-b', 'main');
  // A checkout whose .git is a file.
  git(join(root, 'api'), 'worktree', 'add', '-q', '-b', 'wt', join(root, 'wtcheckout'));
});
afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

describe('PROJECT_NAME', () => {
  it('accepts plain names and refuses dots, slashes and spaces', () => {
    for (const ok of ['api', 'a.b_c-d', '.hidden', 'x'.repeat(100)]) {
      expect(PROJECT_NAME.test(ok)).toBe(true);
    }
    for (const bad of [
      '.',
      '..',
      'a/b',
      'bad name',
      '',
      'x'.repeat(101),
      '../etc',
      '$(rm -rf ~)',
      'a;b',
    ]) {
      expect(PROJECT_NAME.test(bad)).toBe(false);
    }
  });
});

describe('listProjects', () => {
  it('lists repos with a local branch, sorted, with their default branch', async () => {
    const list = await listProjects(root);
    expect(list.map((p) => p.name)).toEqual(['api', 'web', 'wtcheckout']);
    const api = list.find((p) => p.name === 'api');
    expect(api?.defaultBranch).toBe('main');
    expect(api?.branches).toEqual(expect.arrayContaining(['main', 'feat/x']));
    expect(list.find((p) => p.name === 'web')?.defaultBranch).toBe('develop');
  });

  it('lists a checkout whose .git is a file', async () => {
    const p = await findProject(root, 'wtcheckout');
    expect(p?.defaultBranch).toBe('wt');
  });

  it('returns [] for a missing root', async () => {
    expect(await listProjects(join(root, 'nope'))).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')(
    'lists a symlinked project by its link name',
    async () => {
      await symlink(join(root, 'web'), join(root, 'link-to-web'));
      const names = (await listProjects(root)).map((p) => p.name);
      expect(names).toContain('link-to-web');
    },
  );
});

describe('findProject', () => {
  it('finds a project with its path', async () => {
    const p = await findProject(root, 'api');
    expect(p?.path).toBe(join(root, 'api'));
  });

  it('refuses hostile names', async () => {
    const hostile = [
      '../etc',
      '.',
      '..',
      'api/../web',
      '../../etc',
      'a/../../b',
      '$(rm -rf ~)',
      'notes',
      'nope',
    ];
    for (const n of hostile) expect(await findProject(root, n)).toBeNull();
  });
});

describe('gitExec', () => {
  it('runs git and reports the first stderr line', async () => {
    expect((await gitExec(['--version'])).stdout).toMatch(/^git version/);
    const err = await gitExec(['rev-parse', '--verify', 'no-such-ref-xyz'], { cwd: root }).catch(
      (e) => e,
    );
    expect(firstLine(err)).not.toContain('\n');
    expect(firstLine(new Error('boom\nmore'))).toBe('boom');
  });
});
