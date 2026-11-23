/**
 * The systemd user unit (Linux and WSL; host-integration §7.4). The unit restarts every 5 s with
 * no start limit (R105): a user unit can't order itself after tailscaled.service, so Kage exits
 * while Tailscale has no address and systemd starts it again.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { RunResult } from './run.ts';
import type { ServiceDeps, ServiceManager, ServiceSpec, ServiceState } from './service.ts';
import {
  assertAbsoluteProgram,
  assertOurs,
  assertWritable,
  mustSucceed,
  SERVICE_MARKER,
  START_TIMEOUT_MS,
  writeServiceFile,
} from './service-files.ts';

export const SYSTEMD_UNIT = 'kage.service';

/** The unit's first line; a kage.service without it isn't Kage's. */
export const UNIT_MARKER_LINE = `# ${SERVICE_MARKER}`;
const isOurUnit = (lines: string[]): boolean => lines[0] === UNIT_MARKER_LINE;

const WSL_SENTENCE =
  'systemd isn\'t running in this WSL distribution. Add "[boot]" and "systemd=true" to /etc/wsl.conf, then run "wsl --shutdown" in Windows and open WSL again.';
const NO_MANAGER_SENTENCE =
  'systemctl --user doesn\'t answer, so Kage can\'t install its service. Run "kage serve" yourself, or log in with a full session.';

/**
 * Where a word goes (checked against systemd 255 in WSL, host-integration §7.4):
 * - `exec`: an ExecStart= argument, where `$` starts a variable, so `$$` is a literal `$`;
 * - `path`: ExecStart='s executable, which gets no variable expansion, and which systemd refuses
 *   outright when it holds `"`, `'` or `\` ("Executable name contains special characters");
 * - `env`: an Environment= word, where `$` has no special meaning (systemd.exec(5)).
 */
export type SystemdContext = 'exec' | 'path' | 'env';

/**
 * One word for a unit line: in double quotes, with `\` and `"` escaped, `%` doubled (specifiers
 * expand in every context), and in `exec` `$` doubled. Control characters can't be written on a
 * unit line, and an executable can't hold a quote or a backslash, so those throw.
 */
export function systemdQuote(word: string, context: SystemdContext = 'exec'): string {
  assertWritable(word);
  if (context === 'path' && /["'\\]/.test(word)) {
    throw new Error(
      `systemd can't run a program whose path holds a quote or a backslash: ${word}. Install Kage in another folder.`,
    );
  }
  let q = word.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%');
  if (context === 'exec') q = q.replace(/\$/g, '$$$$');
  return `"${q}"`;
}

/** The words of a unit line's value, the way systemd reads what systemdQuote wrote. */
export function parseSystemdWords(value: string, context: SystemdContext): string[] {
  const words: string[] = [];
  let i = 0;
  while (i < value.length) {
    while (i < value.length && /\s/.test(value[i] ?? '')) i++;
    if (i >= value.length) break;
    const quote = value[i] === '"' || value[i] === "'" ? value[i] : null;
    if (quote) i++;
    let word = '';
    while (i < value.length) {
      const c = value[i] ?? '';
      if (quote ? c === quote : /\s/.test(c)) {
        if (quote) i++;
        break;
      }
      const next = value[i + 1] ?? '';
      if (c === '\\' && next !== '') {
        word += next;
        i += 2;
      } else if (c === '%' && next === '%') {
        word += '%';
        i += 2;
      } else if (context === 'exec' && c === '$' && next === '$') {
        word += '$';
        i += 2;
      } else {
        word += c;
        i++;
      }
    }
    words.push(word);
  }
  return words;
}

/** The unit file's text (the brief's block, every value quoted). */
export function renderUnit(spec: ServiceSpec): string {
  assertAbsoluteProgram(spec.argv);
  const exec = spec.argv.map((w, i) => systemdQuote(w, i === 0 ? 'path' : 'exec')).join(' ');
  const env = Object.entries(spec.env)
    .map(([k, v]) => systemdQuote(`${k}=${v}`, 'env'))
    .join(' ');
  return [
    UNIT_MARKER_LINE,
    '[Unit]',
    'Description=Kage: a dashboard for your Claude Code sessions',
    "# User units can't wait for tailscaled.service; Kage exits while Tailscale has no address and systemd starts it again.",
    'StartLimitIntervalSec=0',
    '',
    '[Service]',
    `ExecStart=${exec}`,
    `Environment=${env}`,
    'Restart=on-failure',
    'RestartSec=5',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

/** The default WSL probe: the interop entry WSL registers, or the distro name it exports. */
function inWsl(env: NodeJS.ProcessEnv): boolean {
  return (
    existsSync('/proc/sys/fs/binfmt_misc/WSLInterop') ||
    existsSync('/proc/sys/fs/binfmt_misc/WSLInterop-late') ||
    Boolean(env.WSL_DISTRO_NAME)
  );
}

/** is-active's exits from a user manager that answered: 0 active, 3 not active, 4 no such unit. */
const ANSWERED = new Set([0, 3, 4]);

/**
 * The folder the user manager reads user units from: `$XDG_CONFIG_HOME/systemd/user` in the
 * manager's own environment, not the shell's. A shell that sets XDG_CONFIG_HOME (in .bashrc,
 * say) doesn't change the manager's, so a unit written there would never load. So it is:
 * - the XDG_CONFIG_HOME that `systemctl --user show-environment` prints, when it prints an
 *   absolute one (a value systemd had to escape, `$'…'`, doesn't count);
 * - else `~/.config/systemd/user`: the manager's default, also when it doesn't answer (setup
 *   then installs nothing, and doctor and uninstall look where a unit would be).
 */
export async function systemdUnitDir(
  run: ServiceDeps['run'],
  home: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const fallback = join(home, '.config', 'systemd', 'user');
  const r = await run('systemctl', ['--user', 'show-environment'], { env, timeoutMs: 5000 });
  if (r.missing || r.code !== 0) return fallback;
  for (const line of r.stdout.split(/\r?\n/)) {
    if (!line.startsWith('XDG_CONFIG_HOME=')) continue;
    const value = line.slice('XDG_CONFIG_HOME='.length);
    return value.startsWith('/') ? join(value, 'systemd', 'user') : fallback;
  }
  return fallback;
}

/**
 * `d.unitDir` is where the unit goes (serviceManager passes systemdUnitDir's answer); without
 * it, the user manager's default, `~/.config/systemd/user`.
 */
export function systemdManager(d: ServiceDeps): ServiceManager & {
  lingerEnabled(): Promise<boolean>;
  enableLinger(): Promise<boolean>;
} {
  const unitDir = d.unitDir ?? join(d.home, '.config', 'systemd', 'user');
  const file = join(unitDir, SYSTEMD_UNIT);
  const wsl = d.wsl ?? (() => inWsl(d.env));

  const systemctl = (args: string[], timeoutMs?: number): Promise<RunResult> =>
    d.run('systemctl', ['--user', ...args], {
      env: d.env,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
  const must = async (args: string[], timeoutMs?: number): Promise<void> =>
    mustSucceed(await systemctl(args, timeoutMs), ['systemctl', '--user', ...args]);

  const unavailable = async (): Promise<string | null> => {
    const r = await systemctl(['is-active', SYSTEMD_UNIT]);
    if (!r.missing && ANSWERED.has(r.code)) return null;
    return wsl() ? WSL_SENTENCE : NO_MANAGER_SENTENCE;
  };

  return {
    kind: 'systemd',
    file,
    name: `systemd user unit ${SYSTEMD_UNIT}`,
    unavailable,

    async install(spec) {
      const text = renderUnit(spec);
      assertOurs(file, isOurUnit);
      const first = !existsSync(file);
      writeServiceFile(file, text);
      await must(['daemon-reload']);
      if (first) {
        await must(['enable', '--now', SYSTEMD_UNIT], START_TIMEOUT_MS);
      } else {
        await must(['enable', SYSTEMD_UNIT]);
        await must(['restart', SYSTEMD_UNIT], START_TIMEOUT_MS);
      }
    },

    async restart() {
      await must(['restart', SYSTEMD_UNIT], START_TIMEOUT_MS);
    },

    async remove() {
      // Refuses a file that isn't ours or can't be read (only ENOENT passes).
      assertOurs(file, isOurUnit);
      // No file of ours: nothing to remove. A kage.service elsewhere isn't Kage's to disable.
      if (!existsSync(file)) return;
      // A unit that isn't loaded fails to disable; that's fine.
      await systemctl(['disable', '--now', SYSTEMD_UNIT], START_TIMEOUT_MS);
      rmSync(file, { force: true });
      rmSync(join(unitDir, 'default.target.wants', SYSTEMD_UNIT), { force: true });
      const reload = await systemctl(['daemon-reload']);
      // Without a user manager nothing is loaded, so there is nothing to reload.
      if (reload.code !== 0 && (await unavailable()) === null) {
        mustSucceed(reload, ['systemctl', '--user', 'daemon-reload']);
      }
    },

    async state(): Promise<ServiceState> {
      const r = await systemctl(['is-active', SYSTEMD_UNIT]);
      if (r.missing || !ANSWERED.has(r.code)) {
        mustSucceed(r, ['systemctl', '--user', 'is-active', SYSTEMD_UNIT]);
      }
      if (r.code === 4) return 'missing';
      // R110-9: the word tells them apart; activating, inactive and failed all exit 3.
      const word = r.stdout.trim().split(/\s+/)[0] ?? '';
      if (word === 'active' || word === 'reloading' || word === 'refreshing') return 'active';
      // R111: our unit is Type=simple, so activating is the auto-restart loop (no Tailscale yet).
      if (word === 'activating') return 'starting';
      if (word === 'failed') return 'failed';
      return existsSync(file) ? 'inactive' : 'missing';
    },

    async pathOfInstalled() {
      let text: string;
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        return null;
      }
      for (const line of text.split(/\r?\n/)) {
        const m = /^\s*Environment\s*=(.*)$/.exec(line);
        if (!m) continue;
        for (const word of parseSystemdWords(m[1] ?? '', 'env')) {
          if (word.startsWith('PATH=')) return word.slice('PATH='.length);
        }
      }
      return null;
    },

    async lingerEnabled() {
      const r = await d.run('loginctl', ['show-user', String(d.uid), '-p', 'Linger', '--value'], {
        env: d.env,
      });
      return r.code === 0 && r.stdout.trim() === 'yes';
    },

    async enableLinger() {
      // For oneself (no user argument): polkit's set-self-linger, which needs no root.
      const r = await d.run('loginctl', ['enable-linger'], { env: d.env });
      return r.code === 0;
    },
  };
}
