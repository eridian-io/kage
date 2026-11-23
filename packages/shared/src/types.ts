export type SessionStatus = 'needs-you' | 'running' | 'done' | 'ended';
export type LineKind = 'say' | 'tool' | 'add' | 'del' | 'out' | 'think';
/** `detail` is the tool argument. */
export interface DisplayLine {
  kind: LineKind;
  text: string;
  detail?: string;
}
export interface Question {
  text: string;
  options: string[];
  /** A Claude startup screen (R9): answered by buttons only, no typed reply. */
  startup?: boolean;
  /**
   * R39: options the board shows but must not send (1-based), e.g. a Bash prompt's "Yes, and
   * switch to auto mode" or the renderer offer's "Yes, try it". The server refuses them too.
   */
  disabledOptions?: number[];
  /**
   * R52: the text was cut at its bound (a command longer than the 500-character question); the
   * card says the full command is in the terminal.
   */
  cut?: boolean;
}
export interface Port {
  port: number;
  process: string;
  localOnly: boolean;
}
export interface FileChange {
  path: string;
  added: number;
  removed: number;
}
export interface Session {
  id: string;
  status: SessionStatus;
  project: string;
  task: string;
  branch: string;
  /** Absolute or ~-prefixed path. */
  worktree: string;
  /** Epoch ms. */
  startedAt: number;
  /** Epoch ms. */
  statusSince: number;
  pinned: boolean;
  archived: boolean;
  external: boolean;
  unpushed: number;
  /** Files with uncommitted changes, untracked ones included. */
  uncommitted: number;
  /** Ignored entries in the worktree (`.env`, `node_modules/`): delete removes them too. */
  ignored: number;
  question?: Question;
  /** The "now doing" line, e.g. "Running npm test". */
  now?: string;
  /** Always [] on the wire; lines travel in `session.lines` events. */
  lines: DisplayLine[];
  ports: Port[];
  /** At most LIMITS.files entries. */
  files: FileChange[];
  /** How many files changed in all; may exceed `files.length`. */
  filesTotal: number;
  /** Why the file list is empty though the branch may have work (Kage won't run git there). */
  filesNote?: string;
}
export type ServerEvent =
  | {
      type: 'snapshot';
      /** A token is set, so the board offers Sign out (amended 2026-11-23, hardening). */
      auth: boolean;
      host: string;
      streamId: string;
      projectsRoot: string;
      sessions: Session[];
      archived: number;
    }
  | { type: 'session.updated'; session: Session }
  | { type: 'session.lines'; id: string; lines: DisplayLine[]; reset: boolean }
  | { type: 'session.removed'; id: string }
  | { type: 'session.ports'; id: string; ports: Port[] }
  | { type: 'session.files'; id: string; files: FileChange[]; filesTotal: number; note?: string }
  /** The number of archived sessions changed. */
  | { type: 'archive'; count: number };

export interface ArchivedSession {
  id: string;
  project: string;
  task: string;
  branch: string;
  archivedAt: number;
}
/** Newest first, at most LIMITS.archived. */
export interface ArchivedResponse {
  sessions: ArchivedSession[];
}
export interface PinBody {
  pinned: boolean;
}
export interface ArchiveBody {
  archived: boolean;
}
/** What the delete confirmation showed. */
export interface DeleteBody {
  unpushed: number;
  uncommitted: number;
  ignored: number;
}
export type DiffLineKind = 'hunk' | 'ctx' | 'add' | 'del';
export interface DiffFile {
  path: string;
  oldPath?: string;
  kind: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'binary' | 'link';
  added: number;
  removed: number;
  lines: [DiffLineKind, string][];
  /** Lines of this file left out by the per-page cap. */
  clipped: number;
}
export interface DiffPage {
  base: string | null;
  branch: string;
  from: number;
  next: number | null;
  filesTotal: number;
  files: DiffFile[];
}

export const TERM_PROTOCOL = 'kage.term.v1';
/** Text frames (JSON). Output travels as binary frames. */
export type TermServerMsg =
  /** The next binary frame is the snapshot. */
  | { t: 'reset'; cols: number; rows: number; mode: 'rw' | 'ro' }
  | { t: 'size'; cols: number; rows: number };
export type TermClientMsg = { t: 'in'; d: string } | { t: 'size'; cols: number; rows: number };
export const TERM_CLOSE = {
  gone: 4404,
  ended: 4409,
  forbidden: 4403,
  tooMany: 4429,
  demo: 4501,
} as const;

export interface Project {
  name: string;
  defaultBranch: string;
  branches: string[];
}
export interface ProjectsResponse {
  projects: Project[];
  last: string | null;
}
export interface NewTaskBody {
  project: string;
  base: string;
  task: string;
  acceptEdits: boolean;
}
export interface NewTaskResponse {
  id: string;
}
export interface AnswerBody {
  option: number;
  /** R36: the question text the card showed; the server answers only that question. */
  question: string;
}
export interface ReplyBody {
  text: string;
}
export interface ApiError {
  error: string;
}

export const LIMITS = {
  taskChars: 4000,
  replyChars: 4000,
  questionChars: 500,
  textBytes: 12_000,
  files: 100,
  projects: 200,
  branches: 200,
  archived: 200,
  diffLines: 1000,
  diffBytes: 524_288,
  diffLineChars: 2000,
  termInputBytes: 65_536,
  termMinCols: 20,
  termMaxCols: 500,
  termMinRows: 5,
  termMaxRows: 200,
  terminals: 8,
  terminalsPerPane: 3,
  /** The largest count a delete confirmation can carry (unpushed, uncommitted, ignored). */
  deleteCount: 1_000_000,
  /** A ping's and a browser notification's text, in characters (N2): NTFY.messageChars on the server. */
  pingChars: 100,
} as const;
