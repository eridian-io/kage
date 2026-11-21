import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HOOK_EVENTS } from './event.ts';
import { hookCommand, shellQuote, writeHooksSettings } from './settings.ts';

/** A tiny POSIX-sh word splitter for single-quoted words separated by spaces (what we emit). */
function unquote(command: string): string[] {
  const words: string[] = [];
  let cur: string | null = null;
  let i = 0;
  while (i < command.length) {
    const c = command[i] as string;
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      if (end < 0) throw new Error('unterminated quote');
      cur = (cur ?? '') + command.slice(i + 1, end);
      i = end + 1;
    } else if (c === '\\') {
      cur = (cur ?? '') + (command[i + 1] ?? '');
      i += 2;
    } else if (c === ' ') {
      if (cur !== null) words.push(cur);
      cur = null;
      i++;
    } else {
      throw new Error(`unquoted character ${JSON.stringify(c)} at ${i}`);
    }
  }
  if (cur !== null) words.push(cur);
  return words;
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kage-settings-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const COMMAND = ['/usr/bin/node', "/home/dev/it's a dir/main.ts"];

describe('shellQuote', () => {
  it('single-quotes every word and escapes single quotes', () => {
    expect(shellQuote('plain')).toBe("'plain'");
    expect(shellQuote('')).toBe("''");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    expect(shellQuote('$(rm -rf ~) `x` "y" \\ ;|&')).toBe('\'$(rm -rf ~) `x` "y" \\ ;|&\'');
  });

  it('round-trips through the POSIX rules', () => {
    for (const w of ["it's", "''", "a'b'c", ' lead', 'new\nline', '$HOME', '*']) {
      expect(unquote(shellQuote(w))).toEqual([w]);
    }
  });
});

describe('writeHooksSettings', () => {
  it('writes claude-settings.json in the dir and returns its path', async () => {
    const path = await writeHooksSettings(dir, COMMAND);
    expect(path).toBe(join(dir, 'claude-settings.json'));
    expect(() => JSON.parse(readFileSync(path, 'utf8'))).not.toThrow();
  });

  it.runIf(process.platform !== 'win32')(
    'creates the dir 0700 and writes the file 0600',
    async () => {
      const path = await writeHooksSettings(join(dir, 'state', 'kage'), COMMAND);
      expect(statSync(join(dir, 'state', 'kage')).mode & 0o777).toBe(0o700);
      expect(statSync(path).mode & 0o777).toBe(0o600);
    },
  );

  it.runIf(process.platform !== 'win32')(
    'tightens an existing dir of ours that is looser than 0700',
    async () => {
      const state = join(dir, 'state');
      mkdirSync(state);
      chmodSync(state, 0o755);
      await writeHooksSettings(state, COMMAND);
      expect(statSync(state).mode & 0o777).toBe(0o700);
    },
  );

  it('creates the dir when missing', async () => {
    const path = await writeHooksSettings(join(dir, 'a', 'b'), COMMAND);
    expect(path).toBe(join(dir, 'a', 'b', 'claude-settings.json'));
  });

  it('registers all nine events, each running exactly command + hook <Event>', async () => {
    expect(HOOK_EVENTS).toHaveLength(9);
    const settings = JSON.parse(readFileSync(await writeHooksSettings(dir, COMMAND), 'utf8'));
    expect(Object.keys(settings.hooks).sort()).toEqual([...HOOK_EVENTS].sort());
    for (const event of HOOK_EVENTS) {
      expect(settings.hooks[event]).toEqual([
        { matcher: '', hooks: [{ type: 'command', command: hookCommand(COMMAND, event) }] },
      ]);
      expect(unquote(settings.hooks[event][0].hooks[0].command)).toEqual([
        ...COMMAND,
        'hook',
        event,
      ]);
    }
  });

  it('contains no other settings', async () => {
    const settings = JSON.parse(readFileSync(await writeHooksSettings(dir, COMMAND), 'utf8'));
    expect(Object.keys(settings)).toEqual(['hooks']);
  });

  it('overwrites an earlier file', async () => {
    await writeHooksSettings(dir, ['old']);
    const settings = JSON.parse(readFileSync(await writeHooksSettings(dir, COMMAND), 'utf8'));
    expect(unquote(settings.hooks.Stop[0].hooks[0].command)).toEqual([...COMMAND, 'hook', 'Stop']);
  });

  it('rejects an empty command', async () => {
    await expect(writeHooksSettings(dir, [])).rejects.toThrow();
  });
});

describe.runIf(process.platform !== 'win32')('hook command through sh -c', () => {
  it('a path with a space and a single quote round-trips', () => {
    const argv = ['printf', '%s\\0', `${dir}/it's a dir/main.ts`, '$HOME', '`id`'];
    const cmd = hookCommand(argv, 'Stop');
    const out = execFileSync('sh', ['-c', cmd], { encoding: 'utf8' });
    expect(out.split('\0').slice(0, -1)).toEqual([
      `${dir}/it's a dir/main.ts`,
      '$HOME',
      '`id`',
      'hook',
      'Stop',
    ]);
  });
});
