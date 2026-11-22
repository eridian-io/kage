/**
 * What `kage doctor` checks (phase 6, Task 4), in two groups: what Kage needs from this machine
 * (requirementChecks) and how this installation runs (installChecks). Every check says what it
 * found; a warning or a failure also says what to do.
 *
 * The checks only look: version probes (`tmux -V`, `git --version`, `claude --version`),
 * `tailscale status --json`, the service manager's state, the package manager's presence, the hook
 * socket and one request to Kage's own address (R105). Nothing is installed or started, nothing
 * runs as root, and Claude's credentials file is only checked for existence (host-integration
 * §7.6). Install hints are printed, never run.
 */
import { constants } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { ConfigError, configPath, displayPath, type KageConfig, loadConfig } from '../config.ts';
import { socketPath } from '../hooks/cli.ts';
import type { ServerStatus } from '../hooks/server.ts';
import { SETTINGS_FILE } from '../hooks/settings.ts';
import { stateDir } from '../state/store.ts';
import { parseTmuxVersion } from '../tmux/client.ts';
import type { Run, RunResult } from './run.ts';
import type { RunMode } from './runtime.ts';
import type { ServiceManager, ServiceState } from './service.ts';

export type CheckLevel = 'ok' | 'warn' | 'fail';
export type CheckId =
  | 'platform'
  | 'user'
  | 'tmux'
  | 'git'
  | 'claude'
  | 'claude-login'
  | 'tailscale'
  | 'config'
  | 'projects'
  | 'service'
  | 'service-path'
  | 'server'
  | 'install-path';
export interface Check {
  id: CheckId;
  level: CheckLevel;
  label: string;
  /** What to do, for a warning or a failure; null when the label says it, or for ok. */
  fix: string | null;
}
export type PackageManager = 'apt' | 'dnf' | 'pacman' | 'brew';
export interface CheckDeps {
  run: Run;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  uid: number | undefined;
  home: string;
  mode: RunMode;
  manager: ServiceManager | null;
  status: (socket: string) => Promise<ServerStatus | null>;
  fetch: typeof fetch;
}

const MIN_GIT: [number, number] = [2, 40];
const SERVICE_TOOLS = ['tmux', 'git', 'claude', 'tailscale'] as const;
/** How long the one request to Kage's own address may take. */
const SERVER_TIMEOUT_MS = 3000;

const ok = (id: CheckId, label: string): Check => ({ id, level: 'ok', label, fix: null });
const warn = (id: CheckId, label: string, fix: string | null = null): Check => ({
  id,
  level: 'warn',
  label,
  fix,
});
const fail = (id: CheckId, label: string, fix: string | null = null): Check => ({
  id,
  level: 'fail',
  label,
  fix,
});

/** The first "major.minor" in a version line: "git version 2.43.0" → [2, 43]. */
export function parseVersion(text: string): [major: number, minor: number] | null {
  const m = /(\d+)\.(\d+)/.exec(text);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** The version word itself: "git version 2.43.0" → "2.43.0". */
function versionWord(text: string): string | null {
  return /\d+\.\d+(?:\.\d+)*[a-z]?/.exec(text)?.[0] ?? null;
}

const answered = (r: RunResult) => !r.missing && r.code === 0;

/** apt, dnf or pacman on Linux (in that order), brew on macOS; null if none is there. */
export async function detectPackageManager(
  run: Run,
  platform: NodeJS.Platform,
): Promise<PackageManager | null> {
  const candidates: [string, PackageManager][] =
    platform === 'linux'
      ? [
          ['apt-get', 'apt'],
          ['dnf', 'dnf'],
          ['pacman', 'pacman'],
        ]
      : platform === 'darwin'
        ? [['brew', 'brew']]
        : [];
  for (const [cmd, pm] of candidates) {
    if (!(await run(cmd, ['--version'])).missing) return pm;
  }
  return null;
}

/** The command that installs a tool here, for the user to run; never run by Kage. */
export function installHint(
  tool: 'tmux' | 'git' | 'claude' | 'tailscale',
  platform: NodeJS.Platform,
  pm: PackageManager | null,
): string {
  switch (tool) {
    case 'claude':
      return 'curl -fsSL https://claude.ai/install.sh | bash';
    case 'tailscale':
      if (platform === 'darwin') {
        return pm === 'brew'
          ? 'brew install --cask tailscale'
          : 'Install the Tailscale app from tailscale.com, then sign in.';
      }
      return 'curl -fsSL https://tailscale.com/install.sh | sh\nThen: sudo tailscale up';
    case 'tmux':
    case 'git':
      switch (pm) {
        case 'apt':
          return `sudo apt install ${tool}`;
        case 'dnf':
          return `sudo dnf install ${tool}`;
        case 'pacman':
          return `sudo pacman -S ${tool}`;
        case 'brew':
          return `brew install ${tool}`;
        case null:
          return tool === 'tmux' ? 'Install tmux 3.2 or newer.' : 'Install git 2.40 or newer.';
      }
  }
}

/** "✓ <label>", "! <label>" or "✗ <label>", then each line of the fix, indented. */
export function formatChecks(checks: Check[]): string[] {
  const mark: Record<CheckLevel, string> = { ok: '✓', warn: '!', fail: '✗' };
  return checks.flatMap((c) => [
    `${mark[c.level]} ${c.label}`,
    ...(c.level !== 'ok' && c.fix ? c.fix.split('\n').map((l) => `  ${l}`) : []),
  ]);
}

// --- requirements ----------------------------------------------------------------------------

/**
 * platform, user, tmux, git, claude, claude-login, tailscale. On Windows only the platform check
 * runs: nothing else there would mean anything.
 */
export async function requirementChecks(d: CheckDeps): Promise<Check[]> {
  if (d.platform !== 'linux' && d.platform !== 'darwin') {
    return [fail('platform', 'Kage runs on Linux or macOS. On Windows, install it inside WSL.')];
  }
  const checks: Check[] = [ok('platform', d.platform === 'darwin' ? 'macOS' : 'Linux')];
  checks.push(
    d.uid === 0
      ? fail('user', 'Run Kage as your own user, not root.')
      : ok('user', `Running as your own user (uid ${d.uid ?? '?'})`),
  );

  // The package manager is looked up once, and only when a hint needs it.
  let pm: Promise<PackageManager | null> | null = null;
  const hint = (tool: 'tmux' | 'git' | 'claude' | 'tailscale') => {
    pm ??= detectPackageManager(d.run, d.platform);
    return pm.then((p) => installHint(tool, d.platform, p));
  };

  const tmux = await d.run('tmux', ['-V']);
  if (!answered(tmux)) {
    checks.push(fail('tmux', "tmux isn't installed.", await hint('tmux')));
  } else {
    const { version, tooOld } = parseTmuxVersion(tmux.stdout);
    checks.push(
      tooOld
        ? fail('tmux', `tmux ${version} is too old: Kage needs 3.2 or newer.`, await hint('tmux'))
        : ok('tmux', `tmux ${version}`),
    );
  }

  const git = await d.run('git', ['--version']);
  if (!answered(git)) {
    checks.push(fail('git', "git isn't installed.", await hint('git')));
  } else {
    const v = parseVersion(git.stdout);
    const word = versionWord(git.stdout) ?? git.stdout.trim();
    const tooOld = v !== null && (v[0] < MIN_GIT[0] || (v[0] === MIN_GIT[0] && v[1] < MIN_GIT[1]));
    checks.push(
      tooOld
        ? fail('git', `git ${word} is too old: Kage needs 2.40 or newer.`, await hint('git'))
        : ok('git', `git ${word}`),
    );
  }

  // Local only: `claude --version` makes no network call (host-integration §7.6).
  const claude = await d.run(d.env.KAGE_CLAUDE_BIN || 'claude', ['--version']);
  checks.push(
    answered(claude)
      ? ok('claude', `Claude Code ${versionWord(claude.stdout) ?? claude.stdout.trim()}`)
      : fail('claude', "Claude Code isn't installed.", await hint('claude')),
  );

  checks.push(await claudeLogin(d));
  checks.push(await tailscaleCheck(d, hint));
  return checks;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Existence only: the credentials file is never opened (R25, host-integration §7.6). */
async function claudeLogin(d: CheckDeps): Promise<Check> {
  if (d.platform === 'darwin') {
    return warn(
      'claude-login',
      "Kage can't tell whether Claude Code is signed in on macOS. Run claude once to check.",
    );
  }
  const dirs = [join(d.home, '.claude')];
  if (d.env.CLAUDE_CONFIG_DIR) dirs.unshift(d.env.CLAUDE_CONFIG_DIR);
  let signedIn = Boolean(d.env.ANTHROPIC_API_KEY);
  for (const dir of dirs) {
    if (!signedIn && (await exists(join(dir, '.credentials.json')))) signedIn = true;
  }
  return signedIn
    ? ok('claude-login', 'Claude Code is signed in.')
    : warn('claude-login', 'Claude Code may not be signed in. Run claude once and sign in.');
}

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

async function tailscaleCheck(
  d: CheckDeps,
  hint: (tool: 'tailscale') => Promise<string>,
): Promise<Check> {
  const r = await d.run('tailscale', ['status', '--json']);
  if (r.missing) return fail('tailscale', "Tailscale isn't installed.", await hint('tailscale'));
  let name: string | null = null;
  try {
    // A stopped Tailscale still prints its status (and may exit non-zero).
    const data = JSON.parse(r.stdout) as {
      BackendState?: unknown;
      Self?: { DNSName?: unknown; TailscaleIPs?: unknown };
    } | null;
    const ips = Array.isArray(data?.Self?.TailscaleIPs) ? data.Self.TailscaleIPs : [];
    const v4 = ips.find((ip): ip is string => typeof ip === 'string' && IPV4.test(ip));
    if (data?.BackendState === 'Running' && v4) {
      const dns = data.Self?.DNSName;
      name = typeof dns === 'string' && dns !== '' ? dns.replace(/\.$/, '') : v4;
    }
  } catch {
    // not JSON: not up
  }
  if (name !== null) return ok('tailscale', `Tailscale is up (${name}).`);
  return fail(
    'tailscale',
    "Tailscale isn't up.",
    d.platform === 'darwin' ? 'Open the Tailscale app and sign in.' : 'sudo tailscale up',
  );
}

// --- this installation -----------------------------------------------------------------------

/** config, projects, service, service-path, server, install-path. */
export async function installChecks(d: CheckDeps): Promise<Check[]> {
  const checks: Check[] = [];
  const cfgFile = configPath(d.env);
  const cfgShown = displayPath(cfgFile, d.home);

  let cfg: KageConfig | null = null;
  try {
    cfg = await loadConfig({ env: d.env, path: cfgFile });
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    checks.push(
      fail(
        'config',
        `Config error: ${err.message}`,
        `Fix ${cfgShown}, then run kage doctor again.`,
      ),
    );
  }
  const cfgCheck = cfg === null ? null : await configCheck(cfg, cfgFile, cfgShown);
  if (cfgCheck !== null) checks.push(cfgCheck);

  // Without a config file setup comes first, and it asks for the projects folder.
  if (cfg !== null && cfgCheck?.label !== NO_CONFIG) {
    const shown = displayPath(cfg.projectsRoot, d.home);
    const isDir = await stat(cfg.projectsRoot).then(
      (s) => s.isDirectory(),
      () => false,
    );
    checks.push(
      isDir
        ? ok('projects', `Projects in ${shown}`)
        : fail(
            'projects',
            `The projects folder ${shown} doesn't exist.`,
            `Create it, or set projectsRoot in ${cfgShown}.`,
          ),
    );
  }

  const service = await serviceChecks(d);
  checks.push(...service.checks);
  checks.push(await serverCheck(d, service.installed));
  checks.push(...(await installPathChecks(d)));
  return checks;
}

const NO_CONFIG = 'No config yet. Run kage setup.';

async function configCheck(cfg: KageConfig, file: string, shown: string): Promise<Check> {
  let mode: number;
  try {
    mode = (await stat(file)).mode;
  } catch {
    return warn('config', NO_CONFIG);
  }
  // Windows has no such modes; everywhere else a secret must stay the owner's (0600).
  const secret = cfg.token !== '' || cfg.ntfyToken !== '';
  if (process.platform !== 'win32' && secret && (mode & 0o077) !== 0) {
    return fail('config', `${shown} can be read by other users. Run chmod 600 ${shown}.`);
  }
  return ok('config', `Config at ${shown}`);
}

/** The first executable `name` in a PATH value's absolute folders; null if none. */
async function findOnPath(name: string, pathVar: string): Promise<string | null> {
  for (const dir of pathVar.split(delimiter)) {
    if (dir === '' || !isAbsolute(dir)) continue;
    const candidate = join(dir, name);
    try {
      if ((await stat(candidate)).isFile()) {
        await access(candidate, constants.X_OK);
        return candidate;
      }
    } catch {
      // not here
    }
  }
  return null;
}

function logHint(m: ServiceManager): string {
  return m.kind === 'systemd' ? 'journalctl --user -u kage -e' : '~/Library/Logs/kage.log';
}

/** The service's checks, and whether its file is installed (for the server check's advice). */
async function serviceChecks(d: CheckDeps): Promise<{ checks: Check[]; installed: boolean }> {
  const none = (checks: Check[]) => ({ checks, installed: false });
  const m = d.manager;
  if (m === null) return none([]);
  // R112: state() throws without a user manager, so ask first.
  const why = await m.unavailable();
  if (why !== null) return none([warn('service', "Kage's service can't run here.", why)]);

  // R111: 'starting' is systemd's activating, the restart loop while Tailscale has no address.
  let state: ServiceState;
  try {
    state = await m.state();
  } catch (err) {
    return none([
      warn('service', "Kage couldn't read the service's state.", (err as Error).message),
    ]);
  }
  const log = `See its log: ${logHint(m)}`;
  const checks: Check[] = [];
  switch (state) {
    case 'active':
      if (m.lingerEnabled && !(await m.lingerEnabled())) {
        checks.push(
          warn(
            'service',
            'The service is running, but it stops when you log out.',
            'To keep it running, run: loginctl enable-linger',
          ),
        );
      } else {
        checks.push(ok('service', `The service is running (${m.name}).`));
      }
      break;
    case 'starting':
      checks.push(warn('service', 'The service is starting (waiting for Tailscale?).', log));
      break;
    case 'failed':
      checks.push(warn('service', 'The service has stopped after an error.', log));
      break;
    case 'inactive':
      checks.push(
        warn(
          'service',
          "The service is installed but isn't running.",
          'Run kage setup again to start it.',
        ),
      );
      break;
    case 'missing':
      return none([
        warn('service', "The service isn't installed.", 'Run kage setup to install the service.'),
      ]);
  }

  // The service runs with the PATH setup wrote into its file, not the shell's.
  const path = (await m.pathOfInstalled()) ?? '';
  const found: Record<string, string> = {};
  for (const tool of SERVICE_TOOLS) {
    const at = await findOnPath(tool, path);
    if (at === null) {
      checks.push(
        fail(
          'service-path',
          `The service can't find ${tool} on its PATH. Run kage setup again to update it.`,
        ),
      );
    } else {
      found[tool] = at;
    }
  }
  if (Object.keys(found).length === SERVICE_TOOLS.length) {
    // F23: in WSL the PATH also holds Windows folders, so say which claude it is.
    checks.push(
      ok(
        'service-path',
        `The service finds tmux, git, claude and tailscale (claude is ${found.claude}).`,
      ),
    );
  }
  return { checks, installed: true };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

async function serverCheck(d: CheckDeps, serviceInstalled: boolean): Promise<Check> {
  const status = await d.status(socketPath(d.env, d.platform));
  if (status === null) {
    return fail(
      'server',
      "Kage isn't running.",
      d.manager && serviceInstalled
        ? `Start it with kage serve, or see the service log: ${logHint(d.manager)}`
        : 'Start it with kage serve.',
    );
  }
  let url: URL | null = null;
  try {
    url = new URL('/', status.url);
  } catch {
    // handled below
  }
  if (url === null || url.protocol !== 'http:') {
    return fail('server', `Kage answers, but its address ${status.url} isn't one Kage can serve.`);
  }
  const counts = `${plural(status.sessions, 'session', 'sessions')}, ${plural(status.needsYou, 'needs you', 'need you')}`;
  // The one request doctor makes over the network: to Kage's own address (R105, F24).
  let code: number;
  try {
    const res = await d.fetch(url.href, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(SERVER_TIMEOUT_MS),
    });
    code = res.status;
    await res.body?.cancel().catch(() => {});
  } catch {
    return warn(
      'server',
      `Kage is running, but ${status.url} doesn't answer from here.`,
      "If the board opens on your phone, all is well. If it doesn't, check Tailscale on both devices.",
    );
  }
  if (code !== 200 && code !== 401) {
    return fail(
      'server',
      `Kage is running, but ${status.url} answers HTTP ${code}.`,
      d.manager && serviceInstalled ? `See the service log: ${logHint(d.manager)}` : null,
    );
  }
  return ok(
    'server',
    `Kage ${status.version} is running at ${status.url} (pid ${status.pid}): ${counts}.`,
  );
}

/**
 * R110-5: the hooks name the program's path, so an update must not move it. A path inside a
 * versioned folder, a package store or a temporary folder may not last.
 */
const FLEETING = [
  /[\\/]v?\d+\.\d+\.\d+[^\\/]*[\\/]/, // a versions/0.6.0/ folder
  /@\d+\.\d+/, // a package store entry, kage@0.6.0
  /[\\/]_npx[\\/]/,
  /[\\/]dlx-[^\\/]*[\\/]/,
  /^\/(?:tmp|var\/tmp|private\/var\/folders|private\/tmp)\//,
];

/** True for a path in a versioned folder, a package store or a temporary folder (`tmp`: TMPDIR). */
export function mayNotLast(path: string, tmp?: string): boolean {
  if (FLEETING.some((re) => re.test(path))) return true;
  return Boolean(tmp && isAbsolute(tmp) && path.startsWith(tmp.replace(/[\\/]*$/, '/')));
}

function sameDir(a: string, b: string): boolean {
  const norm = (p: string) => resolve(p).replace(/[\\/]+$/, '');
  return norm(a) === norm(b);
}

/** The words of a command hookCommand wrote: each one single-quoted, POSIX style. */
function shellWords(command: string): string[] {
  return [...command.matchAll(/'((?:[^']|'\\'')*)'/g)].map((m) =>
    (m[1] ?? '').replaceAll(`'\\''`, "'"),
  );
}

/**
 * The Kage program the hooks settings file (Kage's own, in its state folder) runs: the SEA, or
 * the script after `node --no-warnings`. null when there is no such file yet.
 */
async function hookProgram(env: NodeJS.ProcessEnv): Promise<string | null> {
  let text: string;
  try {
    text = await readFile(join(stateDir(env), SETTINGS_FILE), 'utf8');
  } catch {
    return null;
  }
  try {
    const hooks = (JSON.parse(text) as { hooks?: Record<string, unknown> } | null)?.hooks ?? {};
    for (const entries of Object.values(hooks)) {
      const command = (entries as { hooks?: { command?: unknown }[] }[] | undefined)?.[0]
        ?.hooks?.[0]?.command;
      if (typeof command !== 'string') continue;
      const words = shellWords(command);
      return (words[1] === '--no-warnings' ? words[2] : words[0]) ?? null;
    }
  } catch {
    // not ours to judge: serve writes it again at its next start
  }
  return null;
}

async function installPathChecks(d: CheckDeps): Promise<Check[]> {
  const checks: Check[] = [];
  const program = await hookProgram(d.env);
  if (program !== null) {
    if (!(await exists(program))) {
      checks.push(
        warn(
          'install-path',
          `Claude's hooks run ${program}, which isn't there anymore.`,
          'Restart Kage so it writes them again: run kage serve, or kage setup for the service.',
        ),
      );
    } else if (mayNotLast(program, d.env.TMPDIR)) {
      checks.push(
        warn(
          'install-path',
          `Claude's hooks run ${program}, which may not stay there.`,
          'Install Kage with its install script, so the hooks name a path that lasts.',
        ),
      );
    }
  }
  if (d.mode.kind === 'sea') {
    const dir = dirname(d.mode.exe);
    const onPath = (d.env.PATH ?? '').split(delimiter).some((p) => p !== '' && sameDir(p, dir));
    checks.push(
      onPath
        ? ok('install-path', `${dir} is on your PATH`)
        : warn(
            'install-path',
            `${dir} isn't on your PATH.`,
            `Add ${dir} to your PATH: echo 'export PATH="${dir}:$PATH"' >> ~/.profile`,
          ),
    );
  }
  return checks;
}
