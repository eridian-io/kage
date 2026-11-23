import { spawn } from 'node:child_process';
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
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
  pinRelease,
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

// A local release server, real downloads and a status poll: room under container load (the
// install-sh flake's cause, vitest's 5 s default).
const UNDER_LOAD = { timeout: 30_000 };

describe('downloadVerified', UNDER_LOAD, () => {
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

describe('pinRelease (R125)', UNDER_LOAD, () => {
  const origin = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const latestBase = () => new URL(`${origin()}/o/r/releases/latest/download/`);
  const LATEST = '/o/r/releases/latest/download/VERSION';
  const redirect =
    (location: string): Handler =>
    (_req, res) => {
      res.writeHead(302, { location, 'content-length': 0 });
      res.end();
    };
  const pinError = async (p: Promise<unknown>) => {
    const err = await p.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ReleaseError);
    return (err as Error).message;
  };

  it('a hop to the same origin and /releases/download/v<semver>/VERSION pins that release', async () => {
    routes.set(LATEST, redirect('/o/r/releases/download/v9.0.0/VERSION'));
    routes.set('/o/r/releases/download/v9.0.0/VERSION', send('9.0.0\n'));
    const r = await pinRelease(fetch, latestBase());
    expect(r.base.href).toBe(`${origin()}/o/r/releases/download/v9.0.0/`);
    expect(r.version).toBe('9.0.0\n');
    expect(hits).toEqual([LATEST, '/o/r/releases/download/v9.0.0/VERSION']);
  });

  it("a hop to another origin isn't pinned", async () => {
    // Another port is another origin, though the path names a release folder.
    const other = createServer((req, res) => {
      hits.push(`other:${new URL(req.url ?? '/', 'http://x').pathname}`);
      res.writeHead(200, { 'content-length': 6 });
      res.end('9.1.0\n');
    });
    await new Promise<void>((r) => other.listen(0, '127.0.0.1', r));
    try {
      const otherOrigin = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
      routes.set(LATEST, redirect(`${otherOrigin}/o/r/releases/download/v9.1.0/VERSION`));
      const r = await pinRelease(fetch, latestBase());
      // VERSION is followed there; every other file still resolves against the base.
      expect(r.base.href).toBe(latestBase().href);
      expect(r.version).toBe('9.1.0\n');
      expect(hits).toEqual([LATEST, LATEST, 'other:/o/r/releases/download/v9.1.0/VERSION']);
    } finally {
      other.closeAllConnections();
      await new Promise<void>((r) => other.close(() => r()));
    }
  });

  it("a pinned release whose VERSION isn't its tag fails", async () => {
    routes.set(LATEST, redirect('/o/r/releases/download/v9.1.0/VERSION'));
    routes.set('/o/r/releases/download/v9.1.0/VERSION', send('9.0.0\n'));
    expect(await pinError(pinRelease(fetch, latestBase()))).toBe(
      "the release's VERSION doesn't match its tag",
    );
  });

  it("a traversal or an encoded slash in the hop's path isn't pinned", async () => {
    routes.set('/o/r/VERSION', send('9.0.0\n'));
    routes.set('/evil/releases/download/v9.0.0/VERSION', send('9.0.0\n'));
    routes.set('/o/r/releases/download/v9.0.0/..%2F..%2F/VERSION', send('9.0.0\n'));
    for (const location of [
      // Resolves to /evil/releases/download/v9.0.0/VERSION: another repository's release.
      '/o/r/releases/download/v9.0.0/../../../../../evil/releases/download/v9.0.0/VERSION',
      // Resolves to /o/r/VERSION, outside any release folder.
      '/o/r/releases/download/v9.0.0/../../../VERSION',
      // %2F isn't a folder separator, so the tag segment isn't v<semver>.
      '/o/r/releases/download/v9.0.0/..%2F..%2F/VERSION',
    ]) {
      routes.set(LATEST, redirect(location));
      const r = await pinRelease(fetch, latestBase());
      expect(r.base.href, location).toBe(latestBase().href);
      expect(r.version, location).toBe('9.0.0\n');
    }
  });

  it('a pre-release tag pins when its VERSION matches it (R118), and fails when it does not', async () => {
    routes.set(LATEST, redirect('/o/r/releases/download/v9.1.0-rc.1/VERSION'));
    routes.set('/o/r/releases/download/v9.1.0-rc.1/VERSION', send('9.1.0-rc.1\n'));
    const r = await pinRelease(fetch, latestBase());
    expect(r.base.href).toBe(`${origin()}/o/r/releases/download/v9.1.0-rc.1/`);
    expect(r.version.trim()).toBe('9.1.0-rc.1');

    routes.set('/o/r/releases/download/v9.1.0-rc.1/VERSION', send('9.1.0\n'));
    expect(await pinError(pinRelease(fetch, latestBase()))).toBe(
      "the release's VERSION doesn't match its tag",
    );
  });

  it('a same-origin hop to a folder that is not a tag is followed, not pinned', async () => {
    for (const location of [
      '/rel/VERSION',
      '/o/r/releases/download/vv9.0.0/VERSION',
      '/o/r/releases/download/9.0.0/VERSION',
      '/o/r/releases/download/v9.0/VERSION',
    ]) {
      routes.set(location, send('9.0.0\n'));
      routes.set(LATEST, redirect(location));
      const r = await pinRelease(fetch, latestBase());
      expect(r.base.href, location).toBe(latestBase().href);
      expect(r.version, location).toBe('9.0.0\n');
    }
  });

  it("KAGE_RELEASE_BASE at a tag's download folder: no hop, the base as it is", async () => {
    routes.set('/o/r/releases/download/v9.0.0/VERSION', send('9.0.0\n'));
    const tagBase = releaseBase({ KAGE_RELEASE_BASE: `${origin()}/o/r/releases/download/v9.0.0` });
    const r = await pinRelease(fetch, tagBase);
    expect(r.base.href).toBe(`${origin()}/o/r/releases/download/v9.0.0/`);
    expect(r.version).toBe('9.0.0\n');
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

describe('kage update', UNDER_LOAD, () => {
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

  it("R124: the tag comes from latest/download's first redirect, and all three files from that release", async () => {
    // GitHub's shape: latest/download/<name> → download/<tag>/<name>. Here 9.1.0 is published
    // between the VERSION request and the others; its files must not mix in.
    const latest =
      (name: string, tag: string): Handler =>
      (_req, res) => {
        res.writeHead(302, { location: `/releases/download/${tag}/${name}`, 'content-length': 0 });
        res.end();
      };
    const gz = gzipSync(NEW);
    const later = gzipSync(Buffer.from('#!/bin/sh\necho newer\n'));
    routes.set('/releases/latest/download/VERSION', latest('VERSION', 'v9.0.0'));
    routes.set('/releases/latest/download/SHA256SUMS', latest('SHA256SUMS', 'v9.1.0'));
    routes.set(`/releases/latest/download/${ASSET}`, latest(ASSET, 'v9.1.0'));
    routes.set('/releases/download/v9.0.0/VERSION', send('9.0.0\n'));
    routes.set('/releases/download/v9.0.0/SHA256SUMS', send(`${sha(gz)}  ${ASSET}\n`));
    routes.set(`/releases/download/v9.0.0/${ASSET}`, send(gz));
    routes.set('/releases/download/v9.1.0/SHA256SUMS', send(`${sha(later)}  ${ASSET}\n`));
    routes.set(`/releases/download/v9.1.0/${ASSET}`, send(later));
    const port = (server.address() as AddressInfo).port;
    const o = io({ KAGE_RELEASE_BASE: `http://127.0.0.1:${port}/releases/latest/download` });
    expect(await updateCommand([], o.io, deps({ programVersion: async () => '9.0.0' }))).toBe(0);
    expect(o.err).toEqual([]);
    expect(readFileSync(exe).equals(NEW)).toBe(true);
    expect(hits).toEqual([
      '/releases/latest/download/VERSION',
      '/releases/download/v9.0.0/VERSION',
      '/releases/download/v9.0.0/SHA256SUMS',
      `/releases/download/v9.0.0/${ASSET}`,
    ]);
  });

  it('a first redirect to another name (a CDN) pins nothing; one off https is refused', async () => {
    release();
    routes.set('/releases/latest/download/VERSION', (_req, res) => {
      res.writeHead(302, { location: '/rel/VERSION?sig=abc', 'content-length': 0 });
      res.end();
    });
    const port = (server.address() as AddressInfo).port;
    const o = io({ KAGE_RELEASE_BASE: `http://127.0.0.1:${port}/releases/latest/download` });
    // VERSION follows the redirect (to /rel/VERSION); the other names resolve against the base.
    expect(await updateCommand([], o.io, deps())).toBe(1);
    expect(hits).toEqual([
      '/releases/latest/download/VERSION',
      '/releases/latest/download/VERSION',
      '/rel/VERSION',
      '/releases/latest/download/SHA256SUMS',
    ]);
    expect(o.err).toEqual(['Update failed: HTTP 404. Nothing was changed.']);
    expectUntouched();

    hits.length = 0;
    routes.set('/releases/latest/download/VERSION', (_req, res) => {
      res.writeHead(302, { location: 'http://example.com/VERSION', 'content-length': 0 });
      res.end();
    });
    const p = io({ KAGE_RELEASE_BASE: `http://127.0.0.1:${port}/releases/latest/download` });
    expect(await updateCommand([], p.io, deps())).toBe(1);
    expect(p.err).toEqual(['Update failed: a redirect away from HTTPS. Nothing was changed.']);
    expect(hits).toEqual(['/releases/latest/download/VERSION']);
    expectUntouched();
  });

  it("R125: a pinned release whose VERSION isn't its tag stops the update, nothing changed", async () => {
    release();
    routes.set('/releases/latest/download/VERSION', (_req, res) => {
      res.writeHead(302, { location: '/releases/download/v9.1.0/VERSION', 'content-length': 0 });
      res.end();
    });
    routes.set('/releases/download/v9.1.0/VERSION', send('9.0.0\n'));
    const port = (server.address() as AddressInfo).port;
    const o = io({ KAGE_RELEASE_BASE: `http://127.0.0.1:${port}/releases/latest/download` });
    expect(await updateCommand([], o.io, deps())).toBe(1);
    expect(o.err).toEqual([
      "Update failed: the release's VERSION doesn't match its tag. Nothing was changed.",
    ]);
    expect(hits).toEqual([
      '/releases/latest/download/VERSION',
      '/releases/download/v9.1.0/VERSION',
    ]);
    expectUntouched();
  });

  it("R125: KAGE_RELEASE_BASE at a tag's download folder updates from that release", async () => {
    const gz = gzipSync(NEW);
    routes.set('/releases/download/v9.0.0/VERSION', send('9.0.0\n'));
    routes.set('/releases/download/v9.0.0/SHA256SUMS', send(`${sha(gz)}  ${ASSET}\n`));
    routes.set(`/releases/download/v9.0.0/${ASSET}`, send(gz));
    const port = (server.address() as AddressInfo).port;
    const o = io({ KAGE_RELEASE_BASE: `http://127.0.0.1:${port}/releases/download/v9.0.0` });
    expect(await updateCommand([], o.io, deps({ programVersion: async () => '9.0.0' }))).toBe(0);
    expect(o.err).toEqual([]);
    expect(readFileSync(exe).equals(NEW)).toBe(true);
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

  it('R119-5: a stopped or failed service stays stopped, and update says how to start it', async () => {
    for (const state of ['inactive', 'failed'] as const) {
      release();
      const { m, calls } = manager(state);
      const o = io();
      expect(await updateCommand(['--force'], o.io, deps({ manager: m }))).toBe(0);
      expect(calls).toEqual([]);
      expect(o.out.at(-1)).toBe(
        "The service isn't running, so it stays stopped. To start it: systemctl --user start kage.service",
      );
    }
    const { m, calls } = manager('inactive', {
      kind: 'launchd',
      name: 'launchd agent io.eridian.kage',
    });
    const o = io();
    expect(await updateCommand(['--force'], o.io, deps({ manager: m, uid: 501 }))).toBe(0);
    expect(calls).toEqual([]);
    expect(o.out.at(-1)).toBe(
      "The service isn't running, so it stays stopped. To start it: launchctl kickstart gui/501/io.eridian.kage",
    );
  });

  it('a starting service (R111) is restarted', async () => {
    release();
    const { m, calls } = manager('starting');
    expect(await updateCommand([], io().io, deps({ manager: m }))).toBe(0);
    expect(calls).toEqual(['restart']);
  });

  it('asks for the bytes as stored (accept-encoding: identity)', async () => {
    release();
    const seen: (string | undefined)[] = [];
    const inner = routes.get(`/rel/${ASSET}`);
    route(ASSET, (req, res) => {
      seen.push(req.headers['accept-encoding']);
      inner?.(req, res);
    });
    expect(await updateCommand([], io().io, deps())).toBe(0);
    expect(seen).toEqual(['identity']);
  });

  it('a trickle that never pauses 30 s (the idle limit) is fine; the total limit still stops it', async () => {
    const gz = release();
    const trickle: Handler = (_req, res) => {
      res.writeHead(200, { 'content-length': gz.length });
      let i = 0;
      const step = Math.ceil(gz.length / 6);
      const t = setInterval(() => {
        if (res.destroyed) return clearInterval(t);
        res.write(gz.subarray(i, i + step));
        i += step;
        if (i >= gz.length) {
          clearInterval(t);
          res.end();
        }
      }, 80);
    };
    route(ASSET, trickle);
    // Idle 200 ms, but about 500 ms in all: it arrives.
    expect(await updateCommand([], io().io, deps({ timeoutMs: 200 }))).toBe(0);
    expect(readFileSync(exe).equals(NEW)).toBe(true);
    writeFileSync(exe, 'old');
    rmSync(`${exe}.previous`);
    const o = io();
    expect(await updateCommand([], o.io, deps({ timeoutMs: 200, totalMs: 250 }))).toBe(1);
    expect(o.err).toEqual(['Update failed: timed out. Nothing was changed.']);
    expectUntouched();
  });

  it('one update at a time: a second one says so and changes nothing', async () => {
    const gz = release();
    let letGo: () => void = () => {};
    const held = new Promise<void>((r) => {
      letGo = r;
    });
    route(ASSET, (_req, res) => {
      void held.then(() => send(gz)(_req, res));
    });
    const first = updateCommand([], io().io, deps());
    // Wait until the first one is downloading, so it holds the lock.
    while (!hits.includes(`/rel/${ASSET}`)) await new Promise((r) => setTimeout(r, 10));
    const o = io();
    expect(await updateCommand([], o.io, deps())).toBe(1);
    expect(o.err).toEqual(['Another kage update is running.']);
    letGo();
    expect(await first).toBe(0);
    expect(readdirSync(join(dir, 'bin')).sort()).toEqual(['kage', 'kage.previous']);
  });

  it("a stale lock (its process is gone) doesn't block", async () => {
    release();
    const child = spawn(process.execPath, ['-e', '']);
    const pid = child.pid as number;
    await new Promise((r) => child.on('exit', r));
    writeFileSync(
      join(dir, 'bin', '.kage-update.lock'),
      `${pid}
`,
    );
    expect(await updateCommand([], io().io, deps())).toBe(0);
    expect(readFileSync(exe).equals(NEW)).toBe(true);
    expect(readdirSync(join(dir, 'bin')).sort()).toEqual(['kage', 'kage.previous']);
  });

  it('a lock held by a live process blocks; an old lock without a pid does not', async () => {
    release();
    const lock = join(dir, 'bin', '.kage-update.lock');
    writeFileSync(
      lock,
      `${process.ppid}
`,
    );
    const o = io();
    expect(await updateCommand([], o.io, deps())).toBe(1);
    expect(o.err).toEqual(['Another kage update is running.']);
    expect(readFileSync(lock, 'utf8')).toBe(`${process.ppid}
`);
    writeFileSync(lock, '');
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    expect(await updateCommand([], io().io, deps())).toBe(0);
  });

  it("the installed program can't be found: its own words, nothing changed", async () => {
    release();
    const o = io();
    expect(
      await updateCommand(
        [],
        o.io,
        deps({ mode: { kind: 'sea', exe: join(dir, 'gone', 'kage') } }),
      ),
    ).toBe(1);
    expect(o.err).toEqual([
      "Update failed: couldn't find the installed program (ENOENT). Nothing was changed.",
    ]);
    expect(hits).toEqual([]);
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

    it('a compressed reply (Content-Encoding: gzip) for the asset', () =>
      fails(() => {
        const gz = release();
        route(ASSET, (_req, res) => {
          const body = gzipSync(gz);
          res.writeHead(200, { 'content-encoding': 'gzip', 'content-length': body.length });
          res.end(body);
        });
      }, 'the server sent a compressed reply'));

    it('a compressed reply for VERSION', () =>
      fails(() => {
        release();
        route('VERSION', (_req, res) => {
          const body = gzipSync(`${NEW_VERSION}
`);
          res.writeHead(200, { 'content-encoding': 'gzip', 'content-length': body.length });
          res.end(body);
        });
      }, 'the server sent a compressed reply'));

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
        deps({
          mode: {
            kind: 'source',
            node: '/usr/bin/node',
            script: join('/x', 'packages', 'server', 'src', 'main.ts'),
          },
        }),
      ),
    ).toBe(1);
    expect(s.err).toEqual([
      `This Kage runs from a checkout in ${join('/x')}. Update it with: cd ${shellWord(join('/x'))} && git pull && pnpm install && pnpm build, then kage restart.`,
    ]);
    expect(hits).toEqual([]);
    expectUntouched();
  });

  it.each([
    ['the bundle', join('packages', 'server', 'dist', 'kage.mjs'), 'bundle'],
    ['the sources', join('packages', 'server', 'src', 'main.ts'), 'source'],
  ] as const)(
    'a checkout (%s) is told the checkout steps, ending in kage restart (usability U3)',
    async (_n, rel, kind) => {
      release();
      const checkout = join(dir, 'kage');
      mkdirSync(join(checkout, '.git'), { recursive: true });
      const script = join(checkout, rel);
      mkdirSync(dirname(script), { recursive: true });
      writeFileSync(script, '');
      const o = io();
      const mode: RunMode = { kind, node: '/usr/bin/node', script };
      expect(await updateCommand([], o.io, deps({ mode }))).toBe(1);
      expect(o.err).toEqual([
        `This Kage runs from a checkout in ${checkout}. Update it with: cd ${shellWord(checkout)} && git pull && pnpm install && pnpm build, then kage restart.`,
      ]);
      expect(hits).toEqual([]);
      expectUntouched();
    },
  );

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
