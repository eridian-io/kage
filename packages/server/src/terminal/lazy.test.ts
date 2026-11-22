import type { IncomingMessage } from 'node:http';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { LazyTerminals, type TerminalModule } from './lazy.ts';
import type { TerminalServerDeps } from './server.ts';

const DEPS: TerminalServerDeps = {
  allowed: { hostNames: ['127.0.0.1'], port: 8080 },
  token: '',
  source: null,
  bridge: null,
  tmux: null,
};

/** A stand-in for terminal/server.ts: records what the real one would have been asked. */
function fakeModule() {
  const calls: string[] = [];
  let loads = 0;
  class FakeServer {
    constructor(d: TerminalServerDeps) {
      calls.push(`new ${d.token === DEPS.token ? 'deps' : '?'}`);
    }
    handleUpgrade(req: IncomingMessage): void {
      calls.push(`upgrade ${req.url}`);
    }
    close(): void {
      calls.push('close');
    }
  }
  const load = async (): Promise<TerminalModule> => {
    loads++;
    return { TerminalServer: FakeServer } as unknown as TerminalModule;
  };
  return { calls, load, loads: () => loads };
}

const req = (url: string) => ({ url }) as IncomingMessage;
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('LazyTerminals (ws and the terminal server load on the first upgrade)', () => {
  it('loads nothing until an upgrade arrives', async () => {
    const m = fakeModule();
    const t = new LazyTerminals(DEPS, m.load);
    await flush();
    expect(m.loads()).toBe(0);
    expect(t.loaded).toBe(false);
    t.close();
    expect(m.loads()).toBe(0);
  });

  it('the first upgrade loads the module once; every upgrade reaches the server in order', async () => {
    const m = fakeModule();
    const t = new LazyTerminals(DEPS, m.load);
    t.handleUpgrade(req('/a'), new PassThrough(), Buffer.alloc(0));
    t.handleUpgrade(req('/b'), new PassThrough(), Buffer.alloc(0));
    await flush();
    t.handleUpgrade(req('/c'), new PassThrough(), Buffer.alloc(0));
    expect(m.loads()).toBe(1);
    expect(t.loaded).toBe(true);
    expect(m.calls).toEqual(['new deps', 'upgrade /a', 'upgrade /b', 'upgrade /c']);
  });

  it('close() during the load closes the server before any upgrade reaches it (it refuses them)', async () => {
    const m = fakeModule();
    const t = new LazyTerminals(DEPS, m.load);
    t.handleUpgrade(req('/a'), new PassThrough(), Buffer.alloc(0));
    t.close();
    await flush();
    expect(m.calls).toEqual(['new deps', 'close', 'upgrade /a']);
    t.close();
    expect(m.calls.at(-1)).toBe('close');
  });

  it('a failed load destroys the waiting sockets', async () => {
    const t = new LazyTerminals(DEPS, async () => {
      throw new Error('no ws');
    });
    const socket = new PassThrough();
    t.handleUpgrade(req('/a'), socket, Buffer.alloc(0));
    await flush();
    expect(socket.destroyed).toBe(true);
  });

  it('the default importer is the real terminal server', async () => {
    const t = new LazyTerminals(DEPS);
    const socket = new PassThrough();
    t.close();
    t.handleUpgrade(req('/api/sessions/x/terminal'), socket, Buffer.alloc(0));
    await expect.poll(() => t.loaded).toBe(true);
  });
});
