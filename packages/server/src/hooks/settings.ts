import { chmod, mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HOOK_EVENTS, type HookEventName } from './event.ts';

/** The file `kage hooks-path` writes, for `claude --settings <file>`. */
export const SETTINGS_FILE = 'claude-settings.json';

/** POSIX single-quote escaping: the word reaches the program unchanged through `sh -c`. */
export function shellQuote(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

/**
 * Claude runs a hook's `command` through a shell, so the argument list is joined into one
 * string with every element quoted; nothing in it is ever interpreted by the shell.
 */
export function hookCommand(command: readonly string[], event: HookEventName): string {
  return [...command, 'hook', event].map(shellQuote).join(' ');
}

/**
 * An existing directory of ours that group or others can reach is narrowed to 0700. One owned by
 * someone else is left alone (chmod would fail anyway); there is no owner check on Windows.
 */
async function tightenDir(dir: string): Promise<void> {
  const uid = process.getuid?.();
  if (uid === undefined) return;
  const st = await stat(dir);
  if (st.uid === uid && (st.mode & 0o077) !== 0) await chmod(dir, 0o700);
}

/**
 * Writes a Claude settings file that registers Kage's hooks and nothing else, for
 * `claude --settings <file>`. Returns the file path. The directory is 0700 (an existing one of
 * ours that is looser is tightened) and the file 0600.
 */
export async function writeHooksSettings(dir: string, command: string[]): Promise<string> {
  if (command.length === 0) throw new Error('writeHooksSettings: command is empty');
  const hooks: Record<string, unknown> = {};
  for (const event of HOOK_EVENTS) {
    hooks[event] = [
      { matcher: '', hooks: [{ type: 'command', command: hookCommand(command, event) }] },
    ];
  }
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await tightenDir(dir);
  const path = join(dir, SETTINGS_FILE);
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ hooks }, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
  return path;
}
