import { createHash } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServerStatus } from '../hooks/server.ts';
import type { Io } from '../main.ts';
import { KAGE_VERSION, type RunMode } from './runtime.ts';
import type { ServiceManager, ServiceState } from './service.ts';
import { hostTarget } from './targets.ts';
import {
  assetName,
  compareVersions,
  downloadVerified,
  parseSums,
  RELEASE_BASE,
  ReleaseError,
  releaseBase,
  replaceBinary,
  shellWord,
  type UpdateDeps,
  updateCommand,
} from './update.ts';

const TARGET = hostTarget('linux', process.arch === 'arm64' ? 'arm64' : 'x64');
if (TARGET === null) throw new Error('no target');
const ASSET = assetName(TARGET);
const NEW = Buffer.from('#!/bin/sh\necho new kage\n');
const NEW_VERSION = '9.0.0';
const isWindows = process.platform === 'win32';

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

let dir: string;
let exe: string;
let server: Server;
let base: string;
let routes: Map<string, Handler>;
let hits: string[];
/** Set by the fake manager's restart; the fake status answers the new version after it. */
let restarted: boolean;

/** The release lives under /rel/ on the server. */
function route(name: string, h: Handler | null) {
  if (h === null) routes.delete(`/rel/${name}`);
  else routes.set(`/rel/${name}`, h);
}

function send(body: Uint8Array | string, status = 200): Handler {
  return (_req, res) => {
    res.writeHead(status, { 'content-length': Buffer.byteLength(body) });
    res.end(body);
  };
}

/** A release as the SEA sees it: VERSION, SHA256SUMS over the asset, and the asset. */
function release(o: { version?: string; gz?: Uint8Array; sums?: string } = {}) {
  const gz = o.gz ?? gzipSync(NEW);
  route('VERSION', send(`${o.version ?? NEW_VERSION}\n`));
  route(
    'SHA256SUMS',
    send(
      o.sums ??
        `${sha(gzipSync(Buffer.from('other')))}  kage-darwin-x64.gz\n${sha(gz)}  ${ASSET}\n`,
    ),
  );
  route(ASSET, send(gz));
  return gz;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kage-update-'));
  exe = join(dir, 'bin', 'kage');
  mkdirSync(join(dir, 'bin'));
  writeFileSync(exe, 'old');
  chmodSync(exe, 0o755);
  routes = new Map();
  hits = [];
  restarted = false;
  server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    hits.push(path);
    const h = routes.get(path);
    if (h) h(req, res);
    else {
      res.writeHead(404);
      res.end('not found');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/rel`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

function io(env: NodeJS.ProcessEnv = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const value: Io = {
    env: { HOME: dir, XDG_RUNTIME_DIR: join(dir, 'run'), KAGE_RELEASE_BASE: base, ...env },
    stdin: Readable.from([]),
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    platform: 'linux',
  };
  return { io: value, out, err, all: () => [...out, ...err] };
}

function manager(state: ServiceState = 'active', over: Partial<ServiceManager> = {}) {
  const calls: string[] = [];
  const m: ServiceManager = {
    kind: 'systemd',
    file: join(dir, 'kage.service'),
    name: 'systemd user unit kage.service',
    unavailable: async () => null,
    install: async () => {
      calls.push('install');
    },
    restart: async () => {
      calls.push('restart');
      restarted = true;
    },
    remove: async () => {
      calls.push('remove');
    },
    state: async () => state,
    pathOfInstalled: async () => null,
    ...over,
  };
  return { m, calls };
}

const sea = (): RunMode => ({ kind: 'sea', exe });

function deps(over: Partial<UpdateDeps> = {}): UpdateDeps {
  const up = (version: string): ServerStatus => ({
    version,
    url: 'http://my-pc:8080',
    sessions: 0,
    needsYou: 0,
    pid: 1,
  });
  return {
    fetch: (input, init) => fetch(input, init),
    mode: sea(),
    manager: null,
    uid: 1000,
    arch: process.arch === 'arm64' ? 'arm64' : 'x64',
    // The new "program" is a shell script; the real check runs `<tmp> --version`.
    programVersion: async () => NEW_VERSION,
    status: async () => up(restarted ? NEW_VERSION : KAGE_VERSION),
    waitMs: 300,
    ...over,
  };
}

/** The target still holds `old`, and no temporary file is left next to it. */
function expectUntouched() {
  expect(readFileSync(exe, 'utf8')).toBe('old');
  expect(readdirSync(join(dir, 'bin')).filter((n) => n !== 'kage')).toEqual([]);
}

describe('releaseBase', () => {
  it('defaults to the latest GitHub release over https', () => {
    expect(releaseBase({}).href).toBe(`${RELEASE_BASE}/`);
    expect(RELEASE_BASE).toBe('https://github.com/eridian-io/kage/releases/latest/download');
  });

  it('takes KAGE_RELEASE_BASE: https anywhere, http only on loopback', () => {
    expect(releaseBase({ KAGE_RELEASE_BASE: 'http://127.0.0.1:1234' }).href).toBe(
      'http://127.0.0.1:1234/',
    );
    expect(releaseBase({ KAGE_RELEASE_BASE: 'https://example.com/r/' }).href).toBe(
      'https://example.com/r/',
    );
    expect(() => releaseBase({ KAGE_RELEASE_BASE: 'http://example.com' })).toThrow(ReleaseError);
    expect(() => releaseBase({ KAGE_RELEASE_BASE: 'ftp://127.0.0.1/' })).toThrow(ReleaseError);
    expect(() => releaseBase({ KAGE_RELEASE_BASE: 'not a url' })).toThrow(ReleaseError);
  });
});

describe('the release files', () => {
  it('assetName is kage-<target>.gz', () => {
    expect(assetName('linux-x64')).toBe('kage-linux-x64.gz');
  });

  it('parseSums reads sha256sum lines, lowercases, and ignores malformed ones', () => {
    const a = 'A'.repeat(64);
    const b = 'b'.repeat(64);
    const sums = parseSums(
      `${a}  kage-linux-x64.gz\r\n${b} *VERSION\nnonsense\n${'c'.repeat(63)}  short\n`,
    );
    expect(sums.get('kage-linux-x64.gz')).toBe('a'.repeat(64));
    expect(sums.get('VERSION')).toBe(b);
    expect(sums.size).toBe(2);
  });

  it('parseSums drops a name listed twice with different sums (any doubt)', () => {
    const sums = parseSums(
      `${'a'.repeat(64)}  x\n${'b'.repeat(64)}  x\n${'c'.repeat(64)}  y\n${'c'.repeat(64)}  y\n`,
    );
    expect(sums.has('x')).toBe(false);
    expect(sums.get('y')).toBe('c'.repeat(64));
  });

  it('compareVersions: numeric parts, and a pre-release sorts below its release', () => {
    expect(compareVersions('0.10.0', '0.9.1')).toBe(1);
    expect(compareVersions('0.9.1', '0.10.0')).toBe(-1);
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBe(1);
    expect(compareVersions('1.0.0-rc.2', '1.0.0-rc.10')).toBe(-1);
    expect(compareVersions('1.0.0-rc.1', '1.0.0-beta')).toBe(1);
    expect(compareVersions('0.0.1-test.2', '0.0.1-test.1')).toBe(1);
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
    expect(() => compareVersions('one', '1.0.0')).toThrow(ReleaseError);
  });
});

describe('downloadVerified', () => {
  const b = () => new URL(`${base}/`);
  const reason = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (err) {
      expect(err).toBeInstanceOf(ReleaseError);
      return (err as Error).message;
    }
    throw new Error('expected a ReleaseError');
  };

  it('returns the bytes whose sum matches', async () => {
    const gz = release();
    const got = await downloadVerified(fetch, b(), ASSET, parseSums(`${sha(gz)}  ${ASSET}\n`));
    expect(Buffer.from(got).equals(Buffer.from(gz))).toBe(true);
  });

  it('no line for the name: refuses before downloading', async () => {
    release();
    expect(await reason(downloadVerified(fetch, b(), ASSET, new Map()))).toBe(
      `no checksum for ${ASSET}`,
    );
    expect(hits).toEqual([]);
  });

  it('a body over maxBytes, with and without a length', async () => {
    const gz = release({ gz: Buffer.alloc(4096, 1) });
    const sums = parseSums(`${sha(gz)}  ${ASSET}\n`);
    expect(await reason(downloadVerified(fetch, b(), ASSET, sums, { maxBytes: 1000 }))).toBe(
      'download too large',
    );
    route(ASSET, (_req, res) => {
      res.writeHead(200);
      res.write(Buffer.alloc(800, 1));
      res.end(Buffer.alloc(800, 1));
    });
    expect(await reason(downloadVerified(fetch, b(), ASSET, sums, { maxBytes: 1000 }))).toBe(
      'download too large',
    );
  });

  it("a server that can't be reached", async () => {
    const port = (server.address() as AddressInfo).port;
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    server = createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const sums = parseSums(`${'a'.repeat(64)}  ${ASSET}\n`);
    expect(
      await reason(downloadVerified(fetch, new URL(`http://127.0.0.1:${port}/`), ASSET, sums)),
    ).toBe("couldn't reach the release server");
  });

  it('a redirect away from https is refused', async () => {
    // A response whose final URL (after redirects) is plain http off loopback. The test guard
    // would refuse to fetch such a host, so a fake fetch reports where it ended up.
    const gz = gzipSync(NEW);
    const sums = parseSums(`${sha(gz)}  ${ASSET}\n`);
    const fakeFetch = (async () => {
      const r = new Response(gz, { status: 200 });
      Object.defineProperty(r, 'url', { value: 'http://example.com/kage.gz' });
      return r;
    }) as unknown as typeof fetch;
    expect(await reason(downloadVerified(fakeFetch, b(), ASSET, sums))).toBe(
      'a redirect away from HTTPS',
    );
  });
});

describe('replaceBinary', () => {
  it('writes the new program over the target, mode 0755', async () => {
    await replaceBinary(exe, gzipSync(NEW));
    expect(readFileSync(exe).equals(NEW)).toBe(true);
    if (!isWindows) expect(statSync(exe).mode & 0o777).toBe(0o755);
    expect(readdirSync(join(dir, 'bin'))).toEqual(['kage']);
  });

  it('a gzip that does not decompress: nothing changes', async () => {
    await expect(replaceBinary(exe, Buffer.from('not gzip at all'))).rejects.toThrow(
      "the download didn't decompress",
    );
    expectUntouched();
  });

  it('a failed rename removes the temporary file and keeps the old program', async () => {
    await expect(
      replaceBinary(exe, gzipSync(NEW), {
        rename: async () => {
          throw Object.assign(new Error('EXDEV: cross-device link'), { code: 'EXDEV' });
        },
      }),
    ).rejects.toThrow('EXDEV');
    expectUntouched();
  });

  it('a failed check of the new program keeps the old one', async () => {
    await expect(
      replaceBinary(exe, gzipSync(NEW), {
        verify: async () => {
          throw new ReleaseError("the new program didn't run");
        },
      }),
    ).rejects.toThrow("the new program didn't run");
    expectUntouched();
  });

  it('keepPrevious keeps the old program next to the new one after a swap', async () => {
    await replaceBinary(exe, gzipSync(NEW), { keepPrevious: `${exe}.previous` });
    expect(readFileSync(exe).equals(NEW)).toBe(true);
    expect(readFileSync(`${exe}.previous`, 'utf8')).toBe('old');
    expect(readdirSync(join(dir, 'bin')).sort()).toEqual(['kage', 'kage.previous']);
  });
});

describe('kage update', () => {
  it('happy path: verified, swapped, restarted, and the new version answers', async () => {
    release();
    const { m, calls } = manager('active');
    const o = io();
    const code = await updateCommand([], o.io, deps({ manager: m }));
    expect(o.err).toEqual([]);
    expect(code).toBe(0);
    expect(readFileSync(exe).equals(NEW)).toBe(true);
    if (!isWindows) expect(statSync(exe).mode & 0o777).toBe(0o755);
    expect(calls).toEqual(['restart']);
    expect(restarted).toBe(true);
    expect(o.out).toEqual([
      `Downloading Kage ${NEW_VERSION} for ${TARGET}.`,
      `Updated Kage ${KAGE_VERSION} → ${NEW_VERSION}.`,
      'Restarted the service.',
    ]);
    expect(readdirSync(join(dir, 'bin')).sort()).toEqual(['kage', 'kage.previous']);
  });

  it('no service installed: says to restart Kage', async () => {
    release();
    const o = io();
    expect(await updateCommand([], o.io, deps({ manager: manager('missing').m }))).toBe(0);
    expect(o.out.slice(-2)).toEqual([
      `Updated Kage ${KAGE_VERSION} → ${NEW_VERSION}.`,
      'Restart Kage to use it.',
    ]);
    expect(await updateCommand(['--force'], io().io, deps({ manager: null }))).toBe(0);
  });

  it('no user manager (R112): never asks the state, says to restart Kage', async () => {
    release();
    const { m, calls } = manager('active', {
      unavailable: async () => 'systemctl --user does not answer.',
      state: async () => {
        throw new Error('state without a manager');
      },
    });
    const o = io();
    expect(await updateCommand([], o.io, deps({ manager: m }))).toBe(0);
    expect(calls).toEqual([]);
    expect(o.out.at(-1)).toBe('Restart Kage to use it.');
  });

  it('a failed restart: the program is updated, says so, exit 1', async () => {
    release();
    const { m } = manager('active', {
      restart: async () => {
        throw new Error('"systemctl --user restart kage.service" exited 1: Job failed');
      },
    });
    const o = io();
    expect(await updateCommand([], o.io, deps({ manager: m }))).toBe(1);
    expect(readFileSync(exe).equals(NEW)).toBe(true);
    expect(o.out.at(-1)).toBe(`Updated Kage ${KAGE_VERSION} → ${NEW_VERSION}.`);
    expect(o.err).toEqual([
      'Couldn\'t restart the systemd user unit kage.service: "systemctl --user restart kage.service" exited 1: Job failed',
      'Restart Kage to use it.',
    ]);
  });

  it("restarted, but the new version doesn't answer: says so with a way back, exit 1", async () => {
    release();
    const { m } = manager('active');
    const o = io();
    // The old one answers until the restart; after it, nothing does.
    const status = async (): Promise<ServerStatus | null> =>
      restarted ? null : { version: KAGE_VERSION, url: 'u', sessions: 0, needsYou: 0, pid: 1 };
    expect(await updateCommand([], o.io, deps({ manager: m, status }))).toBe(1);
    const real = realpathSync(exe);
    expect(o.err).toEqual([
      `Restarted the service, but Kage ${NEW_VERSION} isn't answering.`,
      `To go back to Kage ${KAGE_VERSION}: mv ${shellWord(`${real}.previous`)} ${shellWord(real)} && systemctl --user restart kage.service`,
    ]);
    expect(readFileSync(`${real}.previous`, 'utf8')).toBe('old');
  });

  it("restarted while Kage wasn't answering before either: no rollback hint, exit 0", async () => {
    release();
    const { m } = manager('starting');
    const o = io();
    expect(await updateCommand([], o.io, deps({ manager: m, status: async () => null }))).toBe(0);
    expect(o.out.slice(-2)).toEqual([
      'Restarted the service.',
      "Kage wasn't answering before the update either. kage doctor says why.",
    ]);
  });

  it('same version without --force: no asset download', async () => {
    release({ version: KAGE_VERSION });
    const o = io();
    expect(await updateCommand([], o.io, deps())).toBe(0);
    expect(o.out).toEqual([`Kage ${KAGE_VERSION} is the latest.`]);
    expect(hits).toEqual(['/rel/VERSION']);
    expectUntouched();
  });

  it('an older release is not newer either; --force installs it', async () => {
    release({ version: '0.0.0-a' });
    expect(compareVersions('0.0.0-a', KAGE_VERSION)).toBe(-1);
    const o = io();
    expect(await updateCommand([], o.io, deps({ programVersion: async () => '0.0.0-a' }))).toBe(0);
    expect(o.out).toEqual([`Kage ${KAGE_VERSION} is the latest.`]);
    const p = io();
    expect(
      await updateCommand(['--force'], p.io, deps({ programVersion: async () => '0.0.0-a' })),
    ).toBe(0);
    expect(readFileSync(exe).equals(NEW)).toBe(true);
  });

  describe('Review Focus 3: every failure keeps the old program and says why', () => {
    const fails = async (setup: () => void, reasonText: string, over: Partial<UpdateDeps> = {}) => {
      setup();
      const { m, calls } = manager('active');
      const o = io();
      expect(await updateCommand([], o.io, deps({ manager: m, ...over }))).toBe(1);
      expect(o.err).toEqual([`Update failed: ${reasonText}. Nothing was changed.`]);
      expect(calls).toEqual([]);
      expectUntouched();
    };

    it('a wrong sum', () =>
      fails(() => release({ sums: `${'0'.repeat(64)}  ${ASSET}\n` }), 'checksum mismatch'));

    it('SHA256SUMS without the line', () =>
      fails(
        () => release({ sums: `${'0'.repeat(64)}  kage-other.gz\n` }),
        `no checksum for ${ASSET}`,
      ));

    it('404 on the asset', () =>
      fails(() => {
        release();
        route(ASSET, null);
      }, 'HTTP 404'));

    it('a body cut halfway', () =>
      fails(() => {
        const gz = release({ gz: gzipSync(Buffer.alloc(200_000, 7)) });
        route(ASSET, (_req, res) => {
          res.writeHead(200, { 'content-length': gz.length });
          res.write(gz.subarray(0, gz.length >> 1), () => res.socket?.destroy());
        });
      }, 'the download was cut short'));

    it('a body over maxBytes', () =>
      fails(() => release({ gz: Buffer.alloc(5000, 1) }), 'download too large', {
        maxBytes: 1000,
      }));

    it('a server that never answers', () =>
      fails(
        () => {
          release();
          route(ASSET, () => {});
        },
        'timed out',
        { timeoutMs: 200 },
      ));

    it("a gzip that doesn't decompress", () =>
      fails(
        () => release({ gz: Buffer.from('this is not gzip') }),
        "the download didn't decompress",
      ));

    it("a VERSION that isn't a version", () =>
      fails(() => release({ version: '<html>' }), "the release's VERSION isn't a version"));

    it("a new program that doesn't report its version", () =>
      fails(() => release(), "the new program didn't run", { programVersion: async () => null }));

    it('a new program that reports another version', () =>
      fails(() => release(), "the new program didn't run", {
        programVersion: async () => '1.0.0',
      }));

    it('a failed rename', async () => {
      release();
      const { m, calls } = manager('active');
      const o = io();
      const rename = async () => {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      };
      expect(await updateCommand([], o.io, deps({ manager: m, rename }))).toBe(1);
      expect(o.err).toEqual([
        `Update failed: couldn't replace ${exe} (EACCES). Nothing was changed.`,
      ]);
      expect(calls).toEqual([]);
      expectUntouched();
    });

    it('a release base that is http off loopback', async () => {
      const o = io({ KAGE_RELEASE_BASE: 'http://example.com/rel' });
      expect(await updateCommand([], o.io, deps())).toBe(1);
      expect(o.err).toEqual([
        'Update failed: KAGE_RELEASE_BASE must be an https URL. Nothing was changed.',
      ]);
      expectUntouched();
    });
  });

  it('bundle and source modes print their line and touch nothing', async () => {
    release();
    const b = io();
    expect(
      await updateCommand(
        [],
        b.io,
        deps({ mode: { kind: 'bundle', node: '/usr/bin/node', script: '/x/kage.mjs' } }),
      ),
    ).toBe(1);
    expect(b.err).toEqual([
      'This Kage came from npm or a build. Update it with: npm install -g @eridian-io/kage@latest',
    ]);
    const s = io();
    expect(
      await updateCommand(
        [],
        s.io,
        deps({ mode: { kind: 'source', node: '/usr/bin/node', script: '/x/src/main.ts' } }),
      ),
    ).toBe(1);
    expect(s.err).toEqual([
      'This Kage runs from a checkout. Update it with git pull and pnpm build.',
    ]);
    expect(hits).toEqual([]);
    expectUntouched();
  });

  it('refuses root, unknown options, and a machine without a release', async () => {
    const r = io();
    expect(await updateCommand([], r.io, deps({ uid: 0 }))).toBe(1);
    expect(r.err).toEqual(['Run Kage as your own user, not root.']);
    const u = io();
    expect(await updateCommand(['--nope'], u.io, deps())).toBe(1);
    expect(u.err).toEqual([
      'kage update has no option "--nope". Run kage --help to see its options.',
    ]);
    const w = io();
    w.io.platform = 'win32';
    expect(await updateCommand([], w.io, deps())).toBe(1);
    expect(w.err).toEqual([
      'Kage has no single program for this machine, so kage update has nothing to install.',
    ]);
    expect(hits).toEqual([]);
    expectUntouched();
  });
});

describe.runIf(!isWindows)('kage update through a link (R110-5)', () => {
  it('replaces the file the stable path links to, and the link stays', async () => {
    release();
    const real = join(dir, 'bin', 'kage-real');
    renameSync(exe, real);
    symlinkSync(real, exe);
    const o = io();
    expect(await updateCommand([], o.io, deps())).toBe(0);
    expect(lstatSync(exe).isSymbolicLink()).toBe(true);
    expect(readFileSync(real).equals(NEW)).toBe(true);
    expect(readFileSync(`${real}.previous`, 'utf8')).toBe('old');
  });
});
