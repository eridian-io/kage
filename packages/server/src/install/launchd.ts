/**
 * The launchd agent (macOS; host-integration §7.5, documented, not observed). It starts at load
 * and at login, restarts after a non-zero exit at most every 10 s, and logs to
 * ~/Library/Logs/kage.log.
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  mustSucceed,
  type ServiceDeps,
  type ServiceManager,
  type ServiceSpec,
  type ServiceState,
  writeServiceFile,
} from './service.ts';

export const LAUNCHD_LABEL = 'io.eridian.kage';

const NO_LAUNCHCTL_SENTENCE =
  'launchctl isn\'t on PATH, so Kage can\'t install its service. Run "kage serve" yourself.';

/** Text for an XML element or attribute: & < > " ' escaped; characters XML 1.0 can't hold throw. */
export function xmlEscape(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them is the point.
  if (/[\u0000-\u001f\u007f￾￿]/.test(text)) {
    throw new Error(`A service value can't hold a control character: ${JSON.stringify(text)}`);
  }
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function xmlUnescape(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

const str = (indent: string, text: string) => `${indent}<string>${xmlEscape(text)}</string>`;

/** The plist's text; `logPath` is ~/Library/Logs/kage.log. */
export function renderPlist(spec: ServiceSpec, logPath: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    str('  ', LAUNCHD_LABEL),
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...spec.argv.map((a) => str('    ', a)),
    '  </array>',
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    ...Object.entries(spec.env).flatMap(([k, v]) => [
      `    <key>${xmlEscape(k)}</key>`,
      str('    ', v),
    ]),
    '  </dict>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <dict>',
    '    <key>SuccessfulExit</key>',
    '    <false/>',
    '  </dict>',
    '  <key>ThrottleInterval</key>',
    '  <integer>10</integer>',
    '  <key>StandardOutPath</key>',
    str('  ', logPath),
    '  <key>StandardErrorPath</key>',
    str('  ', logPath),
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

/** An EnvironmentVariables value from a plist renderPlist wrote; null if it isn't there. */
export function plistEnvValue(xml: string, key: string): string | null {
  const env = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(xml)?.[1];
  if (env === undefined) return null;
  for (const m of env.matchAll(/<key>([^<]*)<\/key>\s*<string>([^<]*)<\/string>/g)) {
    if (xmlUnescape(m[1] ?? '') === key) return xmlUnescape(m[2] ?? '');
  }
  return null;
}

export function launchdManager(d: ServiceDeps): ServiceManager {
  const file = join(d.home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
  const logPath = join(d.home, 'Library', 'Logs', 'kage.log');
  const domain = `gui/${d.uid}`;
  const target = `${domain}/${LAUNCHD_LABEL}`;
  const launchctl = (...args: string[]) => d.run('launchctl', args);

  return {
    kind: 'launchd',
    file,
    name: `launchd agent ${LAUNCHD_LABEL}`,

    async unavailable() {
      const r = await launchctl('version');
      return r.missing ? NO_LAUNCHCTL_SENTENCE : null;
    },

    async install(spec) {
      // launchd creates the log file, not its folder.
      mkdirSync(join(d.home, 'Library', 'Logs'), { recursive: true });
      writeServiceFile(file, renderPlist(spec, logPath));
      // Bootstrapping a loaded label fails, so a reinstall boots it out first (ignored if not loaded).
      await launchctl('bootout', target);
      const args = ['bootstrap', domain, file];
      mustSucceed(await launchctl(...args), ['launchctl', ...args]);
    },

    async restart() {
      const args = ['kickstart', '-k', target];
      mustSucceed(await launchctl(...args), ['launchctl', ...args]);
    },

    async remove() {
      await launchctl('bootout', target);
      rmSync(file, { force: true });
    },

    async state(): Promise<ServiceState> {
      const r = await launchctl('print', target);
      if (r.code !== 0) return existsSync(file) ? 'inactive' : 'missing';
      // print's output is not API (Apple): only "state = running" counts as running.
      if (/^\s*state = running\s*$/m.test(r.stdout)) return 'active';
      const last = /^\s*last exit code = (-?\d+)/m.exec(r.stdout)?.[1];
      return last !== undefined && last !== '0' ? 'failed' : 'inactive';
    },

    async pathOfInstalled() {
      try {
        return plistEnvValue(readFileSync(file, 'utf8'), 'PATH');
      } catch {
        return null;
      }
    },
  };
}
