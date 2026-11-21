import { execFile, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type Listener,
  makeScanner,
  type Proc,
  parseLsof,
  parsePs,
  parseSs,
  portsFor,
  processLabel,
  scanCommands,
} from './ports.ts';

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dirname, '../../test/fixtures/ports', name), 'utf8');

/** The five listeners host-integration §3 recorded, with the fixtures' pids. */
const RECORDED: Listener[] = [
  { port: 8765, address: '127.0.0.1', pid: 4202 },
  { port: 8768, address: '0.0.0.0', pid: 4205 },
  { port: 8767, address: '::1', pid: 4204 },
  { port: 8769, address: '*', pid: 4206 },
  { port: 8766, address: '*', pid: 4203 },
];

describe('parseSs', () => {
  it('parses every listener with a process in the recorded ss output, IPv6 included', () => {
    // Lines without a users: field (other users' sockets, the DNS stub) carry no pid: skipped.
    expect(parseSs(fixture('ss.txt'))).toEqual(RECORDED);
  });

  it('reads interface-scoped addresses and every pid that shares a socket', () => {
    const out = [
      'LISTEN 0 5 127.0.0.53%lo:5353 0.0.0.0:* users:(("x",pid=7,fd=3))',
      'LISTEN 0 511 *:3000 *:* users:(("node",pid=10,fd=21),("node",pid=11,fd=21))',
      '',
      'garbage',
    ].join('\n');
    expect(parseSs(out)).toEqual([
      { port: 5353, address: '127.0.0.53', pid: 7 },
      { port: 3000, address: '*', pid: 10 },
      { port: 3000, address: '*', pid: 11 },
    ]);
  });
});

describe('parseLsof', () => {
  it('parses every listener in the p/f/n form, skipping f lines', () => {
    // lsof.txt is built from the man page's macOS form (lsof 4.88–4.93.2 always add the f field)
    // with the names observed on Linux: it was NOT observed on a Mac (host-integration §3).
    expect(parseLsof(fixture('lsof.txt'))).toEqual([
      { port: 8765, address: '127.0.0.1', pid: 4202 },
      { port: 8766, address: '*', pid: 4203 },
      { port: 8767, address: '::1', pid: 4204 },
      { port: 8768, address: '*', pid: 4205 },
      { port: 8769, address: '*', pid: 4206 },
    ]);
  });

  it('parses the Linux form without f lines and several n lines per process', () => {
    expect(parseLsof('p12\nn127.0.0.1:5173\nn[::1]:5173\np13\ncnode\nn*:3000\n')).toEqual([
      { port: 5173, address: '127.0.0.1', pid: 12 },
      { port: 5173, address: '::1', pid: 12 },
      { port: 3000, address: '*', pid: 13 },
    ]);
  });
});

describe('parsePs', () => {
  it('parses the right-aligned pid and ppid and the full command line', () => {
    const procs = parsePs(fixture('ps.txt'));
    expect(procs).toHaveLength(13);
    expect(procs[0]).toEqual({ pid: 1, ppid: 0, args: '/sbin/init' });
    expect(procs.find((p) => p.pid === 4202)).toEqual({
      pid: 4202,
      ppid: 4150,
      args: 'python3 -m http.server 8765 --bind 127.0.0.1',
    });
  });
});

describe('processLabel', () => {
  it('names an interpreter run by its script or module', () => {
    expect(processLabel('node /p/node_modules/.bin/vite --port 5173')).toBe('vite');
    expect(processLabel('python3 -m http.server 8765 --bind 127.0.0.1')).toBe('http.server');
    expect(processLabel('/usr/bin/python /srv/app/manage.py runserver')).toBe('manage');
    expect(processLabel('ruby bin/rails server')).toBe('rails');
    expect(processLabel('bun run dev')).toBe('dev');
  });

  it('names inline code by its interpreter, and other programs by their basename', () => {
    expect(processLabel("node -e require('http').createServer().listen(8766)")).toBe('node');
    expect(processLabel('/usr/bin/caddy run')).toBe('caddy');
    expect(processLabel('node')).toBe('node');
  });

  it('is at most 20 characters for a 300-character command line', () => {
    const label = processLabel(`/opt/${'x'.repeat(295)}`);
    expect(label.length).toBeLessThanOrEqual(20);
    expect(label).toBe('x'.repeat(20));
    expect(processLabel(`node ${'y'.repeat(295)}.js`).length).toBeLessThanOrEqual(20);
  });

  it('drops control and bidi characters', () => {
    expect(processLabel('/bin/ev‮il\u0007 x')).toBe('evil');
  });
});

describe('portsFor', () => {
  const procs = parsePs(fixture('ps.txt'));

  it('keeps the listeners in the pane process tree, one per port, sorted, labelled from ps', () => {
    // claude 4100 → bash 4150 → the five listeners (K6: labels from ps, not ss's MainThread).
    expect(portsFor(4100, parseSs(fixture('ss.txt')), procs)).toEqual([
      { port: 8765, process: 'http.server', localOnly: true },
      { port: 8766, process: 'node', localOnly: false },
      { port: 8767, process: 'http.server', localOnly: true },
      { port: 8768, process: 'http.server', localOnly: false },
      { port: 8769, process: 'node', localOnly: false },
    ]);
  });

  it('finds a vite under sh → node under the pane pid, not an unrelated listener', () => {
    const tree: Proc[] = [
      { pid: 50, ppid: 1, args: 'claude' },
      { pid: 60, ppid: 50, args: 'sh -c npm run dev' },
      { pid: 70, ppid: 60, args: 'node /w/node_modules/.bin/vite --port 5173' },
      { pid: 80, ppid: 1, args: 'node /other/server.js' },
    ];
    const listeners: Listener[] = [
      { port: 5173, address: '127.0.0.1', pid: 70 },
      { port: 4000, address: '0.0.0.0', pid: 80 },
    ];
    expect(portsFor(50, listeners, tree)).toEqual([
      { port: 5173, process: 'vite', localOnly: true },
    ]);
  });

  it('localOnly only when every address is loopback', () => {
    const tree: Proc[] = [{ pid: 9, ppid: 1, args: 'srv' }];
    const one = (address: string) => portsFor(9, [{ port: 1, address, pid: 9 }], tree)[0];
    expect(one('127.0.0.1')?.localOnly).toBe(true);
    expect(one('127.0.0.5')?.localOnly).toBe(true);
    expect(one('::1')?.localOnly).toBe(true);
    for (const a of ['0.0.0.0', '*', '::', '100.101.102.103', '192.168.1.5']) {
      expect(one(a)?.localOnly).toBe(false);
    }
    // The same port on 127.0.0.1 and ::1: one entry, local only.
    expect(
      portsFor(
        9,
        [
          { port: 5173, address: '127.0.0.1', pid: 9 },
          { port: 5173, address: '::1', pid: 9 },
        ],
        tree,
      ),
    ).toEqual([{ port: 5173, process: 'srv', localOnly: true }]);
    // A loopback and a public address on one port: not local only.
    expect(
      portsFor(
        9,
        [
          { port: 5173, address: '127.0.0.1', pid: 9 },
          { port: 5173, address: '*', pid: 9 },
        ],
        tree,
      )[0]?.localOnly,
    ).toBe(false);
  });

  it('survives a ppid cycle and a pane pid missing from ps', () => {
    const tree: Proc[] = [
      { pid: 2, ppid: 3, args: 'a' },
      { pid: 3, ppid: 2, args: 'b' },
    ];
    expect(portsFor(2, [{ port: 1, address: '*', pid: 3 }], tree)).toEqual([
      { port: 1, process: 'b', localOnly: false },
    ]);
    expect(portsFor(99, [{ port: 1, address: '*', pid: 99 }], [])).toEqual([
      { port: 1, process: '', localOnly: false },
    ]);
  });
});

describe('scanCommands', () => {
  it('ss and ps on Linux, lsof and ps on macOS, none elsewhere', () => {
    expect(scanCommands('linux')).toEqual({
      listeners: ['ss', ['-ltnpH']],
      procs: ['ps', ['-A', '-ww', '-o', 'pid=,ppid=,args=']],
    });
    expect(scanCommands('darwin')).toEqual({
      listeners: ['lsof', ['-iTCP', '-sTCP:LISTEN', '-nP', '-F', 'pn']],
      procs: ['ps', ['-A', '-ww', '-o', 'pid=,ppid=,args=']],
    });
    expect(scanCommands('win32')).toBeNull();
    expect(makeScanner('win32')).toBeNull();
  });

  it('the scanner runs both commands with argument arrays and parses by platform', async () => {
    const calls: [string, string[], number][] = [];
    const exec = async (file: string, args: string[], timeoutMs: number) => {
      calls.push([file, args, timeoutMs]);
      return file === 'ps' ? fixture('ps.txt') : fixture(file === 'ss' ? 'ss.txt' : 'lsof.txt');
    };
    const linux = makeScanner('linux', exec);
    const mac = makeScanner('darwin', exec);
    expect((await linux?.())?.listeners).toEqual(RECORDED);
    expect((await mac?.())?.listeners.map((l) => l.port)).toEqual([8765, 8766, 8767, 8768, 8769]);
    expect(calls.map((c) => c[0]).sort()).toEqual(['lsof', 'ps', 'ps', 'ss']);
    expect(calls.every((c) => c[2] === 5000)).toBe(true);
  });
});

const realScan = process.platform === 'linux' && (await hasCommand('ss'));

async function hasCommand(cmd: string): Promise<boolean> {
  return new Promise((resolve) => execFile(cmd, ['-V'], (err) => resolve(!err)));
}

describe.runIf(realScan)('real ss and ps (Linux)', () => {
  it('finds a test listener started under this process, labelled from ps', async () => {
    const script =
      "require('http').createServer().listen(0,'127.0.0.1',function(){console.log(this.address().port)})";
    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] });
    try {
      const port = await new Promise<number>((resolve, reject) => {
        child.stdout.once('data', (d: Buffer) => resolve(Number(String(d).trim())));
        child.once('error', reject);
      });
      const scan = makeScanner('linux');
      if (!scan) throw new Error('no scanner');
      const { listeners, procs } = await scan();
      const ports = portsFor(process.pid, listeners, procs);
      expect(ports).toContainEqual({ port, process: 'node', localOnly: true });
    } finally {
      child.kill();
    }
  });
});
