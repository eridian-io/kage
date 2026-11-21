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
}
export type ServerEvent =
  | { type: 'snapshot'; host: string; streamId: string; projectsRoot: string; sessions: Session[] }
  | { type: 'session.updated'; session: Session }
  | { type: 'session.lines'; id: string; lines: DisplayLine[]; reset: boolean }
  | { type: 'session.removed'; id: string }
  | { type: 'session.ports'; id: string; ports: Port[] }
  | { type: 'session.files'; id: string; files: FileChange[]; filesTotal: number };

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
} as const;
