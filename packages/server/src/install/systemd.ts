/**
 * The systemd user unit (Linux and WSL; host-integration §7.4). The unit restarts every 5 s with
 * no start limit (R105): a user unit can't order itself after tailscaled.service, so Kage exits
 * while Tailscale has no address and systemd starts it again.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { RunResult } from './run.ts';
import {
  mustSucceed,
  type ServiceDeps,
  type ServiceManager,
  type ServiceSpec,
  type ServiceState,
  writeServiceFile,
} from './service.ts';

export const SYSTEMD_UNIT = 'kage.service';

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
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them is the point.
  if (/[\u0000-\u001f\u007f]/.test(word)) {
    throw new Error(`A service value can't hold a control character: ${JSON.stringify(word)}`);
  }
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
  const exec = spec.argv.map((w, i) => systemdQuote(w, i === 0 ? 'path' : 'exec')).join(' ');
  const env = Object.entries(spec.env)
    .map(([k, v]) => systemdQuote(`${k}=${v}`, 'env'))
    .join(' ');
  return [
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

export function systemdManager(d: ServiceDeps): ServiceManager & {
  lingerEnabled(): Promise<boolean>;
  enableLinger(): Promise<boolean>;
} {
  const configHome = d.env.XDG_CONFIG_HOME || join(d.home, '.config');
  const unitDir = join(configHome, 'systemd', 'user');
  const file = join(unitDir, SYSTEMD_UNIT);
  const wsl = d.wsl ?? (() => inWsl(d.env));

  const systemctl = (...args: string[]): Promise<RunResult> =>
    d.run('systemctl', ['--user', ...args]);
  const must = async (...args: string[]): Promise<void> =>
    mustSucceed(await systemctl(...args), ['systemctl', '--user', ...args]);

  const unavailable = async (): Promise<string | null> => {
    const r = await systemctl('is-active', SYSTEMD_UNIT);
    if (!r.missing && ANSWERED.has(r.code)) return null;
    return wsl() ? WSL_SENTENCE : NO_MANAGER_SENTENCE;
  };

  return {
    kind: 'systemd',
    file,
    name: `systemd user unit ${SYSTEMD_UNIT}`,
    unavailable,

    async install(spec) {
      const first = !existsSync(file);
      writeServiceFile(file, renderUnit(spec));
      await must('daemon-reload');
      if (first) {
        await must('enable', '--now', SYSTEMD_UNIT);
      } else {
        await must('enable', SYSTEMD_UNIT);
        await must('restart', SYSTEMD_UNIT);
      }
    },

    async restart() {
      await must('restart', SYSTEMD_UNIT);
    },

    async remove() {
      // A unit that isn't there fails to disable; that's fine.
      await systemctl('disable', '--now', SYSTEMD_UNIT);
      rmSync(file, { force: true });
      rmSync(join(unitDir, 'default.target.wants', SYSTEMD_UNIT), { force: true });
      const reload = await systemctl('daemon-reload');
      // Without a user manager nothing is loaded, so there is nothing to reload.
      if (reload.code !== 0 && (await unavailable()) === null) {
        mustSucceed(reload, ['systemctl', '--user', 'daemon-reload']);
      }
    },

    async state(): Promise<ServiceState> {
      const r = await systemctl('is-active', SYSTEMD_UNIT);
      if (r.missing || !ANSWERED.has(r.code)) {
        mustSucceed(r, ['systemctl', '--user', 'is-active', SYSTEMD_UNIT]);
      }
      if (r.code === 4) return 'missing';
      // R110-9: the word tells them apart; activating, inactive and failed all exit 3.
      const word = r.stdout.trim().split(/\s+/)[0] ?? '';
      if (word === 'active' || word === 'reloading' || word === 'refreshing') return 'active';
      // Our unit is Type=simple, so activating means auto-restart after a failed start.
      if (word === 'failed' || word === 'activating') return 'failed';
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
      const r = await d.run('loginctl', ['show-user', String(d.uid), '-p', 'Linger', '--value']);
      return r.code === 0 && r.stdout.trim() === 'yes';
    },

    async enableLinger() {
      // For oneself (no user argument): polkit's set-self-linger, which needs no root.
      const r = await d.run('loginctl', ['enable-linger']);
      return r.code === 0;
    },
  };
}
