import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { markedPathLines, PATH_MARKER, pathRcFiles } from './path-rc.ts';

/**
 * install.sh (phase 6, Task 8), run for real by `sh` against a release server on 127.0.0.1, with
 * fake `uname` and `id` on PATH (F11: test:linux runs as root) and a fake kage as the release.
 * Every run gets its own HOME, XDG folders, KAGE_SOCKET and TMPDIR (F12), and no tty unless the
 * test makes one: spawn's `detached` is setsid, so /dev/tty can't be opened.
 */

const ROOT = join(import.meta.dirname, '../../../..');
const SCRIPT = join(ROOT, 'install.sh');
const TEXT = readFileSync(SCRIPT, 'utf8');
const isWindows = process.platform === 'win32';

const ASSET = 'kage-linux-x64.gz';
/** The fake kage: records its arguments, and whether stdin is a terminal. */
const KAGE = Buffer.from(
  '#!/bin/sh\nprintf \'%s\\n\' "$*" >"$KAGE_TEST_LOG"\nif [ -t 0 ]; then echo tty >>"$KAGE_TEST_LOG"; fi\n',
);
const GZ = gzipSync(KAGE);
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const SUMS = `${sha(gzipSync(Buffer.from('other')))}  kage-darwin-arm64.gz\n${sha(GZ)}  ${ASSET}\n`;

describe('install.sh, read as text', () => {
  it('never mentions sudo or eval, starts with #!/bin/sh and stays under 150 lines', () => {
    expect(TEXT).not.toMatch(/sudo/);
    expect(TEXT).not.toMatch(/\beval\b/);
    expect(TEXT.startsWith('#!/bin/sh\n')).toBe(true);
    expect(TEXT.trimEnd().split('\n').length).toBeLessThan(150);
  });

  it('writes the marker kage uninstall looks for (R120)', () => {
    expect(TEXT).toContain(`'\\n${PATH_MARKER}\\n%s\\n'`);
  });

  it.runIf(existsSync(join(ROOT, '.git')))('is mode 100755 in the git index', () => {
    const entry = execFileSync('git', ['ls-files', '-s', 'install.sh'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    expect(entry.split(' ')[0]).toBe('100755');
  });

  it('does everything inside main, called on the last line', () => {
    const lines = TEXT.trimEnd().split('\n');
    expect(lines.at(-1)).toBe('main "$@"');
    expect(TEXT.match(/^main "\$@"$/gm)).toHaveLength(1);
  });
});

type Release = {
  sums?: string | null;
  asset?: Buffer | null;
  cut?: 'length' | 'chunked';
  /** Never answer the file's request (until the test ends). */
  hang?: boolean;
};
interface Result {
  code: number | null;
  out: string;
  err: string;
}

// Each test runs real shells, curl and sometimes script(1) or two installs: vitest's 5 s default
// is too tight under a loaded full run (the Task 8 WSL flake), so the budget is 30 s.
describe.runIf(!isWindows)('install.sh, run against a local release', { timeout: 30_000 }, () => {
  let server: Server;
  /** Called when a request for the asset arrives (before any hang), for the signal tests. */
  let onAsset: (() => void) | undefined;
  let base: string;
  let release: Release;
  let hits: string[];
  let dir: string;
  let home: string;
  let tmp: string;
  let fake: string;
  let bin: string;
  let log: string;
  let hanging: ServerResponse[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      hits.push(req.url ?? '');
      const name = (req.url ?? '').replace(/^\/rel\//, '');
      const body =
        name === 'SHA256SUMS'
          ? release.sums === null
            ? null
            : Buffer.from(release.sums ?? SUMS)
          : name === ASSET
            ? release.asset === null
              ? null
              : (release.asset ?? GZ)
            : null;
      if (name === ASSET) onAsset?.();
      if (name === ASSET && release.hang) {
        hanging.push(res);
      } else if (body === null) {
        res.writeHead(404).end('not found');
      } else if (name === ASSET && release.cut === 'length') {
        // Says the whole length, sends half, hangs up: curl itself fails.
        res.writeHead(200, { 'content-length': body.length });
        res.write(body.subarray(0, body.length >> 1), () => res.socket?.destroy());
      } else if (name === ASSET && release.cut === 'chunked') {
        // A clean end after half the file: curl succeeds, the checksum catches it.
        res.writeHead(200);
        res.end(body.subarray(0, body.length >> 1));
      } else {
        res.writeHead(200, { 'content-length': body.length }).end(body);
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/rel`;
  });
  afterAll(async () => {
    await new Promise((r) => server.close(r));
  });

  beforeEach(() => {
    release = {};
    hits = [];
    onAsset = undefined;
    dir = mkdtempSync(join(tmpdir(), 'kage-install-sh-'));
    home = join(dir, 'home');
    tmp = join(dir, 'tmp');
    fake = join(dir, 'fake');
    bin = join(dir, 'my bin');
    log = join(dir, 'kage.log');
    for (const d of [home, tmp, fake]) mkdirSync(d, { recursive: true });
    const tool = (name: string, body: string) => {
      writeFileSync(join(fake, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(fake, name), 0o755);
    };
    tool('uname', 'case $1 in -m) echo "$FAKE_ARCH" ;; *) echo "$FAKE_OS" ;; esac');
    tool('id', 'echo "$FAKE_UID"');
    tool('sysctl', 'echo "$FAKE_TRANSLATED"');
  });
  afterEach(() => {
    for (const res of hanging) res.socket?.destroy();
    hanging = [];
    rmSync(dir, { recursive: true, force: true });
  });

  function env(extra: Record<string, string> = {}): Record<string, string> {
    return {
      PATH: `${fake}:/usr/local/bin:/usr/bin:/bin`,
      HOME: home,
      XDG_CONFIG_HOME: join(home, '.config'),
      XDG_STATE_HOME: join(home, '.local/state'),
      XDG_RUNTIME_DIR: join(dir, 'run'),
      KAGE_SOCKET: join(dir, 'run/kage.sock'),
      TMPDIR: tmp,
      SHELL: '/bin/sh',
      FAKE_OS: 'Linux',
      FAKE_ARCH: 'x86_64',
      FAKE_UID: '1000',
      KAGE_RELEASE_BASE: base,
      KAGE_INSTALL_DIR: bin,
      KAGE_TEST_LOG: log,
      ...extra,
    };
  }

  /**
   * Runs `<shell> <script> args…` with no tty (setsid, stdin /dev/null), or inside `script`.
   * With `stdin`, the script text is piped in instead: `<shell> -s -- args…`, the documented
   * `curl … | sh -s -- --yes` (under `script`, through `cat file |`, so stdin is still a pipe).
   */
  function run(
    o: {
      shell?: string;
      script?: string;
      args?: string[];
      env?: Record<string, string>;
      tty?: boolean;
      stdin?: string;
      onStart?: (p: ChildProcess) => void;
    } = {},
  ): Promise<Result> {
    const shell = o.shell ?? '/bin/sh';
    const piped = o.stdin !== undefined;
    const argv = piped
      ? [shell, '-s', '--', ...(o.args ?? [])]
      : [shell, o.script ?? SCRIPT, ...(o.args ?? [])];
    const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
    let line = argv.map(q).join(' ');
    if (piped && o.tty) {
      const file = join(dir, 'piped.sh');
      writeFileSync(file, o.stdin as string);
      line = `cat ${q(file)} | ${line}`;
    }
    const [cmd, ...args] = o.tty ? ['script', '-qec', line, '/dev/null'] : argv;
    return new Promise((resolve, reject) => {
      const p = spawn(cmd as string, args, {
        env: o.env ?? env(),
        detached: true,
        stdio: [piped && !o.tty ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      });
      o.onStart?.(p);
      if (piped && !o.tty) p.stdin?.end(o.stdin);
      let out = '';
      let err = '';
      p.stdout?.on('data', (b) => {
        out += b;
      });
      p.stderr?.on('data', (b) => {
        err += b;
      });
      p.on('error', reject);
      p.on('close', (code) => resolve({ code, out: out.replaceAll('\r\n', '\n'), err }));
    });
  }

  const installed = () => join(bin, 'kage');
  const leftovers = () => [
    ...readdirSync(tmp),
    ...(existsSync(bin) ? readdirSync(bin).filter((f) => f !== 'kage') : []),
  ];

  const hasScript = existsSync('/usr/bin/script') || existsSync('/bin/script');
  /** Cut points: 12 spread over the script, the start of the last line, and inside it (`mai`). */
  const cuts = () => {
    const end = TEXT.lastIndexOf('main "$@"');
    return [
      ...Array.from({ length: 12 }, (_, i) => Math.floor((end * (i + 1)) / 13)),
      end,
      end + 3,
    ];
  };
  const shells = ['/bin/dash', '/bin/bash'].filter((s) => existsSync(s));
  it('dash and bash are both here to run it', () => {
    expect(shells.length).toBe(2);
  });

  describe.each(shells)('under %s', (shell) => {
    it('installs into a folder with a space, mode 0755, and with no tty says how to finish', async () => {
      const r = await run({ shell, args: ['--yes'] });
      expect(r.err).toBe('');
      expect(r.code).toBe(0);
      expect(readFileSync(installed())).toEqual(KAGE);
      const st = lstatSync(installed());
      expect(st.isFile()).toBe(true);
      expect(st.mode & 0o777).toBe(0o755);
      expect(r.out.trimEnd().split('\n').at(-1)).toBe(
        `Installed ${bin}/kage. Run "kage setup" in a terminal to finish.`,
      );
      expect(existsSync(log)).toBe(false); // setup didn't run
      expect(hits).toEqual(['/rel/SHA256SUMS', `/rel/${ASSET}`]);
      expect(leftovers()).toEqual([]);
    });

    it('piped (sh -s -- --yes) with no tty: installs and says how to finish', async () => {
      const r = await run({ shell, stdin: TEXT, args: ['--yes'] });
      expect(r.err).toBe('');
      expect(r.code).toBe(0);
      expect(readFileSync(installed())).toEqual(KAGE);
      expect(r.out).toContain(`Installed ${bin}/kage. Run "kage setup" in a terminal to finish.`);
      expect(existsSync(log)).toBe(false);
    });

    it.runIf(hasScript)(
      'piped with a tty: the arguments reach setup, with the terminal as its stdin',
      async () => {
        const r = await run({ shell, stdin: TEXT, args: ['--yes', '--port', '4397'], tty: true });
        expect(r.code).toBe(0);
        expect(readFileSync(log, 'utf8')).toBe('setup --yes --port 4397\ntty\n');
        expect(leftovers()).toEqual([]);
      },
    );

    it('variables from the environment never reach the traps: a failed download keeps victims', async () => {
      release = { asset: null };
      const victim = join(dir, 'victim');
      const victimDir = join(dir, 'victim-dir');
      writeFileSync(victim, 'mine');
      mkdirSync(victimDir);
      writeFileSync(join(victimDir, 'f'), 'mine');
      const r = await run({
        shell,
        env: env({ new: victim, tmp: victimDir, missing: 'curl', fresh: '1', line: 'x' }),
      });
      expect(r.code).toBe(1);
      expect(r.err).toContain(DOWNLOAD(ASSET));
      expect(readFileSync(victim, 'utf8')).toBe('mine');
      expect(readFileSync(join(victimDir, 'f'), 'utf8')).toBe('mine');
      expect(leftovers()).toEqual([]);
    });

    it('fresh=1 from the environment: a folder already on PATH prints no "new terminal" line', async () => {
      const r = await run({
        shell,
        env: env({ PATH: `${fake}:${bin}:/usr/bin:/bin`, fresh: '1', new: join(dir, 'victim') }),
      });
      expect(r.code).toBe(0);
      expect(r.out).not.toContain('Open a new terminal');
      expect(readFileSync(installed())).toEqual(KAGE);
    });

    it('piped and cut short anywhere before the last line: runs nothing', async () => {
      for (const at of cuts()) {
        const r = await run({ shell, stdin: TEXT.slice(0, at) });
        expect(hits, `cut at ${at}: ${r.err}`).toEqual([]);
        expect(existsSync(bin), `cut at ${at}`).toBe(false);
      }
    }, 30_000);
  });

  it('with a tty, runs kage setup with the arguments on the terminal', async () => {
    if (!hasScript) {
      // No script(1) to make a tty with: the no-tty path is all there is to see.
      const r = await run({ args: ['--yes'] });
      expect(r.out).toContain('Run "kage setup" in a terminal to finish.');
      return;
    }
    const r = await run({ args: ['--yes'], tty: true });
    expect(r.code).toBe(0);
    expect(r.out).toContain(`Installed ${bin}/kage.\n`);
    expect(readFileSync(log, 'utf8')).toBe('setup --yes\ntty\n');
    expect(leftovers()).toEqual([]);
  });

  it('KAGE_NO_SETUP=1 installs only, even with a tty', async () => {
    const r = await run({ tty: hasScript, env: env({ KAGE_NO_SETUP: '1' }) });
    expect(r.code).toBe(0);
    expect(r.out).toContain(`Installed ${bin}/kage. Run "kage setup" in a terminal to finish.`);
    expect(existsSync(log)).toBe(false);
  });

  it('replaces an existing install in place, as a regular file', async () => {
    mkdirSync(bin);
    writeFileSync(installed(), 'old kage');
    const r = await run();
    expect(r.code).toBe(0);
    expect(readFileSync(installed())).toEqual(KAGE);
    expect(leftovers()).toEqual([]);
  });

  const DOWNLOAD = (name: string) => `Couldn't download ${base}/${name}. Nothing was installed.`;
  const CHECKSUM = `Checksum check failed for ${ASSET}. Nothing was installed.`;
  it.each<[string, Release, () => string]>([
    ['a wrong sum', { sums: `${'0'.repeat(64)}  ${ASSET}\n` }, () => CHECKSUM],
    [
      'no line for the file (only a longer name)',
      { sums: `${sha(GZ)}  ${ASSET}.old\n` },
      () => CHECKSUM,
    ],
    ['a 404 for the file', { asset: null }, () => DOWNLOAD(ASSET)],
    ['a 404 for SHA256SUMS', { sums: null }, () => DOWNLOAD('SHA256SUMS')],
    ['a body cut short (curl sees it)', { cut: 'length' }, () => DOWNLOAD(ASSET)],
    ['a body cut short (cleanly ended)', { cut: 'chunked' }, () => CHECKSUM],
  ])(
    '%s: fails with the message, keeps the old kage, leaves nothing behind',
    async (_, rel, msg) => {
      release = rel;
      mkdirSync(bin);
      writeFileSync(installed(), 'old kage');
      const r = await run();
      expect(r.code).not.toBe(0);
      expect(r.err).toContain(msg());
      expect(readFileSync(installed(), 'utf8')).toBe('old kage');
      expect(leftovers()).toEqual([]);
      expect(existsSync(log)).toBe(false);
    },
  );

  it('refuses root (a fake id saying 0) before it downloads anything', async () => {
    const r = await run({ env: env({ FAKE_UID: '0' }) });
    expect(r.code).toBe(1);
    expect(r.err).toBe('Run the installer as your own user, not root.\n');
    expect(hits).toEqual([]);
    expect(existsSync(bin)).toBe(false);
  });

  it.each([
    [
      'MINGW64_NT-10.0-26100',
      'x86_64',
      'On Windows, install Kage inside WSL: https://learn.microsoft.com/windows/wsl/install',
    ],
    ['Linux', 'riscv64', 'Kage has no build for Linux riscv64.'],
    ['FreeBSD', 'amd64', 'Kage has no build for FreeBSD amd64.'],
  ])('%s %s: says so and downloads nothing', async (os, arch, msg) => {
    const r = await run({ env: env({ FAKE_OS: os, FAKE_ARCH: arch }) });
    expect(r.code).toBe(1);
    expect(r.err).toBe(`${msg}\n`);
    expect(hits).toEqual([]);
  });

  it.each([
    ['Linux', 'amd64', 'kage-linux-x64.gz'],
    ['Linux', 'aarch64', 'kage-linux-arm64.gz'],
    ['Darwin', 'arm64', 'kage-darwin-arm64.gz'],
    ['Darwin', 'x86_64', 'kage-darwin-x64.gz'],
    ['Darwin', 'x86_64 under Rosetta', 'kage-darwin-arm64.gz'],
    ['Linux', 'x86_64 (sysctl says 1, ignored)', 'kage-linux-x64.gz'],
  ])('%s %s downloads %s', async (os, arch, name) => {
    const translated = arch.includes('Rosetta') || arch.includes('ignored') ? '1' : '0';
    const a = arch.split(' ')[0] as string;
    await run({ env: env({ FAKE_OS: os, FAKE_ARCH: a, FAKE_TRANSLATED: translated }) });
    expect(hits.at(-1)).toBe(`/rel/${name}`);
  });

  it.each([
    'http://127.0.0.1.example.com/rel',
    'http://user@127.0.0.1:9/rel',
    'http://example.com/rel',
    'http://127.0.0.1:80@evil.example/rel',
    'http://localhost:1@evil.example/rel',
    'http://127.0.0.1?@evil.example/rel',
    'http://127.0.0.1:/rel',
    'http://127.0.0.1.2.3/rel',
    'http://127.0.0.1./rel',
    'http://127..1/rel',
    'http://127./rel',
    'ftp://127.0.0.1/rel',
  ])('KAGE_RELEASE_BASE=%s is refused: https only, http only on loopback', async (b) => {
    const r = await run({ env: env({ KAGE_RELEASE_BASE: b }) });
    expect(r.code).toBe(1);
    expect(r.err).toBe('KAGE_RELEASE_BASE must be an https URL.\n');
  });

  it('names every missing tool', async () => {
    const r = await run({ env: env({ PATH: fake }) });
    expect(r.code).toBe(1);
    expect(r.err).toBe('Install curl, gunzip, sha256sum, then run the installer again.\n');
  });

  it.each(['HUP', 'INT', 'TERM'] as const)(
    'SIG%s during the download: exits, keeps the old kage, leaves nothing behind',
    async (sig) => {
      release = { hang: true };
      mkdirSync(bin);
      writeFileSync(installed(), 'old kage');
      let child: ChildProcess | undefined;
      // Resolved by the server's handler the moment curl asks for the file: no polling.
      const asked = new Promise<void>((resolve) => {
        onAsset = resolve;
      });
      const done = run({
        onStart: (p) => {
          child = p;
        },
      });
      let timer: NodeJS.Timeout | undefined;
      const tooLong = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`install.sh didn't ask for ${ASSET} within 15 s`)),
          15_000,
        );
      });
      try {
        await Promise.race([asked, tooLong]);
      } catch (e) {
        try {
          process.kill(-(child?.pid as number), 'SIGKILL');
        } catch {
          // already gone (ESRCH): the timeout below is the error worth seeing
        }
        throw e;
      } finally {
        clearTimeout(timer);
      }
      process.kill(-(child?.pid as number), `SIG${sig}`);
      const r = await done;
      expect(r.code).not.toBe(0);
      expect(readFileSync(installed(), 'utf8')).toBe('old kage');
      expect(leftovers()).toEqual([]);
    },
  );

  it.each([['a"b'], ['a$b'], ['a`b'], ['a\\b'], ['a:b'], ['a\nb']])(
    'an install folder named %j is refused before any download',
    async (name) => {
      const r = await run({ env: env({ KAGE_INSTALL_DIR: join(dir, name) }) });
      expect(r.code).toBe(1);
      expect(r.err).toBe(
        "The install folder can't contain a quote, $, a backtick, a backslash, a colon or a line break.\n",
      );
      expect(hits).toEqual([]);
    },
  );

  it.each([
    ['/', "Kage can't be installed into /."],
    ['//', "Kage can't be installed into /."],
    ['~someone/bin', 'Give KAGE_INSTALL_DIR as a full path.'],
  ])('KAGE_INSTALL_DIR=%s is refused', async (d, msg) => {
    const r = await run({ env: env({ KAGE_INSTALL_DIR: d }) });
    expect(r.code).toBe(1);
    expect(r.err).toBe(`${msg}\n`);
    expect(hits).toEqual([]);
  });

  it('a folder where kage goes is refused, and left as it is', async () => {
    mkdirSync(join(bin, 'kage'), { recursive: true });
    const r = await run();
    expect(r.code).toBe(1);
    expect(r.err).toBe(`${bin}/kage is a folder. Move it away, then run the installer again.\n`);
    expect(lstatSync(join(bin, 'kage')).isDirectory()).toBe(true);
    expect(hits).toEqual([]);
  });

  it.each([
    ['~', (home) => home],
    ['~/k bin/', (home) => join(home, 'k bin')],
  ] as [string, (h: string) => string][])(
    'KAGE_INSTALL_DIR=%s expands the ~ to HOME',
    async (d, where) => {
      const r = await run({ env: env({ KAGE_INSTALL_DIR: d }) });
      expect(r.code).toBe(0);
      expect(readFileSync(join(where(home), 'kage'))).toEqual(KAGE);
      expect(r.out).toContain(`Installed ${where(home)}/kage.`);
    },
  );

  it('a truncated script runs nothing: cut anywhere before the last line', async () => {
    for (const at of cuts()) {
      const part = join(dir, 'part.sh');
      writeFileSync(part, TEXT.slice(0, at));
      const r = await run({ script: part });
      expect(hits, `cut at ${at}: ${r.err}`).toEqual([]);
      expect(existsSync(bin), `cut at ${at}`).toBe(false);
    }
  }, 30_000);

  describe('the PATH line (R114)', () => {
    const LINE = () => `export PATH="${bin}:$PATH"`;
    const count = (file: string) =>
      existsSync(file)
        ? readFileSync(file, 'utf8')
            .split('\n')
            .filter((l) => l === LINE()).length
        : 0;

    it('bash: added once to ~/.bashrc and ~/.profile, never twice', async () => {
      const first = await run({ env: env({ SHELL: '/bin/bash' }) });
      expect(first.out).toContain(`Added ${bin} to your PATH in ${home}/.bashrc.`);
      expect(first.out).toContain(`Added ${bin} to your PATH in ${home}/.profile.`);
      const second = await run({ env: env({ SHELL: '/bin/bash' }) });
      expect(second.code).toBe(0);
      expect(second.out).toContain(`${home}/.bashrc already adds ${bin} to your PATH.`);
      expect(count(join(home, '.bashrc'))).toBe(1);
      expect(count(join(home, '.profile'))).toBe(1);
    });

    it('the line sits under the marker kage uninstall finds (R120)', async () => {
      await run({ env: env({ SHELL: '/bin/zsh' }) });
      expect(markedPathLines(readFileSync(join(home, '.zshrc'), 'utf8'))).toEqual([[2, 3]]);
    });

    it('KAGE_NO_MODIFY_PATH=1 prints the line and changes no file (R120)', async () => {
      const r = await run({ env: env({ SHELL: '/bin/bash', KAGE_NO_MODIFY_PATH: '1' }) });
      expect(r.code).toBe(0);
      expect(r.out).toContain(
        `To add ${bin} to your PATH, add this line to ${home}/.bashrc: ${LINE()}\n`,
      );
      expect(r.out).toContain(
        `To add ${bin} to your PATH, add this line to ${home}/.profile: ${LINE()}\n`,
      );
      expect(r.out).not.toContain('Open a new terminal');
      expect(readdirSync(home)).toEqual([]);
    });

    it("a start-up file it can't write: prints the line, still installs and exits 0", async () => {
      mkdirSync(join(home, '.profile')); // even root can't append to a folder
      const r = await run();
      expect(r.code).toBe(0);
      expect(r.out).toContain(`Couldn't change ${home}/.profile. Add this line to it: ${LINE()}\n`);
      expect(r.out).not.toContain('Open a new terminal');
      expect(readFileSync(installed())).toEqual(KAGE);
    });

    it.runIf(process.getuid?.() !== 0)(
      'a read-only start-up file (as non-root): prints the line, leaves the file as it was',
      async () => {
        writeFileSync(join(home, '.profile'), '# mine\n');
        chmodSync(join(home, '.profile'), 0o444);
        const r = await run();
        expect(r.code).toBe(0);
        expect(r.out).toContain(
          `Couldn't change ${home}/.profile. Add this line to it: ${LINE()}\n`,
        );
        expect(readFileSync(join(home, '.profile'), 'utf8')).toBe('# mine\n');
      },
    );

    it('a folder already on PATH changes no file', async () => {
      const r = await run({
        env: env({ SHELL: '/bin/bash', PATH: `${fake}:${bin}:/usr/bin:/bin` }),
      });
      expect(r.code).toBe(0);
      expect(readdirSync(home)).toEqual([]);
    });

    it.each<[string, Record<string, string>, boolean]>([
      ['zsh', { SHELL: '/bin/zsh' }, false],
      ['zsh with ZDOTDIR', { SHELL: '/usr/bin/zsh', ZDOTDIR: 'ZD' }, false],
      ['bash', { SHELL: '/bin/bash' }, false],
      ['bash with ~/.bash_profile', { SHELL: '/bin/bash' }, true],
      ['fish', { SHELL: '/usr/bin/fish' }, false],
      ['no SHELL', { SHELL: '' }, false],
    ])('%s: writes exactly the files doctor names (pathRcFiles)', async (_, extra, profile) => {
      if (extra.ZDOTDIR) {
        extra.ZDOTDIR = join(dir, 'zdot');
        mkdirSync(extra.ZDOTDIR);
      }
      if (profile) writeFileSync(join(home, '.bash_profile'), '');
      const r = await run({ env: env(extra) });
      expect(r.code).toBe(0);
      const want = pathRcFiles({
        shell: extra.SHELL,
        home,
        zdotdir: extra.ZDOTDIR,
        hasBashProfile: profile,
      });
      for (const f of want) expect(count(f), f).toBe(1);
      const touched = [home, join(dir, 'zdot')]
        .filter(existsSync)
        .flatMap((d) => readdirSync(d).map((f) => join(d, f)))
        .filter((f) => count(f) > 0);
      expect(touched.sort()).toEqual([...want].sort());
    });
  });
});
