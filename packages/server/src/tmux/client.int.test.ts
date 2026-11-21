import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { hasTmux, TmuxClient } from './client.ts';

const sock = `kage-test-${randomBytes(4).toString('hex')}`;

afterAll(() => {
  try {
    execFileSync('tmux', ['-L', sock, 'kill-server'], { stdio: 'ignore' });
  } catch {
    // no server, or no tmux: nothing to clean up
  }
});

describe.runIf(hasTmux)('TmuxClient (real tmux, private socket)', () => {
  const client = new TmuxClient({ session: 'kage', socket: sock, configFile: '/dev/null' });
  const tmux = (...a: string[]) =>
    execFileSync('tmux', ['-f', '/dev/null', '-L', sock, ...a], { encoding: 'utf8' });

  it('lists no windows when there is no server', async () => {
    expect(await client.listWindows()).toEqual([]);
  });

  it('ensureSession creates the session, idempotently', async () => {
    await Promise.all([client.ensureSession(), client.ensureSession(), client.ensureSession()]);
    await client.ensureSession();
    expect((await client.listWindows()).length).toBe(1);
  });

  it('reads back a kage id set on a second window', async () => {
    tmux('new-window', '-d', '-t', 'kage', '-n', 'second');
    const w = (await client.listWindows()).find((x) => x.name === 'second');
    expect(w?.kageId).toBeNull();
    await client.setKageId(w?.windowId as string, 'abc-123');
    const w2 = (await client.listWindows()).find((x) => x.name === 'second');
    expect(w2?.kageId).toBe('abc-123');
    expect(w2?.panePid).toBeGreaterThan(0);
    expect(w2?.activity).toBeGreaterThan(1_000_000_000);
  });

  it('capturePane returns text printed in the pane', async () => {
    const w = (await client.listWindows()).find((x) => x.name === 'second');
    const pane = w?.paneId as string;
    tmux('send-keys', '-t', pane, 'echo kage-marker-$((6*7))', 'Enter');
    let text = '';
    for (let i = 0; i < 40 && !text.includes('kage-marker-42'); i++) {
      await new Promise((r) => setTimeout(r, 100));
      text = await client.capturePane(pane, 50);
    }
    expect(text).toContain('kage-marker-42');
  });
});
