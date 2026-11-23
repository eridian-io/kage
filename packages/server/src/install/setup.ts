/**
 * `kage setup` (phase 6, Task 5; spec §5.13's five steps): check what Kage needs, ask for its
 * settings, write the config, install and start the service, and check that Kage answers.
 *
 * Safe to run again: each question's default is the current value, only the keys setup asks
 * about are written (and only when they differ), and the one service is rewritten and
 * restarted. Setup never writes Claude's configuration (R25): it writes Kage's own hooks file,
 * as `kage serve` does, and prints the command that starts Claude with it.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { mkdir, readdir, stat } from 'node:fs/promises';
import { isIP } from 'node:net';
import { userInfo } from 'node:os';
import { join, posix, resolve } from 'node:path';
import { ConfigError, configFrom, configPath, DEFAULT_CONFIG, displayPath } from '../config.ts';
import { socketPath } from '../hooks/cli.ts';
import { ListenError, resolveListenAddress, tailscaleDnsName } from '../listen.ts';
import type { Io } from '../main.ts';
import { type CheckDeps, formatChecks, requirementChecks } from './checks.ts';
import { generateToken, readConfigObject, writeConfig } from './config-file.ts';
import { isStopped, type Prompter } from './prompt.ts';
import { type RunMode, serviceArgv, serviceEnv } from './runtime.ts';
import type { ServiceManager } from './service.ts';

export interface SetupDeps extends CheckDeps {
  /** The questions; null without a terminal. */
  prompt: Prompter | null;
  isTty: boolean;
  /** Writes Kage's hooks file (main.ts writeSettings). */
  writeSettings: (env: NodeJS.ProcessEnv) => Promise<string>;
  /** How long to wait for Kage to answer after the service starts (default 15 s). */
  waitMs?: number;
  /** Resolves a typed host name (a test seam; default dns.lookup). */
  lookup?: (name: string) => Promise<{ address: string; family: number }[]>;
}

export const NEEDS_TTY =
  'kage setup needs a terminal for its questions. Run it in one, or pass --yes to take the defaults.';
export const CLAUDE_LINE =
  'To start Claude yourself with Kage watching: claude --settings "$(kage hooks-path)" --permission-mode default';
const TOKEN_QUESTION = 'Set an access token? Anyone on your tailnet can reach Kage.';
const LINGER_QUESTION = "Keep Kage running when you're logged out?";
export const LINGER_ON =
  "Turned on linger, so Kage keeps running when you're logged out. To undo it: loginctl disable-linger";
const DEFAULT_PATH = '/usr/local/bin:/usr/bin:/bin';
const POLL_MS = 250;
const SERVER_TIMEOUT_MS = 3000;

interface Flags {
  yes: boolean;
  projects?: string;
  host?: string;
  port?: string;
  token?: boolean;
  service: boolean;
  linger?: boolean;
}

/** The flags, or a sentence saying what's wrong with them. */
export function parseSetupFlags(args: string[]): Flags | string {
  const f: Flags = { yes: false, service: true };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    const eq = arg.indexOf('=');
    const name = arg.startsWith('--') && eq > 0 ? arg.slice(0, eq) : arg;
    const value = (): string | null => {
      if (eq > 0 && name !== arg) return arg.slice(eq + 1);
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) return null;
      i++;
      return next;
    };
    const needsValue = (key: 'projects' | 'host' | 'port'): string | null => {
      const v = value();
      if (v === null || v.trim() === '') return `${name} needs a value.`;
      f[key] = v.trim();
      return null;
    };
    let problem: string | null = null;
    switch (name) {
      case '--yes':
      case '-y':
        f.yes = true;
        break;
      case '--projects':
        problem = needsValue('projects');
        break;
      case '--host':
        problem = needsValue('host');
        break;
      case '--port':
        problem = needsValue('port');
        break;
      case '--token':
        f.token = true;
        break;
      case '--no-token':
        f.token = false;
        break;
      case '--no-service':
        f.service = false;
        break;
      case '--linger':
        f.linger = true;
        break;
      case '--no-linger':
        f.linger = false;
        break;
      default:
        problem = `kage setup has no option "${arg}". Run kage --help to see its options.`;
    }
    if (problem !== null) return problem;
  }
  return f;
}

function expandHome(p: string, home: string): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return join(home, p.slice(2));
  return p;
}

async function isDir(path: string): Promise<boolean> {
  return stat(path).then(
    (s) => s.isDirectory(),
    () => false,
  );
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/**
 * The projects folder to suggest: ~/projects if it exists; else the folder right under home
 * with the most git repositories one level down (hidden folders skipped, ties by name); else
 * ~/projects. Shown with `~/`.
 */
export async function suggestProjectsRoot(home: string): Promise<string> {
  if (await isDir(join(home, 'projects'))) return '~/projects';
  let best: { name: string; repos: number } | null = null;
  let children: string[] = [];
  try {
    children = (await readdir(home, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort();
  } catch {
    // no home to look in
  }
  for (const name of children) {
    let repos = 0;
    try {
      for (const e of await readdir(join(home, name), { withFileTypes: true })) {
        // A worktree's .git is a file, a repository's a folder: either counts.
        if (e.isDirectory() && (await exists(join(home, name, e.name, '.git')))) repos++;
      }
    } catch {
      continue;
    }
    if (repos > 0 && (best === null || repos > best.repos)) best = { name, repos };
  }
  return best ? `~/${best.name}` : '~/projects';
}

/**
 * The service's PATH (R110-8, F23): every absolute folder of the PATH setup runs with, in its
 * order (so tmux, git, claude and tailscale are found where the terminal finds them; Windows
 * folders in WSL included), then node's folder in bundle mode and an absolute KAGE_CLAUDE_BIN's
 * folder; each folder once, and relative entries dropped. Without a PATH, the system's usual
 * folders.
 */
export function servicePath(env: NodeJS.ProcessEnv, mode: RunMode): string {
  const dirs = (env.PATH || DEFAULT_PATH).split(':').filter((d) => posix.isAbsolute(d));
  if (mode.kind === 'bundle') dirs.push(posix.dirname(mode.node));
  const claude = env.KAGE_CLAUDE_BIN ?? '';
  if (posix.isAbsolute(claude)) dirs.push(posix.dirname(claude));
  const unique = [...new Set(dirs)];
  return unique.length > 0 ? unique.join(':') : DEFAULT_PATH;
}

/** The first line of an error, at most 160 characters. */
function firstLine(err: unknown): string {
  const line = ((err as Error).message?.split(/\r?\n/)[0] ?? String(err)).trim();
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}

function logHint(m: ServiceManager | null): string {
  return m?.kind === 'launchd' ? '~/Library/Logs/kage.log' : 'journalctl --user -u kage -e';
}

/** This machine's Tailscale addresses, from `tailscale status --json`'s Self.TailscaleIPs. */
export function ownTailscaleIps(statusJson: string): string[] {
  try {
    const ips = (JSON.parse(statusJson) as { Self?: { TailscaleIPs?: unknown } } | null)?.Self
      ?.TailscaleIPs;
    return Array.isArray(ips)
      ? ips.filter((ip): ip is string => typeof ip === 'string').map((ip) => ip.toLowerCase())
      : [];
  } catch {
    return [];
  }
}

/** An address in Tailscale's ranges: 100.64.0.0/10 or fd7a:115c:a1e0::/48. */
function inTailnet(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 100 && b !== undefined && b >= 64 && b <= 127;
  }
  return address.toLowerCase().startsWith('fd7a:115c:a1e0:');
}

/**
 * Why Kage can't listen on a typed host, or null when it can (F8: checked like serve does). A
 * tailnet address must be one of this machine's own (`own`, when known): another machine's
 * would make the service fail to bind, and restart forever.
 */
async function hostProblem(
  name: string,
  lookup: NonNullable<SetupDeps['lookup']>,
  own: string[],
): Promise<string | null> {
  let address = name.replace(/^\[|\]$/g, '');
  if (isIP(address) === 0) {
    let found: { address: string; family: number }[] = [];
    try {
      found = await lookup(name);
    } catch {
      // handled below
    }
    const pick = found.find((a) => a.family === 4) ?? found[0];
    if (!pick) return `Kage can't find the address of ${name}.`;
    address = pick.address;
  }
  if (inTailnet(address) && own.length > 0 && !own.includes(address.toLowerCase())) {
    return `${name} is another machine on your tailnet (${address}), not this one.`;
  }
  try {
    await resolveListenAddress(
      { ...DEFAULT_CONFIG, host: address },
      { unsafeListenAll: false, tailscaleIp: async () => null },
    );
    return null;
  } catch (err) {
    if (!(err instanceof ListenError)) throw err;
    return `${name} isn't a Tailscale or loopback address, so Kage won't listen there.`;
  }
}

function parsePort(text: string): number | null {
  if (!/^\d{1,5}$/.test(text)) return null;
  const n = Number(text);
  return n >= 1 && n <= 65535 ? n : null;
}

const SETTING_NAMES: Record<string, string> = {
  projectsRoot: 'projects folder',
  host: 'host name',
  port: 'port',
  token: 'access token',
  // Turning the token on writes allowNoToken: false with it: one setting, said once.
  allowNoToken: 'access token',
};

/** U20: said instead of "Saved the access token" when the token was turned off. */
const TOKEN_OFF = 'Turned off the access token: anyone on your tailnet can open Kage.';

function listWords(words: string[]): string {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

/** kage setup; see the file comment. 0 when Kage is set up (and answering, with the service). */
export async function setupCommand(args: string[], io: Io, deps: SetupDeps): Promise<number> {
  try {
    return await setup(args, io, deps);
  } catch (err) {
    if (isStopped(err)) {
      io.err('Setup stopped.');
      return 130;
    }
    throw err;
  }
}

async function setup(args: string[], io: Io, deps: SetupDeps): Promise<number> {
  const f = parseSetupFlags(args);
  if (typeof f === 'string') {
    io.err(f);
    return 1;
  }
  // 1. Who and where.
  if (deps.uid === 0) {
    io.err('Run Kage as your own user, not root.');
    return 1;
  }
  const prompt = f.yes ? null : deps.prompt;
  if (!f.yes && (!deps.isTty || prompt === null)) {
    io.err(NEEDS_TTY);
    return 1;
  }
  const checks = await requirementChecks(deps);
  for (const line of formatChecks(checks)) io.out(line);
  io.out('');
  if (checks.some((c) => c.level === 'fail')) {
    io.out('Fix the items above, then run kage setup again.');
    return 1;
  }

  const cfgFile = configPath(deps.env);
  const shown = displayPath(cfgFile, deps.home);
  let current: Record<string, unknown> | null;
  try {
    current = await readConfigObject(cfgFile);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    io.err(err.message);
    return 1;
  }

  // 2. The questions; a flag answers its own, and --yes takes each default. Nothing is
  // written until every answer is in and the whole config checks out (R116(4)).
  const ask = (question: string, def: string): Promise<string> =>
    prompt ? prompt.ask(question, def) : Promise.resolve(def);
  const confirm = (question: string, def: boolean): Promise<boolean> =>
    prompt ? prompt.confirm(question, def) : Promise.resolve(def);

  const projects = await askProjects(io, deps, f, current, ask, confirm);
  if (projects === null) return 1;
  const host = await askHost(io, deps, f, current, ask);
  if (host === undefined) return 1;
  const port = await askPort(io, f, current, ask);
  if (port === null) return 1;

  const curToken = typeof current?.token === 'string' ? current.token : null;
  const wantToken =
    f.token ?? (await confirm(TOKEN_QUESTION, curToken === null ? true : curToken !== ''));
  const keepToken = curToken !== null && curToken.length >= 16;
  const token = wantToken ? (keepToken ? curToken : generateToken()) : '';
  const generated = wantToken && !keepToken;

  // The service's plan, and its one question (linger), before anything changes.
  const m = deps.manager;
  let skipped: string | null = null;
  let argv: string[] | null = null;
  if (f.service && m !== null) {
    // R112: state() and install() need a user manager, so ask first.
    skipped = await m.unavailable();
    if (skipped === null) {
      try {
        argv = serviceArgv(deps.mode);
      } catch (err) {
        skipped = firstLine(err);
      }
    }
  }
  const linger = argv !== null && m !== null ? await askLinger(f, m, confirm) : false;
  // The last question is asked: from here Ctrl+C stops setup at once (prompt.ts).
  prompt?.close?.();

  // 3. Check the whole config as it will be, then write it, then Kage's hooks file.
  const patch: Record<string, unknown> = {};
  if (current?.projectsRoot !== projects.value) patch.projectsRoot = projects.value;
  if (host.change) patch.host = host.value;
  if (current?.port !== port) patch.port = port;
  if (current?.token !== token) patch.token = token;
  // Security I3: no token is an opt-out serve needs written down (allowNoToken); a token on
  // clears an opt-out that was there.
  if (!wantToken && current?.allowNoToken !== true) patch.allowNoToken = true;
  if (wantToken && current?.allowNoToken !== undefined && current.allowNoToken !== false) {
    patch.allowNoToken = false;
  }
  const turnedOff = !wantToken && ('token' in patch || 'allowNoToken' in patch);
  try {
    // A key setup didn't ask about may be wrong too; the service would only restart forever.
    configFrom({ ...(current ?? {}), ...patch }, deps.env);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    io.err(`Config error: ${err.message}`);
    io.err(`Fix ${shown}, then run kage setup again.`);
    return 1;
  }
  if (projects.create) {
    try {
      await mkdir(projects.abs, { recursive: true });
    } catch (err) {
      io.err(`Couldn't create ${projects.shown}: ${firstLine(err)}`);
      return 1;
    }
    io.out(`Created ${projects.shown}.`);
  }
  try {
    await writeConfig(cfgFile, patch);
  } catch (err) {
    io.err(err instanceof ConfigError ? err.message : `Couldn't write ${shown}: ${firstLine(err)}`);
    return 1;
  }
  const changed = [
    ...new Set(
      Object.keys(patch)
        .filter((k) => !(turnedOff && (k === 'token' || k === 'allowNoToken')))
        .map((k) => SETTING_NAMES[k] ?? k),
    ),
  ];
  if (current === null) io.out(`Saved your settings in ${shown}.`);
  else if (changed.length > 0) io.out(`Saved the ${listWords(changed)} in ${shown}.`);
  else if (!turnedOff) io.out(`Your settings in ${shown} are already set.`);
  if (turnedOff) io.out(TOKEN_OFF);
  if (generated) {
    io.out(`Your token: ${token}. Kage asks for it once per browser. It's saved in ${shown}.`);
  }
  try {
    await deps.writeSettings(deps.env);
  } catch (err) {
    io.err(`Couldn't write the Claude settings file: ${firstLine(err)}`);
    return 1;
  }

  // 4. The service.
  if (skipped !== null) io.out(skipped);
  if (argv === null || m === null) {
    io.out('Start Kage with: kage serve');
    io.out(CLAUDE_LINE);
    return 0;
  }
  let existed = false;
  try {
    existed = (await m.state()) !== 'missing';
  } catch {
    // install says what's wrong, if anything is
  }
  try {
    await m.install({
      argv,
      env: serviceEnv(deps.mode, servicePath(deps.env, deps.mode), deps.env),
    });
  } catch (err) {
    io.err(`Couldn't install the ${m.name}: ${firstLine(err)}`);
    io.err('Fix that, then run kage setup again.');
    return 1;
  }
  io.out(existed ? `Updated and restarted the ${m.name}.` : `Installed the ${m.name}.`);
  if (linger) await turnOnLinger(io, deps, m);

  // 5. Does it answer?
  const code = await checkAnswers(io, deps, m, { host: host.value, at: host.at, port });
  if (code !== 0) return code;
  io.out(CLAUDE_LINE);
  return 0;
}

type Ask = (question: string, def: string) => Promise<string>;
type Confirm = (question: string, def: boolean) => Promise<boolean>;

interface ProjectsAnswer {
  /** As it goes in the config (`~/…` kept). */
  value: string;
  abs: string;
  shown: string;
  /** Made only once the config checks out, with the other writes. */
  create: boolean;
}

/** The projects folder; null when setup must stop. */
async function askProjects(
  io: Io,
  deps: SetupDeps,
  f: Flags,
  current: Record<string, unknown> | null,
  ask: Ask,
  confirm: Confirm,
): Promise<ProjectsAnswer | null> {
  const cur = typeof current?.projectsRoot === 'string' ? current.projectsRoot : null;
  const def = cur ?? (await suggestProjectsRoot(deps.home));
  for (;;) {
    const answer = f.projects ?? (await ask('Projects folder', def));
    // Relative to where setup runs; `~/…` stays as typed, so the config reads naturally.
    const value = answer === '~' || answer.startsWith('~/') ? answer : resolve(answer);
    const abs = expandHome(value, deps.home);
    const name = displayPath(abs, deps.home);
    const again = f.projects === undefined && !f.yes;
    if (await isDir(abs)) return { value, abs, shown: name, create: false };
    if (await exists(abs)) {
      io.out(`${name} isn't a folder.`);
      if (again) continue;
      return null;
    }
    if (await confirm(`Create ${name}?`, true)) return { value, abs, shown: name, create: true };
    if (!again) {
      io.out('Kage needs a projects folder. Run kage setup again with one that exists.');
      return null;
    }
  }
}

/**
 * The host (F8): taking the default (the MagicDNS name shown) leaves `host` as it is, unset
 * meaning the Tailscale address; typing that short name again unsets a configured one. Any
 * other typed value is written only once Kage could listen on it. undefined: setup must stop.
 */
async function askHost(
  io: Io,
  deps: SetupDeps,
  f: Flags,
  current: Record<string, unknown> | null,
  ask: Ask,
): Promise<{ value: string | null; change: boolean; at: string | null } | undefined> {
  const cur = typeof current?.host === 'string' && current.host.trim() !== '' ? current.host : null;
  let statusJson = '';
  const dns = await tailscaleDnsName(async (cmd, cmdArgs) => {
    const r = await deps.run(cmd, cmdArgs, { timeoutMs: 5000 });
    if (r.code !== 0) throw new Error(r.stderr);
    statusJson = r.stdout;
    return r.stdout;
  });
  const own = ownTailscaleIps(statusJson);
  const short = dns?.split('.')[0] ?? null;
  const def = cur ?? short ?? 'the Tailscale address';
  // Where Kage is when host is unset, for setup's "didn't answer" line (security I2: never
  // os.hostname()): the MagicDNS short name, else this machine's Tailscale IP.
  const at = short ?? own.find((ip) => isIP(ip) === 4) ?? own[0] ?? null;
  const lookup = deps.lookup ?? ((n: string) => dnsLookup(n, { all: true }));
  for (;;) {
    const answer = f.host ?? (await ask('Host name', def));
    if (answer === def && cur !== null) return { value: cur, change: false, at };
    if (answer === def || (short !== null && answer.toLowerCase() === short)) {
      // The Tailscale address: a configured host goes back to unset (null).
      return { value: null, change: cur !== null || current?.host === '', at };
    }
    const problem = await hostProblem(answer, lookup, own);
    if (problem === null) return { value: answer, change: answer !== cur, at };
    io.out(problem);
    if (f.host !== undefined || f.yes) return undefined;
    io.out('Press Enter for the Tailscale address, or type another name or IP.');
  }
}

async function askPort(
  io: Io,
  f: Flags,
  current: Record<string, unknown> | null,
  ask: Ask,
): Promise<number | null> {
  const cur = typeof current?.port === 'number' ? current.port : DEFAULT_CONFIG.port;
  for (;;) {
    const port = parsePort(f.port ?? (await ask('Port', String(cur))));
    if (port !== null) return port;
    io.out('The port must be a whole number from 1 to 65535.');
    if (f.port !== undefined || f.yes) return null;
  }
}

/**
 * systemd only: whether to turn linger on (R110-10). Asked when it is off, unless --linger or
 * --no-linger answers; --yes takes the default, Yes (R116(2)).
 */
async function askLinger(f: Flags, m: ServiceManager, confirm: Confirm): Promise<boolean> {
  if (!m.lingerEnabled || !m.enableLinger || f.linger === false) return false;
  if (await m.lingerEnabled()) return false;
  return f.linger ?? (await confirm(LINGER_QUESTION, true));
}

/** Turns linger on for oneself, and says so and how to undo it (R116(2)); else the sudo line. */
async function turnOnLinger(io: Io, deps: SetupDeps, m: ServiceManager): Promise<void> {
  if (await m.enableLinger?.()) {
    io.out(LINGER_ON);
    return;
  }
  io.out(`Run this to allow it: sudo loginctl enable-linger ${userName(deps.env)}`);
}

function userName(env: NodeJS.ProcessEnv): string {
  if (env.USER) return env.USER;
  if (env.LOGNAME) return env.LOGNAME;
  try {
    return userInfo().username;
  } catch {
    return '$USER';
  }
}

/**
 * Waits for Kage to answer on its socket (every 250 ms, up to waitMs), then asks its address
 * once over the network (R105: Kage's own address). 0 when it answers, else 1.
 */
async function checkAnswers(
  io: Io,
  deps: SetupDeps,
  m: ServiceManager | null,
  cfg: { host: string | null; at: string | null; port: number },
): Promise<number> {
  const socket = socketPath(deps.env, deps.platform);
  const deadline = Date.now() + (deps.waitMs ?? 15_000);
  // An answer on another port is an older kage serve still holding the socket, not the unit.
  const ours = (s: { url: string } | null) => s !== null && portOf(s.url) === cfg.port;
  let status = await deps.status(socket);
  while (!ours(status) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    status = await deps.status(socket);
  }
  if (status === null) {
    io.out(`Kage didn't answer at ${expectedUrl(cfg)}. See: ${logHint(m)}`);
    return 1;
  }
  if (!ours(status)) {
    io.out(
      `A Kage at ${status.url} answers instead, not on port ${cfg.port}. Another kage serve may be running: stop it, then run kage setup again.`,
    );
    return 1;
  }
  let code: number;
  try {
    const res = await deps.fetch(new URL('/', status.url).href, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(SERVER_TIMEOUT_MS),
    });
    code = res.status;
    await res.body?.cancel().catch(() => {});
  } catch {
    io.out(`Kage is running, but ${status.url} doesn't answer from here.`);
    io.out(
      "If the board opens on your phone, all is well. If it doesn't, check Tailscale on both devices.",
    );
    return 0;
  }
  if (code !== 200 && code !== 401) {
    io.out(`Kage is running, but ${status.url} answers HTTP ${code}. See: ${logHint(m)}`);
    return 1;
  }
  io.out(`Kage is running at ${status.url}`);
  return 0;
}

/** A URL's port as a number (80 when it names none); null when it isn't a URL. */
function portOf(url: string): number | null {
  try {
    const u = new URL(url);
    return u.port === '' ? (u.protocol === 'https:' ? 443 : 80) : Number(u.port);
  } catch {
    return null;
  }
}

/**
 * Where Kage should be, for the "didn't answer" line: the host set, else the MagicDNS short
 * name, else the Tailscale IP. Each passes Kage's Host guard; os.hostname() doesn't (security
 * I2). With none of them Kage can't have started ("Tailscale isn't running", in the log).
 */
function expectedUrl(cfg: { host: string | null; at: string | null; port: number }): string {
  let host = cfg.host?.trim() || cfg.at || '<Tailscale IP>';
  if (isIP(host) === 6) host = `[${host}]`;
  return `http://${host}:${cfg.port}`;
}
