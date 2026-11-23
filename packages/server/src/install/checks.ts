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
import { tailscaleCommand } from '../tailscale.ts';
import { parseTmuxVersion } from '../tmux/client.ts';
import { pathAdvice, pathRcFiles } from './path-rc.ts';
import type { Run, RunResult } from './run.ts';
import { checkoutOf, type RunMode } from './runtime.ts';
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
  | 'token'
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
/** The version probes and tailscale status: local, so 5 s is plenty. */
const PROBE = { timeoutMs: 5000 };
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
    if (!(await run(cmd, ['--version'], PROBE)).missing) return pm;
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

  const tmux = await d.run('tmux', ['-V'], PROBE);
  if (tmux.missing) {
    checks.push(fail('tmux', "tmux isn't installed.", await hint('tmux')));
  } else if (!answered(tmux)) {
    checks.push(silent('tmux', ['tmux', '-V']));
  } else {
    const { version, tooOld } = parseTmuxVersion(tmux.stdout);
    checks.push(
      tooOld
        ? fail('tmux', `tmux ${version} is too old: Kage needs 3.2 or newer.`, await hint('tmux'))
        : ok('tmux', `tmux ${version}`),
    );
  }

  const git = await d.run('git', ['--version'], PROBE);
  if (git.missing) {
    checks.push(fail('git', "git isn't installed.", await hint('git')));
  } else if (!answered(git)) {
    checks.push(silent('git', ['git', '--version']));
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
  const claudeBin = d.env.KAGE_CLAUDE_BIN || 'claude';
  const claude = await d.run(claudeBin, ['--version'], PROBE);
  if (claude.missing) {
    checks.push(fail('claude', "Claude Code isn't installed.", await hint('claude')));
  } else if (!answered(claude)) {
    checks.push(silent('claude', [claudeBin, '--version']));
  } else {
    checks.push(ok('claude', `Claude Code ${versionWord(claude.stdout) ?? claude.stdout.trim()}`));
  }

  checks.push(await claudeLogin(d));
  checks.push(await tailscaleCheck(d, hint));
  return checks;
}

/**
 * A program that is there but timed out or exited non-zero: not "isn't installed", which would
 * send the user to reinstall something that is installed.
 */
function silent(id: CheckId, cmd: string[]): Check {
  const line = cmd.join(' ');
  return fail(id, `${line} didn't answer.`, `Run ${line} yourself to see what's wrong.`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Existence only: the credentials file is never opened (R25, host-integration §7.6). An
 * ANTHROPIC_API_KEY in this shell doesn't reach an installed service, which gets no secrets
 * (R124), so then Claude in Kage's windows needs its own sign-in: the credentials file, when it
 * is there, is that sign-in (R125), and only without it does doctor warn. The key is never read
 * beyond "is it set", and never written anywhere.
 */
async function claudeLogin(d: CheckDeps): Promise<Check> {
  // Claude keeps its files in CLAUDE_CONFIG_DIR when that is set, else in ~/.claude.
  const dir = d.env.CLAUDE_CONFIG_DIR || join(d.home, '.claude');
  const credentials = () => exists(join(dir, '.credentials.json'));
  if (d.env.ANTHROPIC_API_KEY && d.manager !== null && (await exists(d.manager.file))) {
    if (await credentials()) return ok('claude-login', 'Claude Code is signed in.');
    return warn(
      'claude-login',
      "ANTHROPIC_API_KEY is set in this shell, but Kage's service doesn't get it.",
      "Claude in Kage's windows needs its own sign-in. Run claude once and sign in.",
    );
  }
  if (d.platform === 'darwin') {
    return warn(
      'claude-login',
      "Kage can't tell whether Claude Code is signed in on macOS. Run claude once to check.",
    );
  }
  const signedIn = Boolean(d.env.ANTHROPIC_API_KEY) || (await credentials());
  return signedIn
    ? ok('claude-login', 'Claude Code is signed in.')
    : warn('claude-login', 'Claude Code may not be signed in. Run claude once and sign in.');
}

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

async function tailscaleCheck(
  d: CheckDeps,
  hint: (tool: 'tailscale') => Promise<string>,
): Promise<Check> {
  // R115: on macOS the app's own CLI stands in when tailscale isn't on PATH.
  const cmd = tailscaleCommand({ platform: d.platform, path: d.env.PATH ?? '' });
  const r = await d.run(cmd, ['status', '--json'], PROBE);
  if (r.missing) return fail('tailscale', "Tailscale isn't installed.", await hint('tailscale'));
  let name: string | null = null;
  let parsed = false;
  try {
    // A stopped Tailscale still prints its status (and may exit non-zero).
    const data = JSON.parse(r.stdout) as {
      BackendState?: unknown;
      Self?: { DNSName?: unknown; TailscaleIPs?: unknown };
    } | null;
    parsed = true;
    const ips = Array.isArray(data?.Self?.TailscaleIPs) ? data.Self.TailscaleIPs : [];
    const v4 = ips.find((ip): ip is string => typeof ip === 'string' && IPV4.test(ip));
    if (data?.BackendState === 'Running' && v4) {
      const dns = data.Self?.DNSName;
      name = typeof dns === 'string' && dns !== '' ? dns.replace(/\.$/, '') : v4;
    }
  } catch {
    // not JSON: it didn't answer (timed out, or tailscaled isn't running)
  }
  if (name !== null) return ok('tailscale', `Tailscale is up (${name}).`);
  if (!parsed) {
    return fail(
      'tailscale',
      "tailscale status didn't answer.",
      "Run tailscale status yourself to see what's wrong.",
    );
  }
  return fail(
    'tailscale',
    "Tailscale isn't up.",
    d.platform === 'darwin' ? 'Open the Tailscale app and sign in.' : 'sudo tailscale up',
  );
}

// --- this installation -----------------------------------------------------------------------

/** config, token, projects, service, service-path, server, install-path. */
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

  // Without a config file setup comes first, and it asks for the projects folder (and the token).
  if (cfg !== null && cfgCheck?.label !== NO_CONFIG) {
    checks.push(tokenCheck(cfg));
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
  checks.push(await serverCheck(d, service.installed, cfgCheck?.label !== NO_CONFIG));
  checks.push(...(await installPathChecks(d, service.installed)));
  return checks;
}

export const NO_CONFIG = 'No config yet. Run kage setup.';

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

/**
 * Security I3: live mode needs a token, or `allowNoToken` on purpose. An old `token: ""` config
 * stops the service (serve refuses), so this says why and what to run. Never shows the token.
 */
function tokenCheck(cfg: KageConfig): Check {
  if (cfg.token !== '') return ok('token', 'An access token is set.');
  const fix = 'Run kage setup to set one.';
  return cfg.allowNoToken
    ? warn('token', 'No access token: anyone on your tailnet can start and approve tasks.', fix)
    : fail('token', "No access token is set, so Kage won't start.", fix);
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

/** Where the service's log is, as a user reads or runs it (doctor, kage restart). */
export function logHint(m: ServiceManager): string {
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
    const said = firstLine((err as Error).message);
    return none([
      warn(
        'service',
        `Kage couldn't read the service's state${said ? ` (${said})` : ''}.`,
        'Run kage doctor again. If it keeps happening, run kage setup again.',
      ),
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
          'Start it with: kage restart',
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
    let at = await findOnPath(tool, path);
    if (at === null && tool === 'tailscale') {
      // R115: serve falls back to the macOS app's CLI, so the service finds it there too.
      const cmd = tailscaleCommand({ platform: d.platform, path });
      if (cmd !== 'tailscale') at = cmd;
    }
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

/** The first line of an error, at most 160 characters. */
function firstLine(text: string): string {
  const line = (text.split(/\r?\n/)[0] ?? '').trim();
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}

/** How to restart Kage: kage restart when its service is installed (U9), else kage serve. */
function restartHint(d: CheckDeps, serviceInstalled: boolean): string {
  return d.manager && serviceInstalled
    ? 'Restart it with kage restart, then run kage doctor again.'
    : 'Restart Kage (kage serve) and run kage doctor again.';
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Usability U8: one answer to "how do I start Kage". With its service, kage restart; with a config
 * but no service (setup --no-service), kage serve; with neither, Kage isn't set up yet, so that is
 * a warning whose fix is setup, not a ✗ that points away from it.
 */
async function serverCheck(
  d: CheckDeps,
  serviceInstalled: boolean,
  configured: boolean,
): Promise<Check> {
  const status = await d.status(socketPath(d.env, d.platform));
  if (status === null) {
    if (d.manager && serviceInstalled) {
      return fail(
        'server',
        "Kage isn't running.",
        `Start it with kage restart, or see the service log: ${logHint(d.manager)}`,
      );
    }
    return configured
      ? fail('server', "Kage isn't running.", 'Start it with kage serve.')
      : warn('server', "Kage isn't running.", 'Run kage setup.');
  }
  let url: URL | null = null;
  try {
    url = new URL('/', status.url);
  } catch {
    // handled below
  }
  if (url === null || url.protocol !== 'http:') {
    return fail(
      'server',
      `Kage answers, but its address ${status.url} isn't one Kage can serve.`,
      restartHint(d, serviceInstalled),
    );
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
      d.manager && serviceInstalled
        ? `See the service log: ${logHint(d.manager)}`
        : restartHint(d, false),
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
 * the script after `node --no-warnings`: for the bundle, `kage-hook.mjs` beside `kage.mjs`
 * (hardening Task 13), or `kage.mjs` from an older build. null when there is no such file yet.
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

async function installPathChecks(d: CheckDeps, serviceInstalled: boolean): Promise<Check[]> {
  const checks: Check[] = [];
  const program = await hookProgram(d.env);
  if (program !== null) {
    if (!(await exists(program))) {
      checks.push(
        warn(
          'install-path',
          `Claude's hooks run ${program}, which isn't there anymore.`,
          // U9: kage restart when the service is installed, else kage serve.
          d.manager && serviceInstalled
            ? 'Restart Kage so it writes them again: run kage restart.'
            : 'Restart Kage so it writes them again: run kage serve, or kage setup for the service.',
        ),
      );
    } else if (checkoutOf({ kind: 'bundle', node: '', script: program }) !== null) {
      // U4: a checkout's build lasts as long as the checkout stays where it is (F17: the light
      // hook entry beside kage.mjs counts too).
      checks.push(
        ok(
          'install-path',
          `Claude's hooks run this checkout's build (${program}). If you move the checkout, run kage setup again.`,
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
    if (onPath) {
      checks.push(ok('install-path', `${dir} is on your PATH.`));
    } else {
      // R114: the same files install.sh writes the line into.
      const files = pathRcFiles({
        shell: d.env.SHELL,
        home: d.home,
        zdotdir: d.env.ZDOTDIR,
        hasBashProfile: await exists(join(d.home, '.bash_profile')),
      });
      checks.push(
        warn(
          'install-path',
          `${dir} isn't on your PATH.`,
          pathAdvice(
            dir,
            files.map((f) => displayPath(f, d.home)),
          ),
        ),
      );
    }
  }
  return checks;
}
