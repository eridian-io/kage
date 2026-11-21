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
  lines: DisplayLine[];
  ports: Port[];
  files: FileChange[];
}
export type ServerEvent =
  | { type: 'snapshot'; host: string; sessions: Session[] }
  | { type: 'session.updated'; session: Session }
  | { type: 'session.removed'; id: string };
