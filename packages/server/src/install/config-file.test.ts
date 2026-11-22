import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError } from '../config.ts';
import { generateToken, readConfigObject, writeConfig } from './config-file.ts';

const isWin = process.platform === 'win32';
const mode = (p: string) => statSync(p).mode & 0o777;

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kage-cfg-'));
  file = join(dir, 'config', 'kage', 'config.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('generateToken', () => {
  it('is 32 base64url characters, different each time', () => {
    const a = generateToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(generateToken()).not.toBe(a);
  });
});

describe('writeConfig', () => {
  it('a fresh file: the folders are made, the file is 0600 in a 0700 folder, and it parses', async () => {
    await writeConfig(file, { port: 8080, token: 'x'.repeat(32) });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ port: 8080, token: 'x'.repeat(32) });
    expect(readFileSync(file, 'utf8').endsWith('\n')).toBe(true);
    if (!isWin) {
      expect(mode(file)).toBe(0o600);
      expect(mode(join(dir, 'config', 'kage'))).toBe(0o700);
    }
    // Atomic: no temporary file stays behind.
    expect(await readdir(join(dir, 'config', 'kage'))).toEqual(['config.json']);
  });

  it('keeps every key it was not given, byte for byte, and merges the patch', async () => {
    mkdirSync(join(dir, 'config', 'kage'), { recursive: true });
    const before = {
      token: 'secret-token-0123456789',
      ntfyTopic: 'invented-topic-abcdef',
      ntfyToken: 'tk_invented',
      autoArchive: { onMerge: false, afterDays: 3 },
      x: 1,
      port: 8080,
    };
    writeFileSync(file, JSON.stringify(before), { mode: 0o600 });
    await writeConfig(file, { port: 9090 });
    const after = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(after.port).toBe(9090);
    for (const k of ['token', 'ntfyTopic', 'ntfyToken', 'autoArchive', 'x'] as const) {
      expect(JSON.stringify(after[k])).toBe(JSON.stringify(before[k]));
    }
  });

  it('tightens a 0644 file and a 0755 folder', async () => {
    if (isWin) return;
    mkdirSync(join(dir, 'config', 'kage'), { recursive: true, mode: 0o755 });
    chmodSync(join(dir, 'config', 'kage'), 0o755);
    writeFileSync(file, '{"token":"secret-token-0123456789"}');
    chmodSync(file, 0o644);
    await writeConfig(file, { port: 9090 });
    expect(mode(file)).toBe(0o600);
    expect(mode(join(dir, 'config', 'kage'))).toBe(0o700);
  });

  it('nothing differs: the file is left as written, but still tightened', async () => {
    mkdirSync(join(dir, 'config', 'kage'), { recursive: true });
    const text = '{\n    "port": 8080,   "x": 1\n}\n';
    writeFileSync(file, text);
    if (!isWin) chmodSync(file, 0o644);
    await writeConfig(file, { port: 8080 });
    expect(readFileSync(file, 'utf8')).toBe(text);
    if (!isWin) expect(mode(file)).toBe(0o600);
  });

  it('invalid JSON: throws the sentence and leaves the file alone', async () => {
    mkdirSync(join(dir, 'config', 'kage'), { recursive: true });
    writeFileSync(file, '{bad');
    if (!isWin) chmodSync(file, 0o644);
    const err = await writeConfig(file, { port: 9090 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toBe(
      `${file} isn't valid JSON. Fix it or move it away, then run kage setup again.`,
    );
    expect(readFileSync(file, 'utf8')).toBe('{bad');
    if (!isWin) expect(mode(file)).toBe(0o644);
  });

  it('JSON that is not an object: refused the same way', async () => {
    mkdirSync(join(dir, 'config', 'kage'), { recursive: true });
    writeFileSync(file, '[1]');
    await expect(writeConfig(file, { port: 1 })).rejects.toThrow(
      `${file} must hold a JSON object. Fix it or move it away, then run kage setup again.`,
    );
    expect(readFileSync(file, 'utf8')).toBe('[1]');
  });
});

describe('readConfigObject', () => {
  it('null without a file, the object with one', async () => {
    expect(await readConfigObject(file)).toBeNull();
    mkdirSync(join(dir, 'config', 'kage'), { recursive: true });
    writeFileSync(file, '{"a":1}');
    expect(await readConfigObject(file)).toEqual({ a: 1 });
  });
});
