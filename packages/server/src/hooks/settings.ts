import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HOOK_EVENTS, type HookEventName } from './event.ts';

export const SETTINGS_FILE = 'kage-hooks.json';

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
 * Writes a Claude settings file that registers Kage's hooks and nothing else, for
 * `claude --settings <file>`. Returns the file path.
 */
export async function writeHooksSettings(dir: string, command: string[]): Promise<string> {
  if (command.length === 0) throw new Error('writeHooksSettings: command is empty');
  const hooks: Record<string, unknown> = {};
  for (const event of HOOK_EVENTS) {
    hooks[event] = [
      { matcher: '', hooks: [{ type: 'command', command: hookCommand(command, event) }] },
    ];
  }
  await mkdir(dir, { recursive: true });
  const path = join(dir, SETTINGS_FILE);
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ hooks }, null, 2)}\n`);
  await rename(tmp, path);
  return path;
}
