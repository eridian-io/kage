import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as esbuild from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BUNDLE, bundleHook, HOOK_BUNDLE, hookBuildOptions } from './bundle.ts';
import type { HookEvent } from './hooks/event.ts';
import { HookServer } from './hooks/server.ts';

const FIXTURES = join(import.meta.dirname, '../test/fixtures/hooks');

/** Runs the file with node and the args, `stdin` on stdin; under a temp env (F24). */
function runNode(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  stdin: string,
): Promise<{ code: number | null; out: string; ms: number }> {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const c = spawn(process.execPath, ['--no-warnings', file, ...args], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    c.stdout.on('data', (d: Buffer) => {
      out += d.toString();
    });
    c.stderr.on('data', (d: Buffer) => {
      out += d.toString();
    });
    c.once('error', reject);
    c.once('exit', (code) => resolve({ code, out, ms: performance.now() - t0 }));
    c.stdin.on('error', () => {});
    c.stdin.end(stdin);
  });
}

describe('the hook entry (performance P2)', () => {
  let dir = '';
  let file = '';
  let env: NodeJS.ProcessEnv = {};
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'kage-hookbundle-'));
    file = join(dir, 'kage-hook.mjs');
    await bundleHook(file);
    env = {
      PATH: process.env.PATH,
      HOME: dir,
      XDG_CONFIG_HOME: join(dir, 'config'),
      XDG_STATE_HOME: join(dir, 'state'),
      XDG_RUNTIME_DIR: join(dir, 'run'),
      ...(process.platform === 'win32' ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}),
    };
  }, 60_000);
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('HOOK_BUNDLE is dist/kage-hook.mjs beside the server bundle', () => {
    expect(HOOK_BUNDLE).toBe(join(BUNDLE, '..', 'kage-hook.mjs'));
  });

  it('kage-hook.mjs is under 8 KB and imports no node:http', async () => {
    expect(statSync(file).size).toBeLessThan(8 * 1024);
    const meta = await esbuild.build({
      ...hookBuildOptions(join(dir, 'meta', 'kage-hook.mjs')),
      metafile: true,
      write: false,
    });
    const outputs = Object.values(meta.metafile.outputs);
    expect(outputs).toHaveLength(1);
    const imports = outputs[0]?.imports.map((i) => i.path) ?? [];
    expect(imports.every((p) => p.startsWith('node:'))).toBe(true);
    for (const heavy of ['node:http', 'node:http2', 'node:https', 'node:zlib', 'node:crypto']) {
      expect(imports).not.toContain(heavy);
    }
    expect(imports).toContain('node:net');
    expect(readFileSync(file, 'utf8')).not.toMatch(/["']node:http["']|["']http["']/);
  });

  it('kage-hook.mjs delivers a Stop to a running server', async () => {
    const sock =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\kage-hookbundle-${randomBytes(4).toString('hex')}`
        : join(dir, 'run', 'kage.sock');
    const server = new HookServer(sock);
    await server.listen();
    try {
      const got: HookEvent[] = [];
      server.on((e) => got.push(e));
      const stop = readFileSync(join(FIXTURES, 'stop.json'), 'utf8');
      const r = await runNode(
        file,
        ['hook', 'Stop'],
        { ...env, KAGE_SOCKET: sock, TMUX_PANE: '%3' },
        stop,
      );
      expect({ code: r.code, out: r.out }).toEqual({ code: 0, out: '' });
      expect(got).toHaveLength(1);
      expect(got[0]).toMatchObject({ event: 'Stop', pane: '%3' });
    } finally {
      await server.close();
    }
  });

  it('with no server, no event or bad stdin, it exits 0 quickly and prints nothing', async () => {
    const missing =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\kage-missing-${randomBytes(4).toString('hex')}`
        : join(dir, 'run', 'missing.sock');
    const e = { ...env, KAGE_SOCKET: missing };
    const stop = readFileSync(join(FIXTURES, 'stop.json'), 'utf8');
    for (const [args, stdin] of [
      [['hook', 'Stop'], stop],
      [['hook'], stop],
      [[], stop],
      [['hook', 'Stop'], '{nope'],
    ] as [string[], string][]) {
      const r = await runNode(file, args, e, stdin);
      expect({ args, code: r.code, out: r.out }).toEqual({ args, code: 0, out: '' });
      expect(r.ms).toBeLessThan(1500);
    }
  });
});
