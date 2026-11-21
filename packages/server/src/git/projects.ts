import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { LIMITS, type Project, type ProjectsResponse } from '@kage/shared';
import { type GitExec, gitExec } from './exec.ts';

export const PROJECT_NAME = /^(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/;

const CONCURRENCY = 8;

async function hasGit(dir: string): Promise<boolean> {
  try {
    await stat(join(dir, '.git'));
    return true;
  } catch {
    return false;
  }
}

/** One git spawn per repo: local branches, which one is checked out, and origin/HEAD. */
async function readProject(exec: GitExec, name: string, path: string): Promise<Project | null> {
  let stdout: string;
  try {
    ({ stdout } = await exec(
      [
        'for-each-ref',
        '--format=%(refname)%09%(HEAD)%09%(symref)',
        'refs/heads',
        'refs/remotes/origin/HEAD',
      ],
      { cwd: path },
    ));
  } catch {
    return null;
  }
  const all: string[] = [];
  let head: string | null = null;
  let originBranch: string | null = null;
  for (const line of stdout.split('\n')) {
    const [ref = '', mark = '', symref = ''] = line.split('\t');
    if (ref.startsWith('refs/heads/')) {
      const branch = ref.slice('refs/heads/'.length);
      all.push(branch);
      if (mark === '*') head = branch;
    } else if (ref === 'refs/remotes/origin/HEAD' && symref.startsWith('refs/remotes/origin/')) {
      originBranch = symref.slice('refs/remotes/origin/'.length);
    }
  }
  if (all.length === 0) return null;
  const branches = all.slice(0, LIMITS.branches);
  const found = [originBranch, head, 'main', 'master'].find((c) => c && all.includes(c));
  const defaultBranch = found ?? all[0] ?? '';
  // The default must be listed even when the cap cut it off.
  if (!branches.includes(defaultBranch)) branches[branches.length - 1] = defaultBranch;
  return { name, defaultBranch, branches };
}

async function candidates(root: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  const ok: string[] = [];
  for (const n of names.sort()) {
    if (!PROJECT_NAME.test(n)) continue;
    try {
      if (!(await stat(join(root, n))).isDirectory()) continue;
    } catch {
      continue;
    }
    if (await hasGit(join(root, n))) ok.push(n);
  }
  return ok;
}

export async function listProjects(root: string, exec: GitExec = gitExec): Promise<Project[]> {
  const names = await candidates(root);
  const results: (Project | null)[] = new Array(names.length).fill(null);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < names.length; i = next++) {
      const name = names[i] as string;
      results[i] = await readProject(exec, name, join(root, name));
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, names.length) }, worker));
  return results.filter((p): p is Project => p !== null).slice(0, LIMITS.projects);
}

export async function findProject(
  root: string,
  name: string,
  exec: GitExec = gitExec,
): Promise<(Project & { path: string }) | null> {
  if (!PROJECT_NAME.test(name)) return null;
  const path = join(root, name);
  try {
    if (!(await stat(path)).isDirectory()) return null;
  } catch {
    return null;
  }
  if (!(await hasGit(path))) return null;
  const p = await readProject(exec, name, path);
  return p ? { ...p, path } : null;
}

/**
 * Caches one listing for a short time and shares a scan that is already running, so repeated
 * opens of the form (or a burst of requests) cost git at most once per ttl.
 */
export class ProjectsCache {
  readonly #load: () => Promise<ProjectsResponse>;
  readonly #ttl: number;
  readonly #now: () => number;
  #value: ProjectsResponse | null = null;
  #at = 0;
  #flight: Promise<ProjectsResponse> | null = null;
  #gen = 0;

  constructor(load: () => Promise<ProjectsResponse>, ttlMs = 10_000, now = Date.now) {
    this.#load = load;
    this.#ttl = ttlMs;
    this.#now = now;
  }

  get(): Promise<ProjectsResponse> {
    if (this.#value && this.#now() - this.#at < this.#ttl) return Promise.resolve(this.#value);
    if (!this.#flight) {
      const gen = this.#gen;
      const flight: Promise<ProjectsResponse> = this.#load()
        .then((v) => {
          // A scan that began before invalidate() may be stale: it never fills the cache.
          if (gen === this.#gen) {
            this.#value = v;
            this.#at = this.#now();
          }
          return v;
        })
        .finally(() => {
          if (this.#flight === flight) this.#flight = null;
        });
      this.#flight = flight;
    }
    return this.#flight;
  }

  /** Forgets the listing (a launch added a branch); a scan already running is not reused. */
  invalidate(): void {
    this.#gen++;
    this.#value = null;
    this.#flight = null;
  }
}
