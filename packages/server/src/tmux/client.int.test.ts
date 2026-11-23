import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { hasTmux, SEND_TEXT_MAX_BYTES, TmuxClient } from './client.ts';

const sock = `kage-test-${randomBytes(4).toString('hex')}`;
const tmp = mkdtempSync(join(tmpdir(), 'kage-tmux-'));

/** Polls until `check` returns a value other than undefined (or 10 s pass). */
async function until<T>(
  check: () => T | undefined | Promise<T | undefined>,
): Promise<T | undefined> {
  for (let i = 0; i < 100; i++) {
    const v = await check();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  return undefined;
}

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
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
    const windows = await client.listWindows();
    expect(windows.length).toBe(1);
    // R22: the window Kage created to hold the session is tagged as its placeholder.
    expect(windows[0]?.placeholder).toBe(true);
    await client.clearPlaceholder(windows[0]?.windowId as string);
    expect((await client.listWindows())[0]?.placeholder).toBe(false);
  });

  it('lists the windows without a UTF-8 locale, as a service runs (tmux -u)', async () => {
    // Without -u, tmux writes each tab of the -F format as "_" here and no line parses.
    const keys = ['LANG', 'LC_ALL', 'LC_CTYPE'] as const;
    const saved = keys.map((k) => process.env[k]);
    for (const k of keys) delete process.env[k];
    process.env.LC_ALL = 'C';
    try {
      const windows = await client.listWindows();
      expect(windows.length).toBe(1);
      expect(windows[0]?.windowId).toMatch(/^@\d+$/);
    } finally {
      keys.forEach((k, i) => {
        const v = saved[i];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      });
    }
  });

  it.runIf(process.platform === 'linux')(
    "the first window's shell gets the session env (new-session -e KAGE_SOCKET)",
    async () => {
      const sock2 = `kage-test-${randomBytes(4).toString('hex')}`;
      const c = new TmuxClient({
        session: 'kage',
        socket: sock2,
        configFile: '/dev/null',
        env: { KAGE_SOCKET: '/tmp/kage first.sock' },
      });
      try {
        await c.ensureSession();
        const [w] = await c.listWindows();
        const environ = readFileSync(`/proc/${w?.panePid}/environ`, 'utf8').split('\0');
        expect(environ).toContain('KAGE_SOCKET=/tmp/kage first.sock');
      } finally {
        try {
          execFileSync('tmux', ['-L', sock2, 'kill-server'], { stdio: 'ignore' });
        } catch {}
      }
    },
  );

  it('setEnvironment sets a session variable that new windows inherit', async () => {
    await client.setEnvironment('KAGE_SOCKET', '/tmp/kage test.sock');
    expect(tmux('show-environment', '-t', 'kage', 'KAGE_SOCKET').trim()).toBe(
      'KAGE_SOCKET=/tmp/kage test.sock',
    );
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

  it('newWindow starts argv directly, tagged, with its env (K1, K4)', async () => {
    const { windowId, paneId } = await client.newWindow({
      name: 'sleeper',
      cwd: tmp,
      env: { K: 'kage value' },
      argv: ['sleep', '30'],
      kageId: 'kid-1',
    });
    expect(windowId).toMatch(/^@\d+$/);
    expect(paneId).toMatch(/^%\d+$/);
    const w = (await client.listWindows()).find((x) => x.windowId === windowId);
    expect(w).toMatchObject({
      paneId,
      command: 'sleep',
      kageId: 'kid-1',
      name: 'sleeper',
      dead: false,
    });
    expect(await client.windowKageId(windowId)).toBe('kid-1');

    const out = join(tmp, 'env.txt');
    await client.newWindow({
      name: 'env',
      cwd: tmp,
      env: { K: 'kage value' },
      argv: ['sh', '-c', 'printenv K > "$0"; exec sleep 30', out],
      kageId: 'kid-2',
    });
    const text = await until(() => (existsSync(out) && readFileSync(out, 'utf8')) || undefined);
    expect(text).toBe('kage value\n');
  }, 20_000);

  it('newWindow throws when argv[0] does not exist and leaves no window (K4)', async () => {
    const before = (await client.listWindows()).length;
    await expect(
      client.newWindow({
        name: 'missing',
        cwd: tmp,
        env: {},
        argv: ['/no/such/claude', '--version'],
        kageId: 'kid-x',
      }),
    ).rejects.toThrow("didn't start");
    const after = await client.listWindows();
    expect(after.find((x) => x.name === 'missing')).toBeUndefined();
    expect(after.length).toBe(before);
  });

  it('windowKageId is null for an untagged window, which killOwnedWindow leaves alone', async () => {
    const id = tmux('new-window', '-d', '-P', '-F', '#{window_id}', '-t', 'kage').trim();
    expect(await client.windowKageId(id)).toBeNull();
    expect(await client.killOwnedWindow(id, 'kid-1')).toBe(false);
    expect((await client.listWindows()).some((x) => x.windowId === id)).toBe(true);
    tmux('kill-window', '-t', id);
    // Gone now: false, not an error.
    expect(await client.killOwnedWindow(id, 'kid-1')).toBe(false);
  });

  it('killOwnedWindow leaves a window tagged with another id', async () => {
    const { windowId } = await client.newWindow({
      name: 'other',
      cwd: tmp,
      env: {},
      argv: ['sleep', '30'],
      kageId: 'kid-other',
    });
    expect(await client.killOwnedWindow(windowId, 'kid-1')).toBe(false);
    expect((await client.listWindows()).some((x) => x.windowId === windowId)).toBe(true);
    expect(await client.killOwnedWindow(windowId, 'kid-other')).toBe(true);
    expect((await client.listWindows()).some((x) => x.windowId === windowId)).toBe(false);
  });

  it('a literal # (and a tab) in the window name and folder survive; no format job runs', async () => {
    const odd = 'd#(touch pwned)#{pane_id}\tx';
    const dir = join(tmp, odd);
    mkdirSync(dir);
    const { windowId } = await client.newWindow({
      name: `n#(touch pwned)#{pane_id}\tz`,
      cwd: dir,
      env: {},
      argv: ['sleep', '30'],
      kageId: 'kid-hash',
    });
    const w = (await client.listWindows()).find((x) => x.windowId === windowId);
    // The folder is exact; the name, display only, has its tab replaced by a space.
    expect(w).toMatchObject({ cwd: dir, name: 'n#(touch pwned)#{pane_id} z', kageId: 'kid-hash' });
    await new Promise((r) => setTimeout(r, 300));
    expect(existsSync(join(tmp, 'pwned'))).toBe(false);
    expect(existsSync(join(dir, 'pwned'))).toBe(false);
    expect(await client.killOwnedWindow(windowId, 'kid-hash')).toBe(true);
  }, 20_000);

  it('sendText types into a cat window, which capture-pane shows; killOwnedWindow removes it', async () => {
    const { windowId, paneId } = await client.newWindow({
      name: 'cat',
      cwd: tmp,
      env: {},
      argv: ['cat', '-'],
      kageId: 'kid-cat',
    });
    await client.sendText(paneId, '-l $(echo no) é 🙂 kage-typed');
    const shown = await until(async () => {
      const t = await client.capturePane(paneId, 20);
      return t.includes('kage-typed') ? t : undefined;
    });
    expect(shown).toContain('-l $(echo no) é 🙂 kage-typed');
    expect(await client.killOwnedWindow(windowId, 'kid-cat')).toBe(true);
    expect((await client.listWindows()).find((x) => x.windowId === windowId)).toBeUndefined();
  }, 20_000);

  it(`sendText delivers ${SEND_TEXT_MAX_BYTES} bytes of mixed text intact in one call (K10)`, async () => {
    let text = '';
    while (Buffer.byteLength(text) + 8 <= SEND_TEXT_MAX_BYTES) text += 'ab🙂é';
    while (Buffer.byteLength(text) < SEND_TEXT_MAX_BYTES) text += 'x';
    const size = Buffer.byteLength(text);
    const out = join(tmp, 'typed.txt');
    const { windowId, paneId } = await client.newWindow({
      name: 'raw',
      cwd: tmp,
      env: {},
      argv: ['sh', '-c', `stty -icanon -echo; head -c ${size} > "$0"; exec sleep 30`, out],
      kageId: 'kid-raw',
    });
    await client.sendText(paneId, text);
    const got = await until(() => {
      const t = existsSync(out) ? readFileSync(out, 'utf8') : '';
      return Buffer.byteLength(t) >= size ? t : undefined;
    });
    expect(got).toBe(text);
    expect(await client.killOwnedWindow(windowId, 'kid-raw')).toBe(true);
  }, 20_000);

  it('B14: a split window is listed once, by the hook pane when one is given', async () => {
    const { windowId, paneId } = await client.newWindow({
      name: 'split',
      cwd: tmp,
      env: {},
      argv: ['sleep', '30'],
      kageId: 'kid-split',
    });
    const second = tmux(
      'split-window',
      '-d',
      '-P',
      '-F',
      '#{pane_id}',
      '-t',
      windowId,
      'sleep',
      '31',
    ).trim();
    const mine = (ws: Awaited<ReturnType<typeof client.listWindows>>) =>
      ws.filter((x) => x.windowId === windowId).map((x) => x.paneId);
    expect(mine(await client.listWindows())).toEqual([paneId]);
    expect(mine(await client.listWindows(new Set([second])))).toEqual([second]);
    expect(await client.killOwnedWindow(windowId, 'kid-split')).toBe(true);
  });

  it('capturePane returns text printed in the pane', async () => {
    const w = (await client.listWindows()).find((x) => x.name === 'second');
    const pane = w?.paneId as string;
    tmux('send-keys', '-t', pane, 'echo kage-marker-$((6*7))', 'Enter');
    let text = '';
    for (let i = 0; i < 150 && !text.includes('kage-marker-42'); i++) {
      await new Promise((r) => setTimeout(r, 100));
      text = await client.capturePane(pane, 50);
    }
    expect(text).toContain('kage-marker-42');
  }, 20_000);
});
