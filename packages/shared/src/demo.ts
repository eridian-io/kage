import type { DisplayLine, FileChange, Port, Question, Session, SessionStatus } from './types.ts';

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

interface Seed {
  id: string;
  status: SessionStatus;
  pinned?: boolean;
  project: string;
  task: string;
  branch: string;
  worktree: string;
  since: number;
  age: number;
  unpushed?: number;
  question?: Question;
  lines: DisplayLine[];
  ports: Port[];
  files: FileChange[];
}

const port = (n: number, process: string): Port => ({ port: n, process, localOnly: false });
const file = (path: string, added: number, removed: number): FileChange => ({
  path,
  added,
  removed,
});

const SEEDS: Seed[] = [
  {
    id: 'web',
    status: 'needs-you',
    project: 'web',
    task: 'dark mode',
    branch: 'feat/dark-mode',
    worktree: '~/projects/web/.worktrees/dark-mode',
    since: 4 * MIN,
    age: 18 * MIN,
    lines: [
      { kind: 'tool', text: 'Read', detail: 'src/styles/theme.css (310 lines)' },
      { kind: 'tool', text: 'Search', detail: '"#[0-9a-f]{6}" in src/ · 41 matches' },
      {
        kind: 'say',
        text: 'The app has 41 hard-coded colours. There are two ways to add dark mode:',
      },
      { kind: 'out', text: '1. CSS variables in theme.css (no new dependency)' },
      { kind: 'out', text: '2. Tailwind’s dark: variant (needs a Tailwind config)' },
    ],
    question: { text: 'Which approach should I use?', options: ['CSS variables', 'Tailwind'] },
    ports: [port(5173, 'vite')],
    files: [file('src/styles/theme.css', 0, 0)],
  },
  {
    id: 'shop',
    status: 'running',
    project: 'shop-api',
    task: 'fix login bug',
    branch: 'fix/login',
    worktree: '~/projects/shop-api/.worktrees/fix-login',
    since: 12 * MIN,
    age: 12 * MIN,
    lines: [
      { kind: 'tool', text: 'Read', detail: 'src/auth/session.ts (142 lines)' },
      {
        kind: 'say',
        text: 'Found it: isExpired() compares seconds with milliseconds, so every token looks expired after a refresh.',
      },
      { kind: 'tool', text: 'Update', detail: 'src/auth/session.ts' },
      { kind: 'del', text: 'if (token.exp < Date.now()) {' },
      { kind: 'add', text: 'if (token.exp * 1000 < Date.now()) {' },
      { kind: 'tool', text: 'Bash', detail: 'npm test -- auth' },
      { kind: 'out', text: 'PASS test/auth.test.ts (14 tests)' },
      { kind: 'out', text: 'PASS test/session.test.ts (6 tests)' },
      { kind: 'think', text: 'Writing a regression test for the refresh case… (38s)' },
    ],
    ports: [port(3000, 'node')],
    files: [file('src/auth/session.ts', 1, 1), file('test/session.test.ts', 24, 0)],
  },
  {
    id: 'infra',
    status: 'running',
    project: 'infra',
    task: 'node 24',
    branch: 'chore/node-24',
    worktree: '~/projects/infra/.worktrees/node-24',
    since: 3 * MIN,
    age: 3 * MIN,
    lines: [
      { kind: 'tool', text: 'Update', detail: '.nvmrc, Dockerfile, package.json' },
      { kind: 'tool', text: 'Bash', detail: 'pnpm install --frozen-lockfile' },
      { kind: 'out', text: 'Progress: resolved 812, reused 790, downloaded 22' },
      { kind: 'think', text: 'Installing dependencies… (1m 12s)' },
    ],
    ports: [],
    files: [file('.nvmrc', 1, 1), file('Dockerfile', 2, 2), file('package.json', 1, 1)],
  },
  {
    id: 'rate',
    status: 'done',
    pinned: true,
    project: 'shop-api',
    task: 'rate limit v1',
    branch: 'feat/rate-limit',
    worktree: '~/projects/shop-api/.worktrees/rate-limit',
    since: 2 * DAY,
    age: 2 * DAY,
    lines: [
      {
        kind: 'say',
        text: 'Added a sliding-window rate limiter to /login and /reset (5 attempts per minute per IP), with tests.',
      },
      { kind: 'say', text: 'Done. PR #57 is merged.' },
    ],
    ports: [],
    files: [file('src/middleware/rateLimit.ts', 86, 0), file('test/rateLimit.test.ts', 64, 0)],
  },
  {
    id: 'footer',
    status: 'done',
    project: 'web',
    task: 'fix footer links',
    branch: 'fix/footer',
    worktree: '~/projects/web/.worktrees/footer',
    since: 3 * HOUR,
    age: 3 * HOUR,
    lines: [
      { kind: 'say', text: 'Fixed 6 footer links that pointed at the old /help pages.' },
      { kind: 'say', text: 'Done. Opened PR #212.' },
    ],
    ports: [],
    files: [file('src/components/Footer.tsx', 6, 6)],
  },
  {
    id: 'docs',
    status: 'done',
    project: 'docs',
    task: 'update README',
    branch: 'docs/readme',
    worktree: '~/projects/docs/.worktrees/readme',
    since: 1 * HOUR,
    age: 1 * HOUR,
    unpushed: 1,
    lines: [
      {
        kind: 'say',
        text: 'Updated README.md: install steps for Node 24, a configuration table and a troubleshooting section.',
      },
      { kind: 'say', text: 'Done. 1 commit is not pushed yet.' },
    ],
    ports: [port(4000, 'docs')],
    files: [file('README.md', 48, 12)],
  },
];

/** The design target's sample sessions (invented data), relative to `now`. */
export function demoSessions(now: number): Session[] {
  return SEEDS.map((seed) => ({
    id: seed.id,
    status: seed.status,
    project: seed.project,
    task: seed.task,
    branch: seed.branch,
    worktree: seed.worktree,
    startedAt: now - seed.age,
    statusSince: now - seed.since,
    pinned: seed.pinned ?? false,
    archived: false,
    external: false,
    unpushed: seed.unpushed ?? 0,
    uncommitted: 0,
    ...(seed.question ? { question: seed.question } : {}),
    lines: seed.lines.map((l) => ({ ...l })),
    ports: seed.ports.map((p) => ({ ...p })),
    files: seed.files.map((f) => ({ ...f })),
    filesTotal: seed.files.length,
  }));
}
