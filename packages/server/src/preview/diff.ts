import { realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { type DiffFile, type DiffLineKind, type DiffPage, LIMITS } from '@kage/shared';
import { firstLine, type GitExec, gitExec, gitStream } from '../git/exec.ts';
import { stripAnsi } from '../text/ansi.ts';
import { plainLine } from '../text/bounds.ts';
import { type Change, listChanges, looksBinary, readUntracked } from './files.ts';

export interface ParseOptions {
  /** Content lines (not hunk headers) kept per file; the rest count in `clipped`. */
  maxLines: number;
  /** Longer lines are cut to this many characters plus "…". */
  maxLineChars: number;
}

/** Plain text for one diff line: no escapes, controls or bidi characters, at most `max` chars plus "…". */
function clipLine(raw: string, max: number): string {
  const s = stripAnsi(raw, { oneLine: true, limit: max + 1 });
  if (s.length <= max) return s;
  let cut = s.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/** A path as it goes on the wire: the same stripping as every other text field. */
const wirePath = (p: string): string => stripAnsi(p, { oneLine: true });

const ESCAPES: Record<string, number> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  '"': 34,
  '\\': 92,
};

/**
 * One C-quoted token at the start of `s` (git's quoting of unusual paths: escapes and octal
 * bytes), decoded as UTF-8; `rest` is what follows the closing quote. Null when `s` doesn't start
 * with a complete quoted token.
 */
function readQuoted(s: string): { value: string; rest: string } | null {
  if (!s.startsWith('"')) return null;
  const bytes: number[] = [];
  let i = 1;
  while (i < s.length) {
    const ch = s[i] as string;
    if (ch === '"') return { value: Buffer.from(bytes).toString('utf8'), rest: s.slice(i + 1) };
    if (ch === '\\') {
      const next = s[i + 1] ?? '';
      if (/[0-7]/.test(next)) {
        bytes.push(Number.parseInt(s.slice(i + 1, i + 4), 8) & 0xff);
        i += 4;
        continue;
      }
      const code = ESCAPES[next];
      if (code === undefined) return null;
      bytes.push(code);
      i += 2;
      continue;
    }
    // core.quotePath=false leaves UTF-8 as is; it is always forced on below, but stay safe.
    const cp = s.codePointAt(i) as number;
    const char = String.fromCodePoint(cp);
    bytes.push(...Buffer.from(char, 'utf8'));
    i += char.length;
  }
  return null;
}

/** A path field: C-quoted or plain; git adds a trailing tab after a name with a space. */
function readPath(s: string): string {
  const q = readQuoted(s);
  if (q) return q.value;
  return s.endsWith('\t') ? s.slice(0, -1) : s;
}

/** `--- a/x` / `+++ b/x`: the path without its prefix; null for /dev/null. */
function sidePath(s: string, prefix: string): string | null {
  if (s === '/dev/null') return null;
  const p = readPath(s);
  return p.startsWith(prefix) ? p.slice(prefix.length) : p;
}

/**
 * The path in `diff --git a/P b/P` when both sides name the same file (plain or quoted). A rename
 * with unquoted names is ambiguous here; its `rename to` line names it instead.
 */
function headerPath(rest: string): string | undefined {
  const qa = readQuoted(rest);
  if (qa) {
    const qb = readQuoted(qa.rest.trimStart());
    const b = qb ? qb.value : qa.rest.trimStart();
    return b.startsWith('b/') ? b.slice(2) : undefined;
  }
  // `a/P b/P`: 2 + n + 3 + n characters.
  const n = (rest.length - 5) / 2;
  if (!Number.isInteger(n) || n < 1 || !rest.startsWith('a/')) return undefined;
  const p = rest.slice(2, 2 + n);
  return rest.slice(2 + n) === ` b/${p}` ? p : undefined;
}

interface Building {
  header: string | undefined;
  minus: string | null | undefined;
  plus: string | null | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  isNew: boolean;
  isDeleted: boolean;
  binary: boolean;
  inHunk: boolean;
  added: number;
  removed: number;
  content: number;
  clipped: number;
  lines: [DiffLineKind, string][];
}

function finish(b: Building): DiffFile {
  const path = wirePath(b.plus ?? b.renameTo ?? b.minus ?? b.header ?? '');
  const oldPath = b.renameFrom !== undefined ? wirePath(b.renameFrom) : undefined;
  const kind: DiffFile['kind'] = b.binary
    ? 'binary'
    : b.isNew
      ? 'added'
      : b.isDeleted
        ? 'deleted'
        : oldPath !== undefined
          ? 'renamed'
          : 'modified';
  return {
    path,
    ...(oldPath !== undefined && oldPath !== path ? { oldPath } : {}),
    kind,
    added: b.added,
    removed: b.removed,
    lines: b.lines,
    clipped: b.clipped,
  };
}

/**
 * `git diff` output (unified, a/ and b/ prefixes) as files: kinds from the headers (`new file
 * mode`, `deleted file mode`, `rename from/to`, `Binary files … differ`), at most `maxLines`
 * content lines per file (`clipped` counts the rest), each line clipped to `maxLineChars` plus
 * "…" and stripped of escapes, controls and bidi characters. `added` and `removed` count every
 * +/- line seen. Lines outside any file are ignored.
 */
export function parseUnified(text: string, o: ParseOptions): DiffFile[] {
  const files: DiffFile[] = [];
  let b: Building | null = null;
  const push = (kind: DiffLineKind, raw: string) => {
    if (!b) return;
    if (kind !== 'hunk') b.content++;
    if (b.content > o.maxLines) {
      if (kind !== 'hunk') b.clipped++;
      return;
    }
    // A hunk header with no room for any of its lines is left out.
    if (kind === 'hunk' && b.content >= o.maxLines) return;
    b.lines.push([kind, clipLine(raw, o.maxLineChars)]);
  };
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      if (b) files.push(finish(b));
      b = {
        header: headerPath(line.slice('diff --git '.length)),
        minus: undefined,
        plus: undefined,
        renameFrom: undefined,
        renameTo: undefined,
        isNew: false,
        isDeleted: false,
        binary: false,
        inHunk: false,
        added: 0,
        removed: 0,
        content: 0,
        clipped: 0,
        lines: [],
      };
      continue;
    }
    if (!b) continue;
    if (line.startsWith('@@')) {
      b.inHunk = true;
      push('hunk', line);
    } else if (b.inHunk) {
      const c = line[0];
      if (c === '+') {
        b.added++;
        push('add', line.slice(1));
      } else if (c === '-') {
        b.removed++;
        push('del', line.slice(1));
      } else if (c === ' ') push('ctx', line.slice(1));
      // `\ No newline at end of file` and anything else: not content.
    } else if (line.startsWith('new file mode ')) b.isNew = true;
    else if (line.startsWith('deleted file mode ')) b.isDeleted = true;
    else if (line.startsWith('rename from ')) b.renameFrom = readPath(line.slice(12));
    else if (line.startsWith('rename to ')) b.renameTo = readPath(line.slice(10));
    else if (line.startsWith('Binary files ') && line.endsWith(' differ')) b.binary = true;
    else if (line.startsWith('--- ')) b.minus = sidePath(line.slice(4), 'a/');
    else if (line.startsWith('+++ ')) b.plus = sidePath(line.slice(4), 'b/');
  }
  if (b) files.push(finish(b));
  return files;
}

/**
 * An untracked file as an added diff, read with phase 3's safety rules: inside the worktree with
 * no symlink followed (a link, or a path through one that leads outside, is kind `link` and never
 * read), at most 1 MiB, a NUL in the first 8 KiB is `binary`; otherwise one hunk
 * `@@ -0,0 +1,N @@` of `add` lines, capped and clipped like parseUnified. Something that is not a
 * plain file is `binary`; a file that vanished has no lines.
 */
export async function untrackedDiff(root: string, rel: string, o: ParseOptions): Promise<DiffFile> {
  const real = await realpath(root).catch(() => resolve(root));
  const path = wirePath(rel);
  const none = (kind: DiffFile['kind']): DiffFile => ({
    path,
    kind,
    added: 0,
    removed: 0,
    lines: [],
    clipped: 0,
  });
  const r = await readUntracked(real, rel);
  if (!('data' in r)) {
    if (r.skip === 'link') return none('link');
    if (r.skip === 'gone') return none('untracked');
    return none('binary');
  }
  if (looksBinary(r.data)) return none('binary');
  const text = r.data.toString('utf8');
  const all = text.split('\n');
  if (all.at(-1) === '') all.pop();
  const n = all.length;
  if (n === 0) return none('untracked');
  const kept = Math.min(n, Math.max(0, o.maxLines));
  const lines: [DiffLineKind, string][] =
    kept > 0 ? [['hunk', n === 1 ? '@@ -0,0 +1 @@' : `@@ -0,0 +1,${n} @@`]] : [];
  for (let i = 0; i < kept; i++) lines.push(['add', clipLine(all[i] as string, o.maxLineChars)]);
  return { path, kind: 'untracked', added: n, removed: 0, lines, clipped: n - kept };
}

/**
 * Where a page starting at `from` ends: files are taken while the running weight stays within
 * `max`; a file weighs min(added + removed, max) plus 1. A page always holds at least one file.
 */
export function pageEnd(changes: readonly Change[], from: number, max: number): number {
  let weight = 0;
  let i = from;
  while (i < changes.length) {
    const c = changes[i] as Change;
    const w = Math.min(c.added + c.removed, max) + 1;
    if (i > from && weight + w > max) break;
    weight += w;
    i++;
  }
  return i;
}

/** Pathspec characters per git call: well inside Windows' 32,767-character command line. */
const ARGV_BUDGET = 16_000;
/** Longest one page's git diff may take. */
const DIFF_TIMEOUT_MS = 30_000;

const contentCount = (f: DiffFile): number => f.lines.filter(([k]) => k !== 'hunk').length;

/** Keeps at most `budget` content lines; the rest count in `clipped`. */
function capTo(f: DiffFile, budget: number): DiffFile {
  const have = contentCount(f);
  if (have <= budget) return f;
  const lines: [DiffLineKind, string][] = [];
  let n = 0;
  for (const l of f.lines) {
    if (l[0] !== 'hunk') {
      if (n >= budget) break;
      n++;
    } else if (n >= budget) break;
    lines.push(l);
  }
  if (lines.at(-1)?.[0] === 'hunk') lines.pop();
  return { ...f, lines, clipped: f.clipped + (have - n) };
}

/**
 * The tracked files' diffs, keyed by wire path: one git call per batch of pathspecs (normally
 * one per page), sharing LIMITS.diffBytes. `cut` holds the paths whose text the byte cap left
 * out (or cut short: `partial`).
 */
async function trackedDiffs(
  worktree: string,
  mb: string,
  tracked: readonly Change[],
  o: ParseOptions,
  stream: typeof gitStream,
): Promise<{ files: Map<string, DiffFile>; cut: Set<string>; partial: Set<string> }> {
  const files = new Map<string, DiffFile>();
  const cut = new Set<string>();
  const partial = new Set<string>();
  const batches: Change[][] = [];
  let size = 0;
  for (const c of tracked) {
    const len = c.path.length + (c.oldPath?.length ?? 0) + 24;
    const last = batches.at(-1);
    if (!last || size + len > ARGV_BUDGET) {
      batches.push([c]);
      size = len;
    } else {
      last.push(c);
      size += len;
    }
  }
  let bytes = LIMITS.diffBytes;
  let clipped = false;
  for (const batch of batches) {
    if (clipped || bytes <= 0) {
      for (const c of batch) cut.add(wirePath(c.path));
      continue;
    }
    const specs = batch.flatMap((c) => [
      `:(literal)${c.path}`,
      ...(c.oldPath !== undefined ? [`:(literal)${c.oldPath}`] : []),
    ]);
    const r = await stream(
      [
        // Headers in one form: unusual paths C-quoted, a/ and b/ prefixes, whatever the config.
        '-c',
        'core.quotePath=true',
        'diff',
        mb,
        '-M',
        '--relative',
        '--no-ext-diff',
        '--no-textconv',
        '--no-color',
        '--ignore-submodules=none',
        '--src-prefix=a/',
        '--dst-prefix=b/',
        '-U3',
        '--',
        ...specs,
      ],
      { cwd: worktree, maxBytes: bytes, timeoutMs: DIFF_TIMEOUT_MS },
    );
    bytes -= Buffer.byteLength(r.stdout, 'utf8');
    // A clip cuts mid-line: the partial last line is dropped.
    const text = r.clipped ? r.stdout.slice(0, r.stdout.lastIndexOf('\n') + 1) : r.stdout;
    const parsed = parseUnified(text, o);
    for (const f of parsed) files.set(f.path, f);
    if (r.clipped) {
      clipped = true;
      const last = parsed.at(-1);
      if (last) partial.add(last.path);
      for (const c of batch) if (!files.has(wirePath(c.path))) cut.add(wirePath(c.path));
    }
  }
  return { files, cut, partial };
}

/**
 * One page of the branch's diff, in the same form as the file list (spec §5.7, amended):
 * `listChanges` is the one source, so the page holds the list's paths in the list's order,
 * starting at index `from`. Tracked files come from `git diff <merge base>` with no external
 * diff, textconv or colour (fsmonitor is off through gitArgs); untracked ones from
 * untrackedDiff. A page holds at most LIMITS.diffLines content lines in all and at most
 * LIMITS.diffBytes of git output; what doesn't fit counts in each file's `clipped`. `base` is
 * null when there was no base to compare with (HEAD was used).
 */
export async function diffPage(
  t: { worktree: string; base: string | null; branch: string },
  from: number,
  deps: { exec?: GitExec; stream?: typeof gitStream } = {},
): Promise<DiffPage> {
  const { mb, changes } = await listChanges(t.worktree, t.base, deps.exec ?? gitExec);
  const head = {
    base: mb === 'HEAD' ? null : t.base,
    branch: t.branch,
    from,
    filesTotal: changes.length,
  };
  if (from >= changes.length) return { ...head, next: null, files: [] };
  const end = pageEnd(changes, from, LIMITS.diffLines);
  const page = changes.slice(from, end);
  const o = { maxLines: LIMITS.diffLines, maxLineChars: LIMITS.diffLineChars };
  const tracked = await trackedDiffs(
    t.worktree,
    mb,
    page.filter((c) => !c.untracked),
    o,
    deps.stream ?? gitStream,
  );
  const root = await realpath(t.worktree).catch(() => resolve(t.worktree));
  let budget = LIMITS.diffLines;
  const files: DiffFile[] = [];
  for (const c of page) {
    const path = wirePath(c.path);
    const total = c.added + c.removed;
    let f: DiffFile;
    if (c.untracked) {
      f =
        budget > 0
          ? await untrackedDiff(root, c.path, { ...o, maxLines: budget })
          : {
              path,
              kind: 'untracked',
              added: c.added,
              removed: 0,
              lines: [],
              clipped: Math.max(1, c.added),
            };
    } else {
      const got = tracked.files.get(path);
      const kind: DiffFile['kind'] = c.oldPath !== undefined ? 'renamed' : 'modified';
      f = got ?? { path, kind, added: 0, removed: 0, lines: [], clipped: 0 };
      // The list's names and counts, so the diff and the right column agree.
      f = { ...f, path, added: c.added, removed: c.removed };
      if (c.oldPath !== undefined) f.oldPath = wirePath(c.oldPath);
      if (tracked.cut.has(path)) f.clipped = Math.max(1, total);
      else if (tracked.partial.has(path)) {
        f.clipped = Math.max(f.clipped, total - contentCount(f), 1);
      }
      f = capTo(f, budget);
    }
    budget -= contentCount(f);
    files.push(f);
  }
  return { ...head, next: end < changes.length ? end : null, files };
}

/** A diff request that can't be answered: 404 (no such session) or 422 (git or the folder). */
export class DiffError extends Error {
  readonly status: 404 | 422;
  constructor(status: 404 | 422, message: string) {
    super(message);
    this.status = status;
  }
}

/** What the diff needs to know about a session (LiveSource's previewTarget fits). */
export interface DiffTarget {
  worktree: string;
  base: string | null;
  branch: string | null;
}

export interface DiffServiceDeps {
  /** A record's worktree and base, or an external window's pane folder with a null base; null when unknown. */
  target: (id: string) => DiffTarget | null;
  /** Tests replace the diff itself. */
  page?: typeof diffPage;
  /** Diffs at a time server-wide (default 2). */
  maxRunning?: number;
}

/**
 * GET /api/sessions/:id/diff: one diff at a time per session (a second request waits for the
 * first) and two at a time server-wide. External sessions diff their pane's folder with a null
 * base, as their file list does; an ended record diffs its worktree while the folder exists.
 */
export class DiffService {
  readonly #d: DiffServiceDeps;
  readonly #max: number;
  readonly #tails = new Map<string, Promise<void>>();
  #running = 0;
  readonly #waiting: (() => void)[] = [];

  constructor(d: DiffServiceDeps) {
    this.#d = d;
    this.#max = d.maxRunning ?? 2;
  }

  async page(id: string, from: number): Promise<DiffPage> {
    if (!this.#d.target(id)) throw new DiffError(404, `No session with id ${id}`);
    const prev = this.#tails.get(id) ?? Promise.resolve();
    let release = () => {};
    const mine = new Promise<void>((r) => {
      release = r;
    });
    const tail = prev.then(() => mine);
    this.#tails.set(id, tail);
    try {
      await prev;
      await this.#acquire();
      try {
        return await this.#run(id, from);
      } finally {
        this.#release();
      }
    } finally {
      release();
      if (this.#tails.get(id) === tail) this.#tails.delete(id);
    }
  }

  async #acquire(): Promise<void> {
    if (this.#running < this.#max) {
      this.#running++;
      return;
    }
    // The slot passes straight from the releaser: #running stays counted.
    await new Promise<void>((r) => this.#waiting.push(r));
  }

  #release(): void {
    const next = this.#waiting.shift();
    if (next) next();
    else this.#running--;
  }

  async #run(id: string, from: number): Promise<DiffPage> {
    // Read again after the wait: the session may have gone meanwhile.
    const t = this.#d.target(id);
    if (!t) throw new DiffError(404, `No session with id ${id}`);
    const isDir = await stat(t.worktree).then(
      (s) => s.isDirectory(),
      () => false,
    );
    if (!isDir) throw new DiffError(422, "git couldn't show the diff: the folder is gone.");
    try {
      return await (this.#d.page ?? diffPage)(
        { worktree: t.worktree, base: t.base, branch: t.branch ?? '' },
        from,
      );
    } catch (err) {
      throw new DiffError(422, `git couldn't show the diff: ${plainLine(firstLine(err), 300)}`);
    }
  }
}
