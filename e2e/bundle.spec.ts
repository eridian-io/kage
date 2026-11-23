import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { SERVER_ENV } from './env.ts';
import { BUNDLE, HOOK_BUNDLE, ROOT, SHIPPED_ENV, SHIPPED_FLAGS } from './harness.ts';

/**
 * The shipped server (ruling R91): the one-file bundle `pnpm build` writes, run with the shipped
 * flags, serves the board and runs `kage hook`. The perf project measures it in live mode.
 */
test.describe('the server bundle', () => {
  test.skip(!existsSync(BUNDLE), 'Needs the server bundle (corepack pnpm build)');
  const port = 4396;

  test('kage serve --demo from the bundle answers / with the board', async () => {
    const c = spawn(
      process.execPath,
      [...SHIPPED_FLAGS, BUNDLE, 'serve', '--demo', '--port', String(port)],
      {
        cwd: ROOT,
        env: { ...process.env, ...SERVER_ENV, ...SHIPPED_ENV },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let out = '';
    try {
      await new Promise<void>((resolve, reject) => {
        const onData = (d: Buffer) => {
          out += d.toString();
          if (out.includes('Kage is running at')) resolve();
        };
        c.stdout?.on('data', onData);
        c.stderr?.on('data', onData);
        c.once('error', reject);
        c.once('exit', (code) => reject(new Error(`The bundle exited (${code}):\n${out}`)));
      });
      const res = await fetch(`http://127.0.0.1:${port}/`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('<!doctype html>');
    } finally {
      const exited = new Promise<void>((resolve) => c.once('exit', () => resolve()));
      if (c.exitCode === null && c.signalCode === null) c.kill('SIGTERM');
      await exited;
    }
  });

  for (const [name, file] of [
    ['kage.mjs', BUNDLE],
    ['kage-hook.mjs', HOOK_BUNDLE],
  ] as const) {
    test(`kage hook from ${name} exits 0 and prints nothing (no Kage listening)`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'kage-bundle-'));
      try {
        const r = await new Promise<{ code: number | null; out: string }>((resolve, reject) => {
          const c = spawn(process.execPath, ['--no-warnings', file, 'hook', 'PostToolUse'], {
            cwd: ROOT,
            env: { ...process.env, KAGE_SOCKET: join(dir, 'kage.sock'), TMUX_PANE: '%1' },
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
          c.once('exit', (code) => resolve({ code, out }));
          c.stdin.end(JSON.stringify({ session_id: 's-1', hook_event_name: 'PostToolUse' }));
        });
        expect(r).toEqual({ code: 0, out: '' });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
