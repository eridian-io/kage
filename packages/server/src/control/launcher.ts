import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, appendFile, lstat, mkdir, readFile, realpath, stat } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { NewTaskBody, NewTaskResponse } from '@kage/shared';
import { firstLine, type GitExec } from '../git/exec.ts';
import { findProject } from '../git/projects.ts';
import type { LiveSource } from '../live-source.ts';
import type { SessionRecord } from '../state/store.ts';
import type { TmuxClient } from '../tmux/client.ts';
import { slugify, uniqueSlug } from './slug.ts';
import { parseNewTask } from './validate.ts';

/** A launch refused or failed; `status` is the HTTP status the route answers with. */
export class LaunchError extends Error {
  readonly status: 400 | 404 | 422 | 503;
  constructor(status: 400 | 404 | 422 | 503, message: string) {
    super(message);
    this.name = 'LaunchError';
    this.status = status;
  }
}

export const NO_CLAUDE = "Claude Code isn't on Kage's PATH. Install it, or set KAGE_CLAUDE_BIN.";

/** `git worktree add` may check out a large tree: it gets 60 s, other git calls 10 s. */
const WORKTREE_ADD_TIMEOUT_MS = 60_000;

/**
 * The exact command Kage runs (rulings R4 and R19): never another permission mode, never
 * `--dangerously-skip-permissions`; the task follows `--`, so it can't be read as an option.
 */
export function claudeArgv(
  bin: string,
  settingsPath: string,
  acceptEdits: boolean,
  task: string,
): string[] {
  return [
    bin,
    '--settings',
    settingsPath,
    '--permission-mode',
    acceptEdits ? 'acceptEdits' : 'default',
    '--',
    task,
  ];
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function searchPath(name: string, pathVar: string | undefined): Promise<string | null> {
  for (const dir of (pathVar ?? '').split(delimiter)) {
    // A relative PATH entry would depend on Kage's working directory: skip it.
    if (dir === '' || !isAbsolute(dir)) continue;
    const candidate = join(dir, name);
    if (await isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/**
 * The claude executable (F12: the only producer of `claudeBin`): `KAGE_CLAUDE_BIN` (a path, or a
 * name looked up on PATH), else the first executable `claude` on PATH; null when there is none.
 */
export async function resolveClaude(env: NodeJS.ProcessEnv): Promise<string | null> {
  const given = env.KAGE_CLAUDE_BIN;
  if (given) {
    if (isAbsolute(given) || given.includes('/')) {
      const path = resolve(given);
      return (await isExecutableFile(path)) ? path : null;
    }
    return searchPath(given, env.PATH);
  }
  return searchPath('claude', env.PATH);
}

export interface LauncherDeps {
  projectsRoot: string;
  worktreeDir: string;
  branchPrefix: string;
  git: GitExec;
  tmux: Pick<TmuxClient, 'newWindow'>;
  /** `branchTaken` lets the slug skip branches that Kage's records use (deleted or not). */
  source: Pick<LiveSource, 'adopt' | 'claim' | 'abandon' | 'branchTaken'>;
  claudeBin: string | null;
  settingsPath: string;
  hookSocket: string;
  /** PATH inside the window. */
  windowPath: string;
  newId?: () => string;
  now?: () => number;
}

/** True when `child` is `parent` itself or below it (both absolute). */
function within(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Starts tasks (spec §5.2): a new branch and worktree from the base, a record saved before the
 * window opens, and a tmux window tagged `@kage_id` that runs claude directly. Starts in one
 * project run one at a time, so two of the same task get distinct names.
 */
export class TaskLauncher {
  readonly #d: LauncherDeps;
  readonly #newId: () => string;
  readonly #now: () => number;
  readonly #queues = new Map<string, Promise<unknown>>();

  constructor(d: LauncherDeps) {
    this.#d = d;
    this.#newId = d.newId ?? randomUUID;
    this.#now = d.now ?? Date.now;
  }

  /** Throws LaunchError (400, 404, 422 or 503); anything else is a bug. */
  async start(body: NewTaskBody | unknown): Promise<NewTaskResponse> {
    const bin = this.#d.claudeBin;
    if (bin === null) throw new LaunchError(503, NO_CLAUDE);
    const parsed = parseNewTask(body);
    if (!parsed.ok) throw new LaunchError(400, parsed.error);
    const task = parsed.value;
    return this.#serial(task.project, () => this.#launch(task, bin));
  }

  #serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#queues.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => {});
    this.#queues.set(key, tail);
    void tail.then(() => {
      if (this.#queues.get(key) === tail) this.#queues.delete(key);
    });
    return run;
  }

  async #launch(t: NewTaskBody, bin: string): Promise<NewTaskResponse> {
    const d = this.#d;
    const project = await findProject(d.projectsRoot, t.project, d.git);
    if (!project) {
      throw new LaunchError(404, `No project named "${t.project}" in ${d.projectsRoot}.`);
    }
    if (!project.branches.includes(t.base)) {
      throw new LaunchError(404, `No branch named "${t.base}" in ${t.project}.`);
    }
    const repo = resolve(project.path);
    const wtRoot = await this.#worktreeRoot(repo);

    let slug: string;
    try {
      slug = await uniqueSlug(slugify(t.task), async (s) => {
        const branch = `${d.branchPrefix}${s}`;
        return (
          d.source.branchTaken(project.name, branch) ||
          (await exists(join(wtRoot, s))) ||
          (await this.#branchExists(repo, branch))
        );
      });
    } catch (e) {
      throw new LaunchError(422, `git couldn't create the worktree: ${firstLine(e)}`);
    }
    const branch = `${d.branchPrefix}${slug}`;
    const path = join(wtRoot, slug);
    if (relative(wtRoot, path) !== slug) {
      throw new LaunchError(422, `git couldn't create the worktree: ${slug} is not a folder name`);
    }

    try {
      await this.#exclude(repo);
      // `--` ends the options: the path and the base can't be read as flags.
      await d.git(['worktree', 'add', '-q', '-b', branch, '--', path, `refs/heads/${t.base}`], {
        cwd: repo,
        timeoutMs: WORKTREE_ADD_TIMEOUT_MS,
      });
    } catch (e) {
      // K2: the slug was free, so a branch there now is one this request's git created.
      if (await this.#branchExists(repo, branch).catch(() => false)) {
        await d.git(['branch', '-D', '--', branch], { cwd: repo }).catch(() => {});
      }
      throw new LaunchError(422, `git couldn't create the worktree: ${firstLine(e)}`);
    }

    const kageId = this.#newId();
    const record: SessionRecord = {
      kageId,
      windowId: null,
      project: project.name,
      task: t.task,
      branch,
      worktree: path,
      createdAt: this.#now(),
      pinned: false,
      archived: false,
      sessionId: null,
      transcriptPath: null,
      base: t.base,
      permissionMode: t.acceptEdits ? 'acceptEdits' : 'default',
    };
    let adopted = false;
    let windowId: string;
    try {
      // K3: tmux would start the window in $HOME if the folder were missing.
      if (!(await stat(path)).isDirectory()) throw new Error(`${path} is not a folder`);
      await d.source.adopt(record);
      adopted = true;
      ({ windowId } = await d.tmux.newWindow({
        name: slug,
        cwd: path,
        env: { KAGE_SOCKET: d.hookSocket, PATH: d.windowPath },
        argv: claudeArgv(bin, d.settingsPath, t.acceptEdits, t.task),
        kageId,
      }));
    } catch (e) {
      // Only what this request created: its worktree, its branch and its record.
      await d.git(['worktree', 'remove', '--force', '--', path], { cwd: repo }).catch(() => {});
      await d.git(['branch', '-D', '--', branch], { cwd: repo }).catch(() => {});
      if (adopted) await d.source.abandon(kageId).catch(() => {});
      throw new LaunchError(422, `tmux couldn't open a window: ${firstLine(e)}`);
    }
    d.source.claim(kageId, windowId);
    return { id: kageId };
  }

  /** `<repo>/<worktreeDir>`, refused when it leads outside the repo (also through a symlink). */
  async #worktreeRoot(repo: string): Promise<string> {
    const d = this.#d;
    const wtRoot = resolve(repo, d.worktreeDir);
    const outside = new LaunchError(
      422,
      `git couldn't create the worktree: ${d.worktreeDir} leads outside ${repo}`,
    );
    if (wtRoot === repo || !within(repo, wtRoot)) throw outside;
    if (await exists(wtRoot)) {
      let real: string;
      let realRepo: string;
      try {
        [real, realRepo] = await Promise.all([realpath(wtRoot), realpath(repo)]);
      } catch {
        throw outside;
      }
      if (real === realRepo || !within(realRepo, real)) throw outside;
    }
    return wtRoot;
  }

  /** `show-ref --verify --quiet` exits 1 for a missing ref; any other failure is thrown. */
  async #branchExists(repo: string, branch: string): Promise<boolean> {
    try {
      await this.#d.git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], {
        cwd: repo,
      });
      return true;
    } catch (e) {
      if ((e as { code?: unknown }).code === 1) return false;
      throw e;
    }
  }

  /**
   * Keeps the worktrees out of the main checkout's `git status`: `/<worktreeDir>/` as a line of
   * the repo's `info/exclude` (K7: git prints it relative to the repo in a normal checkout).
   */
  async #exclude(repo: string): Promise<void> {
    const { stdout } = await this.#d.git(['rev-parse', '--git-path', 'info/exclude'], {
      cwd: repo,
    });
    const file = resolve(repo, stdout.trim());
    const line = `/${this.#d.worktreeDir}/`;
    let text = '';
    try {
      text = await readFile(file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    if (text.split(/\r?\n/).some((l) => l.trim() === line)) return;
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, `${text !== '' && !text.endsWith('\n') ? '\n' : ''}${line}\n`);
  }
}
