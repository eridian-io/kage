/**
 * The launchd agent (macOS; host-integration §7.5, documented, not observed). It starts at load
 * and at login, restarts after a non-zero exit at most every 10 s, and logs to
 * ~/Library/Logs/kage.log.
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
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

export const LAUNCHD_LABEL = 'io.eridian.kage';

/** The plist's third line (after the XML declaration and the doctype); without it the file isn't Kage's. */
export const PLIST_MARKER_LINE = `<!-- ${SERVICE_MARKER} -->`;
const isOurPlist = (lines: string[]): boolean => lines[2] === PLIST_MARKER_LINE;

const NO_LAUNCHCTL_SENTENCE =
  'launchctl isn\'t on PATH, so Kage can\'t install its service. Run "kage serve" yourself.';

/** Text for an XML element or attribute: & < > " ' escaped; characters XML 1.0 can't hold throw. */
export function xmlEscape(text: string): string {
  assertWritable(text);
  if (/[\ufffe\uffff]/.test(text)) {
    throw new Error(`A service value can't hold U+FFFE or U+FFFF: ${JSON.stringify(text)}`);
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
  assertAbsoluteProgram(spec.argv);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    PLIST_MARKER_LINE,
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

const BOOTSTRAP_RETRIES = 3;
const BOOTSTRAP_RETRY_MS = 500;
/** No retry starts once this long has passed since the first bootstrap began. */
const BOOTSTRAP_TOTAL_MS = 90_000;

/** bootstrap's "5: Input/output error", which a job still being booted out gives. */
function isBusy(r: RunResult): boolean {
  return r.code === 5 || /\b5: Input\/output error/.test(r.stderr);
}

export function launchdManager(d: ServiceDeps): ServiceManager {
  const file = join(d.home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
  const logPath = join(d.home, 'Library', 'Logs', 'kage.log');
  const domain = `gui/${d.uid}`;
  const target = `${domain}/${LAUNCHD_LABEL}`;
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = d.now ?? Date.now;
  const launchctl = (args: string[], timeoutMs?: number): Promise<RunResult> =>
    d.run('launchctl', args, {
      env: d.env,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });

  return {
    kind: 'launchd',
    file,
    name: `launchd agent ${LAUNCHD_LABEL}`,

    async unavailable() {
      const r = await launchctl(['version']);
      return r.missing ? NO_LAUNCHCTL_SENTENCE : null;
    },

    async install(spec) {
      const text = renderPlist(spec, logPath);
      assertOurs(file, isOurPlist);
      // launchd creates the log file, not its folder.
      mkdirSync(join(d.home, 'Library', 'Logs'), { recursive: true });
      writeServiceFile(file, text);
      // Bootstrapping a loaded label fails, so a reinstall boots it out first (ignored if not loaded).
      await launchctl(['bootout', target]);
      // A label someone disabled (launchctl disable) won't bootstrap.
      const enable = ['enable', target];
      mustSucceed(await launchctl(enable), ['launchctl', ...enable]);
      const args = ['bootstrap', domain, file];
      const started = now();
      let r = await launchctl(args, START_TIMEOUT_MS);
      // Right after a bootout launchd may still be tearing the job down: "5: Input/output error".
      for (
        let retry = 0;
        retry < BOOTSTRAP_RETRIES && isBusy(r) && now() - started < BOOTSTRAP_TOTAL_MS;
        retry++
      ) {
        await sleep(BOOTSTRAP_RETRY_MS);
        r = await launchctl(args, START_TIMEOUT_MS);
      }
      mustSucceed(r, ['launchctl', ...args]);
    },

    async restart() {
      const args = ['kickstart', '-k', target];
      mustSucceed(await launchctl(args, START_TIMEOUT_MS), ['launchctl', ...args]);
    },

    async remove() {
      // The label is Kage's own; a plist of that name kage setup didn't write is left alone.
      assertOurs(file, isOurPlist);
      await launchctl(['bootout', target]);
      rmSync(file, { force: true });
    },

    async state(): Promise<ServiceState> {
      const r = await launchctl(['print', target]);
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
