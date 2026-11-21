import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { LIMITS, type Project } from '@kage/shared';
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

async function out(exec: GitExec, args: string[], cwd: string): Promise<string | null> {
  try {
    return (await exec(args, { cwd })).stdout.trim();
  } catch {
    return null;
  }
}

async function readProject(exec: GitExec, name: string, path: string): Promise<Project | null> {
  const refs = await out(exec, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'], path);
  const all = (refs ?? '').split('\n').filter((b) => b !== '');
  if (all.length === 0) return null;
  const branches = all.slice(0, LIMITS.branches);
  const has = (b: string | null | undefined): b is string => !!b && all.includes(b);
  const origin = await out(
    exec,
    ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'],
    path,
  );
  const head = await out(exec, ['symbolic-ref', '-q', '--short', 'HEAD'], path);
  const originBranch = origin?.startsWith('origin/') ? origin.slice('origin/'.length) : null;
  const candidates = [originBranch, head, 'main', 'master'];
  const found = candidates.find(has);
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
