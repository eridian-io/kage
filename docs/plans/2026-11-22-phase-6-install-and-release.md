# Phase 6: Install and release — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One command installs Kage on a Linux machine or a Mac, checks the requirements, sets it up, starts it on boot, and keeps it updated:
- `install.sh` downloads the right `kage` program, verifies it and runs `kage setup`;
- `kage setup`, `status`, `update`, `uninstall` and `doctor`;
- a systemd user unit on Linux (WSL included) and a launchd agent on macOS, both running the shipped program with the R91 flags;
- releases: a single executable (SEA) per platform, `SHA256SUMS`, provenance attestations and the npm package `@eridian-io/kage`, built by a release workflow that this phase writes and tests locally but never runs.

**Architecture:**
- **Spike first (Task 1).** Node 24's SEA, systemd user units and launchd have facts nobody has recorded yet. Task 1 records them in `host-integration.md` §7 and settles the open questions below before any code depends on them.
- **One program, three run modes** (`install/runtime.ts`): `sea` (the released executable), `bundle` (`node dist/kage.mjs`, also the npm package) and `source` (the TypeScript checkout). The mode decides the hook command, the service command and where the board's files come from (the SEA's embedded assets, or a folder).
- **Install commands** live in `packages/server/src/install/`, one file per command, on small seams: a `Run` function for every external program (fake in unit tests), a `ServiceManager` per platform, the real file system under temporary `HOME`/`XDG_*` folders, and an injected `fetch`. `main.ts` imports each command lazily, so `kage hook` stays light.
- **The running server answers `GET /status` on the hook socket** (local, mode 0600). `kage status`, `setup`'s final check and `doctor` read it, so none of them needs the token or the network.
- **Release tooling** is `packages/server/src/release/build.ts`: it builds the SEA for the host platform, stages the npm package and writes `SHA256SUMS` into `dist/release/`. `.github/workflows/release.yml` runs it per platform on a `v*` tag. Locally, `pnpm release:local` builds the same files, and `pnpm test:install` runs a clean install in Docker against them.

**Tech Stack:** as phase 5 (Node ≥ 24.2, TypeScript strict, Hono, vitest, Playwright 1.64.1, tmux 3.4 and git 2.43 in WSL Ubuntu 24.04 and Docker). New: Node's SEA (`node:sea`), POSIX `sh` for `install.sh`, systemd user units, launchd agents. One new dev dependency, `postject`, only if Task 1 finds the release Node has no `node --build-sea`.

**Spec:** [`docs/specs/2026-11-21-kage-design.md`](../specs/2026-11-21-kage-design.md):
- §3 (platforms, Node 24 built in, the needs on the machine), §5.8a (the systemd unit starts after the network and Tailscale), §5.10 (security), §5.11 (config), §5.13 (install and distribution, every line);
- §7 (the idle-server budget on the shipped program, and the `kage hook` wall time "to improve in phase 6, when the hook runs from the single-file build"), §8, §9 (the phase 6 check), §11 ("Build and install").

Facts: [`host-integration.md`](../specs/host-integration.md) (Task 1 adds §7) and [`claude-code-integration.md`](../specs/claude-code-integration.md) (hooks come only through `claude --settings <file>`). Backlog: B52 lands here (Task 0). Ledger: R104 from phase 5.

## Global Constraints

- **Everything in the phase 1–5 Global Constraints still applies:**
  - Node ≥ 24.2, strict mode plus `erasableSyntaxOnly`, no native modules, no new runtime dependency;
  - `execFile`/`spawn` with argument arrays, never a shell (the one exception is `install.sh` itself, which is a shell script);
  - invented test data;
  - tests never touch the user's tmux server, config, state, git config, `~/.claude`, systemd or launchd: every test runs under a temporary `HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME` and `XDG_RUNTIME_DIR`, with a fake `Run`;
  - `describe.runIf(hasTmux)` for tmux tests, and `describe.runIf(process.platform !== 'win32')` for `sh` and file-mode tests;
  - hooks stay silent;
  - the rulings R4–R104, K1–K10, N0–N4 and PF4 of the phase 2–5 ledgers.
- **Start point:** branch `phase-6` from `phase-5` (head `1caf06d`).
- **The spec's values, verbatim (§5.13):**
  - the one-liner: `curl -fsSL https://raw.githubusercontent.com/eridian-io/kage/main/install.sh | sh`;
  - platforms: Linux x64/arm64, macOS arm64/x64; on Windows, `install.sh` explains that WSL is required;
  - the program goes to `~/.local/bin/kage`, with no `sudo` (or `$KAGE_INSTALL_DIR`), and the installer says how to add that folder to `PATH` if needed;
  - the download is verified by its SHA-256 checksum against the release's `SHA256SUMS`;
  - requirements: tmux 3.2+, git 2.40+, Claude Code (signed in), Tailscale (up);
  - the config is `~/.config/kage/config.json` (`$XDG_CONFIG_HOME/kage/config.json` when that is set);
  - the projects folder suggestion is `~/projects` or the folder that holds most git repos;
  - the service is a systemd user unit on Linux (setup offers `loginctl enable-linger`, so Kage runs without a login) or a launchd agent on macOS;
  - setup prints the address to open, for example `http://my-pc:8080`, and checks that it answers;
  - `kage uninstall` removes the service and the program, and keeps sessions, worktrees and the config unless `--purge` is given;
  - release artifacts are built for every tag `v*`: a SEA `kage` per platform from the esbuild bundle with the UI files embedded as assets, `SHA256SUMS`, build provenance attestations, and the npm package `@eridian-io/kage` (`npm install -g @eridian-io/kage`, then `kage setup`).
- **The shipped program's flags (R91):** the service always runs Kage with V8's pool at one thread and `MALLOC_ARENA_MAX=2`.
  - In bundle mode the unit runs `<node> --v8-pool-size=1 <kage.mjs> serve`.
  - In SEA mode the flag comes from the SEA config's `execArgv` if Task 1 finds the release Node supports it. Otherwise it comes from `NODE_OPTIONS=--v8-pool-size=1` in the unit.
  - Both units set `MALLOC_ARENA_MAX=2` and `KAGE_SERVICE=1`.
  - `kage serve` with `KAGE_SERVICE=1` removes `MALLOC_ARENA_MAX`, `NODE_OPTIONS` and `KAGE_SERVICE` from the environment before it starts tmux or anything else. The tmux server and every `claude` in it must not inherit the service's tuning.
  - Budget: the idle server stays under **80 MB RSS** and under 1% CPU (§7) when it runs the way the service runs it. That is measured on the bundle and, from Task 6, on the SEA.
- **Safety:**
  - **Nothing runs as root.** `install.sh`, `setup`, `update` and `uninstall` refuse uid 0 ("Run Kage as your own user, not root."), and `doctor` reports it as a failure. No command ever calls `sudo`. A step that needs root (installing tmux, `loginctl enable-linger` where polkit refuses, enabling systemd in WSL) is printed for the user to run.
  - **Checksums:** `install.sh` and `kage update` install nothing whose SHA-256 doesn't match its line in `SHA256SUMS`. A missing line, a missing `SHA256SUMS` or a mismatch stops the install, removes the temporary files and leaves any existing `kage` untouched.
  - **Downloads:** HTTPS only. Plain `http:` is accepted only for a loopback base URL (tests). The base is `https://github.com/eridian-io/kage/releases/latest/download`, overridable with `KAGE_RELEASE_BASE`. Redirects are followed (GitHub serves assets from another host), and the final URL must be HTTPS too.
  - **No secrets in unit files or plists.** The token and the ntfy keys stay in the config file, mode 0600 in a 0700 folder. A unit holds only the command, `PATH`, `MALLOC_ARENA_MAX`, `KAGE_SERVICE` and, if Task 1 needs it, `NODE_OPTIONS`. A test reads every rendered unit and plist for the token and the ntfy values.
  - **Uninstall never deletes a project, a worktree, a branch or the tmux session `kage`,** with or without `--purge`, and it says what it kept.
  - **Doctor makes no network call except to loopback, Kage's own listen address and the Tailscale local API** (through the `tailscale` CLI). A test records every `fetch` URL and `Run` call.
  - **Kage never writes Claude's configuration** (the owner's ruling, §5.3, recorded as R25 in the ledgers). Hooks keep reaching Claude only through `claude --settings <kage hooks-path>`, the settings file in Kage's own state folder, as phases 2–5 built it. Setup needs no change to Claude's settings. It writes the hooks file (as `kage serve` already does) and prints the command for starting Claude by hand.
- **Releases are the owner's step.** No task and no check pushes a tag, creates a GitHub Release, publishes to npm, pushes `main` or runs the release workflow. The workflow is written and its build script runs locally. The one-liner works only once `install.sh` is on `main` and a release exists. The README and the site say so until then.
- **Tests never contact an external host.** The vitest fetch guard (`packages/server/test/setup-fetch.ts`) stays. Downloads in tests come from a release server on `127.0.0.1`. The install check's downloads go only to its release server on `127.0.0.1`. The Docker image is pulled, and `pnpm install` fetches packages, the way `test:linux` already does.
- **The release Node** is the Node 24 LTS version Task 1 records, written to `.node-version`. The workflow, `Dockerfile.install` and the SEA build all use it.
- **Copy:** short plain sentences in the house style, each ending in a full stop. Every new user-facing line goes into a new spec section §6.8, "Copy added in phase 6" (Task 10), and `copy.test.ts` reads it from there.

## Review Focus

1. **`curl … | sh` leaves `kage setup` without a terminal.** The shell's stdin is the script itself. A reasonable person expects setup's questions to appear anyway, and expects a clear next step, not a hang or silent defaults, when no terminal exists (a CI job, `ssh host 'curl … | sh'`).
   Tests: Task 8 (`install.sh` runs `kage setup "$@" </dev/tty` when `/dev/tty` opens, else prints `Run "kage setup" in a terminal to finish.` and exits 0), and Task 5 (setup with no terminal and no `--yes` exits 1 with `kage setup needs a terminal for its questions. Run it in one, or pass --yes to take the defaults.`).
2. **A path with a space, a `%`, a `$`, a quote or an `&` in `HOME`, the install folder or `PATH`.** The unit and the plist must still start the right program with the right environment.
   Tests: Task 3 (`systemdQuote` and `renderUnit` with `/home/a b/%h$x"q/kage`; `renderPlist` with `&<>`), and Task 9 (the Docker install uses `KAGE_INSTALL_DIR="$HOME/my bin"`).
3. **A failed or tampered download.** A truncated file, a wrong checksum, a `SHA256SUMS` without the platform's line, a 404, or a connection cut halfway must never leave a broken or foreign `kage`. The old one keeps working and no temporary file stays behind.
   Tests: Task 7 (`downloadVerified`, `replaceBinary`), Task 8 (`install.sh` against a release server with a bad sum).
4. **Running setup again on a working install** (to change the port, say). It must keep every config key it didn't ask about (the token, the ntfy keys, `autoArchive`, keys it doesn't know), keep the file at 0600, refuse to overwrite a config it can't parse, and restart the one service rather than adding a second.
   Tests: Task 5.
5. **The service's environment isn't the shell's.**
   - `claude` installed under `~/.local/bin` or a version manager's folder isn't on systemd's default `PATH`.
   - launchd sets no `XDG_RUNTIME_DIR`, so the hook socket path differs from a login shell's.
   - The service's `MALLOC_ARENA_MAX` and `NODE_OPTIONS` must not reach Claude.

   A reasonable person expects tasks started from the board to work exactly as they did from the terminal.
   Tests: Task 3 (the unit carries setup's `PATH`), Task 4 (doctor's `service-path` check finds `tmux`, `git`, `claude` and `tailscale` on the unit's `PATH`), Task 2 (`serviceCleanEnv` strips the tuning), Task 9 (Docker: `claude` lives in `~/.npm-global/bin`, and the fake `claude` records its environment).

## File structure

```
packages/server/src/
  live-source.ts            Task 0: R104
  config.ts                 Task 0: configPath, displayPath (B52)
  main.ts                   Tasks 0, 2, 3, 5, 7: --version and the new commands, lazily imported
  serve.ts                  Tasks 2, 3: board source by run mode, KAGE_SERVICE env cleanup, /status provider
  assets.ts                 Task 2: loadAssets over a BoardFiles source (folder or SEA assets)
  hooks/server.ts           Task 4: GET /status
  install/
    runtime.ts              Task 2: RunMode, ENTRY, KAGE_VERSION, hookArgv, serviceArgv, serviceEnv, serviceCleanEnv
    run.ts                  Task 3: Run, realRun
    service.ts              Task 3: ServiceSpec, ServiceManager, serviceManager()
    systemd.ts, launchd.ts  Task 3
    checks.ts               Task 4: requirement and install checks, install hints
    doctor.ts               Task 4: kage doctor
    status.ts               Task 4: fetchStatus (client of GET /status); Task 5: kage status
    config-file.ts          Task 5: writeConfig, generateToken
    setup.ts, prompt.ts     Task 5: kage setup, Prompter
    update.ts               Task 7: kage update, release download and verification
    uninstall.ts            Task 7: kage uninstall
  sea-main.ts               Task 2: the SEA entry (CommonJS-safe)
  bundle.ts                 Tasks 2, 6: KAGE_VERSION define; the CommonJS SEA bundle
  release/build.ts          Task 6: buildSea, stageNpm, writeSums, the CLI
install.sh                  Task 8
.node-version               Task 1
.github/workflows/release.yml   Task 6
Dockerfile.install, scripts/test-install.sh, scripts/install-fakes/*, scripts/release-server.mjs   Task 9
e2e/harness.ts, e2e/perf.spec.ts   Task 6: the idle budget on the SEA (KAGE_PERF_SEA)
package.json                Tasks 6, 9: release:local, test:install
docs/specs/host-integration.md     Task 1: §7
docs/…, README.md           Task 10
site/index.html             Task 11
```

---

### Task 0: Phase 5 residuals

**Files:**
- Modify: `packages/server/src/live-source.ts`, `packages/server/src/config.ts`, `packages/server/src/main.ts`, `docs/specs/2026-11-21-kage-design.md` (§6.7, the `kage ping` sentence only)
- Test: `packages/server/src/live-source.test.ts` (a new `describe('LiveSource: phase 5 residuals (phase 6 Task 0)')`), `packages/server/src/config.test.ts`, `packages/server/src/main.test.ts`

**Interfaces:**
- Produces:
  - `configPath(env: NodeJS.ProcessEnv): string` in `config.ts`. It is the path `loadConfig` reads; `loadConfig` uses it.
  - `displayPath(path: string, home: string): string`: `~/…` for a path under `home`, else the path. Tasks 4, 5 and 7 print paths through it.

- [ ] **Step 1: Write the failing tests.**
  - **R104** (`it('R104: a hookless resumed session drops the resume when its first-prompt wait ends; a new tail question then shows')`):
    - Setup: an ended record with a session id, `resumed(id)`, the window listed, and no hook ever.
    - The tail replays an old open `AskUserQuestion` (key A). It does not show, as today.
    - The first-prompt wait ends by its activity path: the P4F1 looks reach `STARTING_LOOKS_MS`, then the idle rule gives done. Expect `status === 'done'` and the internal resume cleared (observable through the next step).
    - The tail then shows a new question B. Expect `needs-you`, with `question.text` from B and `promptKind === 'ask'`.
    - A second tail change that still shows A after B is answered does not bring A back.
  - **R104, the hooks path** (`it('R104: the P3F1 fallback also ends the resume')`): a resumed window gets no `SessionStart`, and the fallback timer path ends the wait. Same expectation for a new tail question.
  - **B52:**
    - `configPath({XDG_CONFIG_HOME: '/x'})` is `/x/kage/config.json`, and with `HOME` only it is `<home>/.config/kage/config.json`;
    - `displayPath('/home/u/.config/kage/config.json', '/home/u')` is `~/.config/kage/config.json`;
    - `kage ping` with `XDG_CONFIG_HOME=<tmp>` and no topic prints `No ntfyTopic in <tmp>/kage/config.json.`
- [ ] **Step 2: Run them.** `corepack pnpm vitest run packages/server/src/live-source.test.ts packages/server/src/config.test.ts packages/server/src/main.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Every path that ends the first-prompt wait also sets `st.resuming = null`: `#endFirstPromptWait`, and the P4F1 path where `#stillStarting` turns false and the activity rule decides.
  - `kage ping` prints `No ntfyTopic in ${displayPath(configPath(env), home)}.`
  - Update the §6.7 sentence to `"No ntfyTopic in <config path>."`.
- [ ] **Step 4: Run the tests** on Windows, in the WSL fresh clone (`bash .superpowers/sdd/<plan>/wsl-test.sh phase-6`), and with `corepack pnpm test:linux`. Expected: PASS.
- [ ] **Step 5: Commit.** `fix: phase 5 residuals (R104 resume cleared with the first-prompt wait; kage ping names the real config path, B52)`

---

### Task 1: Spike: SEA, systemd user units and launchd (facts only)

No product code. The spike answers each question below in `docs/specs/host-integration.md` §7, "Install: SEA, systemd and launchd (recorded 2026-11-22 for phase 6)". It records the exact commands and outputs, then adds a "Read first" entry that lists where the plan below must change. Scratch files go in `/tmp/kage-sea` in WSL and in a throwaway `node:24` container. Nothing is installed on the host.

**Files:**
- Modify: `docs/specs/host-integration.md`
- Create: `.node-version` (the release Node, e.g. `24.22.3`, the version in WSL today, unless the spike finds a reason to pick another 24.x)

- [ ] **Step 1: SEA on Linux, with the release Node** (WSL and `node:24-bookworm-slim`, x64). Build the current bundle into a SEA and record:
  1. Does `node --build-sea` exist on this Node, or is it `--experimental-sea-config` plus `postject` (version)?
  2. Can the main script be ESM (`"mainFormat"` or similar), or must it be CommonJS? The plan assumes **CommonJS** (`sea-main.ts` bundled with esbuild `format: 'cjs'`) and keeps it either way. ESM would only simplify Task 2.
  3. Is `execArgv` in the SEA config supported, so `--v8-pool-size=1` is built in? If not, does the SEA honour `NODE_OPTIONS=--v8-pool-size=1`? Prove it: count the V8 platform worker threads in `/proc/<pid>/task` with the flag and without it.
  4. `disableExperimentalSEAWarning: true`: is stderr empty for `kage hook Stop </dev/null`?
  5. What is `process.argv` inside the SEA? `main.ts` takes `argv.slice(2)`. And what is `process.execPath`?
  6. Assets: `sea.getAsset(key)` and `getRawAsset` on this Node, and whether `sea.getAssetKeys()` exists. The plan embeds a `board/manifest.json` asset either way.
  7. `useCodeCache: true` versus false: the SEA's size, `kage hook` wall time (median of 10, as §7 measures it) and `kage --version` time. Compare with the bundle's 96 ms.
  8. Idle RSS: the SEA with 10 done sessions, measured as §7 says, run the way the unit will run it. **Gate:** if it is over 80 MB, stop and report. The bundle stays the shipped program on Linux, and Task 6 changes.
  9. Does a SEA built on x64 for `linux-arm64` need an arm64 host? The workflow builds natively on each runner either way.
- [ ] **Step 2: systemd user units in WSL** (systemd is running there). Use a throwaway unit `kage-spike.service` running `sleep 600`, then remove it. Record:
  - the unit path (`$XDG_CONFIG_HOME/systemd/user/`);
  - `systemctl --user daemon-reload`, `enable --now`, `is-active` (the exit codes for active, inactive, failed and missing), `restart` and `disable --now`;
  - what `systemctl --user` prints when no user manager runs (try `env -u XDG_RUNTIME_DIR -u DBUS_SESSION_BUS_ADDRESS`);
  - the default `PATH` a user unit gets;
  - whether `After=network-online.target` means anything in the user manager (expected: no; user units can't order on system units such as `tailscaled.service`);
  - `loginctl show-user $USER -p Linger --value`, and whether `loginctl enable-linger` works without root here. Don't change linger in the spike: read the polkit rule, or try with a second throwaway user only if one exists.
  - how WSL starts systemd (`/etc/wsl.conf` `[boot] systemd=true`). Read only.
- [ ] **Step 3: launchd, from Apple's documentation and `man launchd.plist`** (no Mac here; mark every line "documented, not observed"):
  - `~/Library/LaunchAgents/<label>.plist`, and the label `io.eridian.kage`;
  - `launchctl bootstrap gui/<uid> <plist>`, `kickstart -k`, `bootout`, and `print` with its `state =` line;
  - `RunAtLoad`, `KeepAlive` with `SuccessfulExit` false, `ThrottleInterval`, `EnvironmentVariables`, `StandardOutPath` and `StandardErrorPath`;
  - the `PATH` an agent gets by default;
  - codesigning a SEA: `codesign --remove-signature` before injecting, `codesign --sign -` after;
  - whether a file `curl` downloaded carries `com.apple.quarantine` (it doesn't; a browser download does).
- [ ] **Step 4: Claude signed in, locally.** Which file shows a signed-in Claude Code 2.1.330 on Linux (expected `~/.claude/.credentials.json`)? Check that it exists only; never read it. Is `claude --version` local, with no network call? Check with `strace -f -e trace=connect` in WSL, or by running it with networking blocked.
- [ ] **Step 5: Write §7 and the "Read first" entry.** Write `.node-version`. Commit. `docs(spike): SEA, systemd user units and launchd for phase 6`

**The controller reads §7 before Task 2 starts.** Each answer that differs from what this plan assumes becomes a ruling. The assumptions are: CommonJS entry; `execArgv` else `NODE_OPTIONS`; a manifest asset; user units restarted rather than ordered after Tailscale; credentials file check.

---

### Task 2: Run modes, the version and the board source

**Files:**
- Create: `packages/server/src/install/runtime.ts`, `packages/server/src/sea-main.ts`
- Modify:
  - `packages/server/src/main.ts`: `ENTRY` and `hookCommandBase` move to `runtime.ts`; `import.meta.main` stays only in the ESM entry; add `kage --version`/`kage version`;
  - `packages/server/src/serve.ts`: `DIST` goes; it gets the board source and the `KAGE_SERVICE` cleanup;
  - `packages/server/src/assets.ts`, `packages/server/src/bundle.ts`.
- Test: `packages/server/src/install/runtime.test.ts`, `packages/server/src/assets.test.ts`, `packages/server/src/main.test.ts`

**Interfaces:**
- Produces (`install/runtime.ts`):
  ```ts
  export type RunMode =
    | { kind: 'sea'; exe: string }
    | { kind: 'bundle'; node: string; script: string }   // dist/kage.mjs, the npm package
    | { kind: 'source'; node: string; script: string };  // src/main.ts
  export const KAGE_VERSION: string;          // esbuild define from packages/server/package.json; "0.0.0-dev" from source
  export const ENTRY: string;                 // this program's script; "" in a SEA
  export function runMode(probe?: { isSea: boolean; execPath: string; entry: string }): RunMode;
  export function hookArgv(m: RunMode): string[];     // sea: [exe]; else [node, '--no-warnings', script]
  export function serviceArgv(m: RunMode): string[];  // sea: [exe, 'serve']; bundle: [node, '--v8-pool-size=1', script, 'serve']; source: throws
  export function serviceEnv(m: RunMode, path: string): Record<string, string>;
    // {PATH: path, MALLOC_ARENA_MAX: '2', KAGE_SERVICE: '1'} (+ NODE_OPTIONS: '--v8-pool-size=1' for sea when Task 1 says so)
  export function serviceCleanEnv(env: NodeJS.ProcessEnv): void;  // with KAGE_SERVICE=1: deletes MALLOC_ARENA_MAX, NODE_OPTIONS, KAGE_SERVICE
  ```
- Produces (`assets.ts`):
  ```ts
  export interface BoardFiles { list(): Promise<string[]>; read(urlPath: string): Promise<Uint8Array> }  // urlPath like '/index.html'
  export function dirFiles(dir: string): BoardFiles;
  export function seaFiles(sea?: { getRawAsset(key: string): ArrayBuffer }): BoardFiles;  // 'board/manifest.json' lists the paths; each file is 'board' + urlPath
  export function boardFor(m: RunMode, exists?: (p: string) => boolean): BoardFiles | null;
    // sea → seaFiles(); bundle → <dir of script>/web (npm layout) else <dir>/../../web/dist; source → <dir>/../../web/dist; null when no index.html
  export async function loadAssets(src: BoardFiles | string, encode?: Compress): Promise<Map<string, Asset>>;  // a string is dirFiles(string), as today
  ```
- `writeSettings(env)` in `main.ts` writes `hookArgv(runMode())`.

- [ ] **Step 1: Write the failing tests.**
  - `runMode` with each probe gives the kinds above. A `.mjs` script is `bundle` and a `.ts` script is `source`.
  - `hookArgv` for the SEA is exactly `['/home/u/.local/bin/kage']`, so the hook command in the settings file becomes `'/home/u/.local/bin/kage' 'hook' 'Stop'`. For the bundle it keeps `--no-warnings`.
  - `serviceArgv` for the bundle is `[node, '--v8-pool-size=1', script, 'serve']`. For the source it throws `Install Kage from a release, or run "pnpm build" and use node packages/server/dist/kage.mjs.`
  - `serviceEnv` has `MALLOC_ARENA_MAX: '2'` and `KAGE_SERVICE: '1'`, and never another key from the process environment.
  - `serviceCleanEnv` deletes the three keys only when `KAGE_SERVICE === '1'`. A user's own `MALLOC_ARENA_MAX` without it stays.
  - `serve` (with injected seams, as `main.test.ts` already does) runs `serviceCleanEnv` before its first tmux call. The env passed to the fake `tmuxExec` has no `MALLOC_ARENA_MAX`.
  - `loadAssets(seaFiles(fakeSea))` gives the same map (bodies, types, etags) as `loadAssets(dir)` for the same files.
  - `boardFor` picks `web/` beside the script before `../../web/dist`, and gives null when neither has `index.html`.
  - `kage --version` prints `KAGE_VERSION` and exits 0. A bundle built with `bundleServer(<tmp>/kage.mjs)` in `main.test.ts` prints `packages/server/package.json`'s version.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `import.meta` appears only in `runtime.ts` and in `main.ts`'s `import.meta.main` block.
  - `bundle.ts` gains `bundleSeaEntry(outfile)`: esbuild from `sea-main.ts`, `format: 'cjs'`, `define` for `KAGE_VERSION` and `import.meta.url` (a banner sets `__kageUrl` from `__filename`). `bundleServer` defines `KAGE_VERSION` too.
  - `sea-main.ts` calls the same `run(argv)` that `main.ts`'s `import.meta.main` block calls. Move that block into an exported `run(argv: string[]): Promise<void>` with no top-level await.
- [ ] **Step 4: Run** the unit tests, `corepack pnpm build`, and `node packages/server/dist/kage.mjs --version`. Expected: PASS, and the version printed.
- [ ] **Step 5: Commit.** `feat(server): run modes (sea, bundle, source), kage --version, the board from a folder or SEA assets`

---

### Task 3: The services: systemd user unit and launchd agent

**Files:**
- Create: `packages/server/src/install/run.ts`, `install/service.ts`, `install/systemd.ts`, `install/launchd.ts`
- Test: `install/run.test.ts`, `install/systemd.test.ts`, `install/launchd.test.ts`

**Interfaces:**
- Consumes: `serviceArgv`, `serviceEnv` (Task 2).
- Produces:
  ```ts
  // run.ts
  export interface RunResult { code: number; stdout: string; stderr: string; missing: boolean }  // missing: ENOENT, code -1
  export type Run = (cmd: string, args: string[], opts?: { timeoutMs?: number; env?: NodeJS.ProcessEnv }) => Promise<RunResult>;
  export const realRun: Run;  // execFile, no shell, 10 s default timeout, 1 MiB output cap
  // service.ts
  export interface ServiceSpec { argv: string[]; env: Record<string, string> }
  export type ServiceState = 'active' | 'inactive' | 'failed' | 'missing';
  export interface ServiceManager {
    readonly kind: 'systemd' | 'launchd';
    readonly file: string;                              // the unit or plist path
    readonly name: string;                              // "systemd user unit kage.service" / "launchd agent io.eridian.kage"
    unavailable(): Promise<string | null>;              // null, or one sentence why (with the fix)
    install(spec: ServiceSpec): Promise<void>;          // write the file (0644, no secrets), reload, enable, start or restart
    restart(): Promise<void>;
    remove(): Promise<void>;                            // stop, disable, delete the file, reload; fine when missing
    state(): Promise<ServiceState>;
    pathOfInstalled(): Promise<string | null>;          // the PATH written in the file (for doctor's service-path check)
  }
  export interface ServiceDeps { run: Run; home: string; env: NodeJS.ProcessEnv; uid: number }
  export function serviceManager(platform: NodeJS.Platform, d: ServiceDeps): ServiceManager | null;  // linux → systemd, darwin → launchd
  // systemd.ts
  export const SYSTEMD_UNIT = 'kage.service';
  export function systemdQuote(word: string): string;   // "…" with \ and " escaped, % → %%, $ → $$
  export function renderUnit(spec: ServiceSpec): string;
  export function systemdManager(d: ServiceDeps): ServiceManager & {
    lingerEnabled(): Promise<boolean>; enableLinger(): Promise<boolean>;  // loginctl, never sudo
  };
  // launchd.ts
  export const LAUNCHD_LABEL = 'io.eridian.kage';
  export function xmlEscape(text: string): string;
  export function renderPlist(spec: ServiceSpec, logPath: string): string;  // logPath ~/Library/Logs/kage.log
  export function launchdManager(d: ServiceDeps): ServiceManager;
  ```
- **The unit, exactly** (Task 1 may amend the restart lines; the values in `<>` are quoted with `systemdQuote`):
  ```ini
  [Unit]
  Description=Kage: a dashboard for your Claude Code sessions
  # User units can't wait for tailscaled.service; Kage exits while Tailscale has no address and systemd starts it again.
  StartLimitIntervalSec=0

  [Service]
  ExecStart=<argv…>
  Environment=<"PATH=…"> <"MALLOC_ARENA_MAX=2"> <"KAGE_SERVICE=1">
  Restart=on-failure
  RestartSec=5

  [Install]
  WantedBy=default.target
  ```
- **The plist:** `Label`, `ProgramArguments`, `EnvironmentVariables` (the same env), `RunAtLoad` true, `KeepAlive` `{SuccessfulExit: false}`, `ThrottleInterval` 10, and `StandardOutPath`/`StandardErrorPath` set to the log path.
- **Commands:**
  - systemd: `systemctl --user daemon-reload`, `systemctl --user enable --now kage.service` on the first install and `restart` after, `is-active kage.service` (map the exit codes Task 1 recorded), `disable --now kage.service`;
  - launchd: `launchctl bootout gui/<uid>/io.eridian.kage` (ignored if not loaded), then `bootstrap gui/<uid> <plist>`, `kickstart -k gui/<uid>/io.eridian.kage`, and `print gui/<uid>/io.eridian.kage` for the state.
- **`unavailable()`:** in WSL without systemd, `systemd isn't running in this WSL distribution. Add "[boot]" and "systemd=true" to /etc/wsl.conf, then run "wsl --shutdown" in Windows and open WSL again.`. On another Linux without a user manager, `systemctl --user doesn't answer, so Kage can't install its service. Run "kage serve" yourself, or log in with a full session.`.

- [ ] **Step 1: Write the failing tests:**
  - `realRun('definitely-not-a-command', [])` gives `missing: true`, and `realRun(process.execPath, ['-e', 'process.exit(3)'])` gives `code: 3`;
  - `renderUnit` for the bundle spec matches the block above line for line. `ExecStart` carries `--v8-pool-size=1`, and `Environment` carries `MALLOC_ARENA_MAX=2`.
  - **Review Focus 2:**
    - `systemdQuote('/home/a b/%h$x"q/kage')` is `"/home/a b/%%h$$x\"q/kage"`;
    - a `PATH` with a space survives quoted;
    - `renderPlist` escapes `&<>"'`.
  - **No secrets:** with a config whose token is `tok-1234567890abcdef` and ntfy keys set, neither rendered file contains any of the values (the spec takes no config at all; the test proves the env has only the four keys).
  - The fake `Run` records the exact command sequence for install (first time and again), restart and remove, for both managers. `remove` on a missing service succeeds.
  - `state()` maps each `is-active` exit code and launchctl's `state = running`.
  - `unavailable()` gives the WSL sentence when `/proc/sys/fs/binfmt_misc/WSLInterop` exists (an injectable probe) and `systemctl --user` fails.
  - The unit file's mode is 0644 and its folder is created (not on Windows).
  - `enableLinger` returns false when `loginctl` exits non-zero, and never runs `sudo`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests on Windows and in WSL. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(server): the systemd user unit and launchd agent, rendered and managed`

---

### Task 4: `kage doctor`, the requirement checks and `GET /status`

**Files:**
- Create: `install/checks.ts`, `install/doctor.ts`, `install/status.ts` (the client half)
- Modify: `packages/server/src/hooks/server.ts`, `packages/server/src/serve.ts` (the status provider), `packages/server/src/main.ts` (`doctor`)
- Test: `install/checks.test.ts`, `install/doctor.test.ts`, `hooks/server.test.ts`

**Interfaces:**
- Consumes: `configPath`, `displayPath` (Task 0); `RunMode`, `KAGE_VERSION` (Task 2); `Run`, `ServiceManager` (Task 3); `parseTmuxVersion` (`tmux/client.ts`); `loadConfig`; `socketPath` (`hooks/cli.ts`).
- Produces:
  ```ts
  // hooks/server.ts
  export interface ServerStatus { version: string; url: string; sessions: number; needsYou: number; pid: number }
  HookServer.prototype.onStatus(provider: () => ServerStatus): void;  // GET /status → 200 JSON; with no provider 503
  // status.ts
  export function fetchStatus(socket: string, timeoutMs?: number): Promise<ServerStatus | null>;  // http over the Unix socket, 1 s default
  // checks.ts
  export type CheckLevel = 'ok' | 'warn' | 'fail';
  export type CheckId = 'platform' | 'user' | 'tmux' | 'git' | 'claude' | 'claude-login' | 'tailscale'
    | 'config' | 'projects' | 'service' | 'service-path' | 'server' | 'install-path';
  export interface Check { id: CheckId; level: CheckLevel; label: string; fix: string | null }
  export type PackageManager = 'apt' | 'dnf' | 'pacman' | 'brew';
  export interface CheckDeps {
    run: Run; env: NodeJS.ProcessEnv; platform: NodeJS.Platform; uid: number | undefined; home: string;
    mode: RunMode; manager: ServiceManager | null;
    status: (socket: string) => Promise<ServerStatus | null>; fetch: typeof fetch;
  }
  export function requirementChecks(d: CheckDeps): Promise<Check[]>;  // platform, user, tmux, git, claude, claude-login, tailscale
  export function installChecks(d: CheckDeps): Promise<Check[]>;      // config, projects, service, service-path, server, install-path
  export function parseVersion(text: string): [major: number, minor: number] | null;  // "git version 2.43.0" → [2, 43]
  export function detectPackageManager(run: Run, platform: NodeJS.Platform): Promise<PackageManager | null>;
  export function installHint(tool: 'tmux' | 'git' | 'claude' | 'tailscale', platform: NodeJS.Platform, pm: PackageManager | null): string;
  export function formatChecks(checks: Check[]): string[];  // "✓ <label>", "! <label>", "✗ <label>" + an indented "  <fix>" line
  // doctor.ts
  export function doctorCommand(args: string[], io: Io, deps: CheckDeps): Promise<number>;  // 0 with no fail, else 1
  ```
- **Checks and their copy** (labels exact; `<v>` is the found version):
  - platform: Windows fails with `Kage runs on Linux or macOS. On Windows, install it inside WSL.`;
  - user: uid 0 fails with `Run Kage as your own user, not root.`;
  - tmux: `tmux <v>`, or `tmux <v> is too old: Kage needs 3.2 or newer.`, or `tmux isn't installed.`;
  - git: the same shape with 2.40;
  - claude: `Claude Code <v>` (from `claude --version`, `KAGE_CLAUDE_BIN` first), or `Claude Code isn't installed.`;
  - claude-login: Linux, the credentials file Task 1 names exists, or `ANTHROPIC_API_KEY` is set: ok `Claude Code is signed in.`. Otherwise warn `Claude Code may not be signed in. Run claude once and sign in.` macOS is always warn, `Kage can't tell whether Claude Code is signed in on macOS. Run claude once to check.`;
  - tailscale: `tailscale status --json` with `BackendState` `Running` and a `Self.TailscaleIPs` IPv4: `Tailscale is up (<MagicDNS name>).`. Otherwise fail `Tailscale isn't up.` or `Tailscale isn't installed.`;
  - config: parses (or doesn't exist yet: warn `No config yet. Run kage setup.`); a config holding a token with a mode looser than 0600 fails `<path> can be read by other users. Run chmod 600 <path>.`;
  - projects: `projectsRoot` exists;
  - service: installed and active, or warn with `Run kage setup to install the service.`;
  - service-path: each of `tmux`, `git`, `claude`, `tailscale` resolves on the `PATH` written in the unit or plist, or fails with `The service can't find <tool> on its PATH. Run kage setup again to update it.`;
  - server: `fetchStatus` answers, then one `GET <url>/` to Kage's own address answers 200 or 401;
  - install-path: in SEA mode, the folder of `exe` is on the shell's `PATH`, or warn `Add <dir> to your PATH: echo 'export PATH="<dir>:$PATH"' >> ~/.profile`.
- **Install hints** (printed, never run): `sudo apt install tmux` / `sudo dnf install tmux` / `sudo pacman -S tmux` / `brew install tmux` (git the same); Claude Code `curl -fsSL https://claude.ai/install.sh | bash`; Tailscale `curl -fsSL https://tailscale.com/install.sh | sh`, then `sudo tailscale up` on Linux, or `brew install --cask tailscale` on macOS. With no package manager found, the hint names the tool and its minimum version only.

- [ ] **Step 1: Write the failing tests** with a table-driven fake `Run` (a map from `cmd args…` to a `RunResult`):
  - each check's ok, warn and fail case with the exact label;
  - `tmux next-3.5` is ok and `git version 2.39.5` fails;
  - `tailscale status --json` with `BackendState: "Stopped"` fails;
  - doctor exits 1 with any fail and 0 with only warnings;
  - **doctor's calls:** with every check passing, the recorded `fetch` URLs are exactly `[http://127.0.0.1:<port>/]` (loopback config), and the recorded `Run` commands are a subset of `{tmux, git, claude, tailscale, systemctl, loginctl, launchctl, apt-get, dnf, pacman, brew}` with no install arguments;
  - `GET /status` on the hook socket answers the provider's JSON; `POST /status` is 405; `GET /hook` stays 405; with no provider, 503;
  - `fetchStatus` against a closed socket gives null within its timeout.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** `serve.ts` registers the provider once the source is up: the session count, needs-you count, the URL it prints, and `process.pid`.
- [ ] **Step 4: Run** the unit tests on Windows and in WSL. Then run `node packages/server/dist/kage.mjs doctor` in WSL by hand and paste the output into the report. Expected: PASS; the WSL output shows tmux 3.4 and git 2.43 as ok.
- [ ] **Step 5: Commit.** `feat(server): kage doctor, the requirement checks, GET /status on the hook socket`

---

### Task 5: `kage setup` and `kage status`

**Files:**
- Create: `packages/server/src/install/config-file.ts`, `install/prompt.ts`, `install/setup.ts`
- Modify: `install/status.ts` (`statusCommand`), `packages/server/src/main.ts` (`setup`, `status`, usage)
- Test: `install/config-file.test.ts`, `install/setup.test.ts`, `install/status.test.ts`

**Interfaces:**
- Consumes: Tasks 0, 2, 3 and 4; `writeSettings` (`main.ts`); `tailscaleDnsName` (`listen.ts`).
- Produces:
  ```ts
  // config-file.ts
  export function writeConfig(path: string, patch: Record<string, unknown>): Promise<void>;
    // reads the existing object (keeps every key), merges patch, writes tmp 0600 + rename, folder 0700, tightens a looser file;
    // throws ConfigError(`<path> isn't valid JSON. Fix it or move it away, then run kage setup again.`) and leaves the file alone
  export function generateToken(): string;  // 32 base64url characters from 24 random bytes
  // prompt.ts
  export interface Prompter { ask(question: string, def: string): Promise<string>; confirm(question: string, def: boolean): Promise<boolean> }
  export function ttyPrompter(input: NodeJS.ReadableStream, output: NodeJS.WritableStream): Prompter;  // node:readline/promises
  // setup.ts
  export interface SetupDeps extends CheckDeps { prompt: Prompter | null; isTty: boolean; writeSettings: (env: NodeJS.ProcessEnv) => Promise<string>; waitMs?: number }
  export function suggestProjectsRoot(home: string): Promise<string>;  // ~/projects if it exists, else the direct child of home with most git repos one level down, else ~/projects
  export function setupCommand(args: string[], io: Io, deps: SetupDeps): Promise<number>;
  // status.ts
  export function statusCommand(io: Io, deps: CheckDeps): Promise<number>;  // 0 when the server answers, else 1
  ```
- **Flags:** `--yes` (take every default, ask nothing), `--projects <dir>`, `--host <name or IP>`, `--port <n>`, `--token` / `--no-token`, `--no-service`, `--no-linger`.
- **Flow and copy** (§5.13's five steps):
  1. Refuse root. Run `requirementChecks`. Print `formatChecks`. Any fail ends setup with `Fix the items above, then run kage setup again.` (exit 1).
  2. Ask, with the current config's values as defaults:
     - `Projects folder [<suggestion>]:` (must exist, or `Create <dir>?` [Y/n]);
     - `Host name [<MagicDNS short name>]:`;
     - `Port [8080]:`;
     - `Set an access token? Anyone on your tailnet can reach Kage. [Y/n]`. Yes keeps an existing token, or generates one and prints it once: `Your token: <token>. Kage asks for it once per browser. It's saved in <config path>.`
  3. `writeConfig` with only the keys asked (`projectsRoot`, `host`, `port`, `token`), then `writeSettings`.
  4. Unless `--no-service`:
     - `manager.unavailable()` prints its sentence and skips the service (the exit code stays 0, and the end says `Start Kage with: kage serve`);
     - otherwise `install(serviceArgv(mode), serviceEnv(mode, env.PATH))`, then print `Installed the <manager.name>.`;
     - on Linux, unless linger is on or `--no-linger`: `Keep Kage running when you're logged out? [Y/n]`, then `enableLinger()`, falling back to `Run this to allow it: sudo loginctl enable-linger <user>`.
  5. Poll `fetchStatus` every 250 ms for up to `waitMs` (default 15 s), then `GET <url>/` once (200 or 401). Print `Kage is running at <url>`. On a timeout, print `Kage didn't answer at <url>. See: journalctl --user -u kage -e` (launchd: `See: ~/Library/Logs/kage.log`) and exit 1. Last, print `To start Claude yourself with Kage watching: claude --settings "$(kage hooks-path)" --permission-mode default`.
- **Status copy:**
  ```
  Kage <version>
  Service: running (systemd user unit kage.service)   | stopped | failed | not installed
  Address: http://my-pc:8080
  Sessions: 4 (1 needs you)
  ```
  When the server doesn't answer, the last two lines become `Kage isn't answering on <socket path>.`

- [ ] **Step 1: Write the failing tests** (temporary HOME and XDG folders, fake `Run`, fake `ServiceManager`, a scripted `Prompter`):
  - **Review Focus 1:** with no terminal and no `--yes`, setup exits 1 with `kage setup needs a terminal for its questions. Run it in one, or pass --yes to take the defaults.`, and nothing was written.
  - `--yes` on a fresh HOME:
    - the config holds `projectsRoot`, `host`, `port` 8080 and a 32-character token;
    - mode 0600 in a 0700 folder;
    - the manager got `install` once with the bundle's argv and env;
    - the output ends with the address line and the `claude --settings` line.
  - **Review Focus 4:**
    - an existing config with `token`, `ntfyTopic`, `ntfyToken`, `autoArchive` and an unknown key `"x": 1`, re-run with `--port 9090`: every other key is byte-equal after, and the token is unchanged;
    - the mode stays 0600, and a 0644 file becomes 0600;
    - a config holding `{bad` makes setup exit 1 with the "isn't valid JSON" sentence, and the file is unchanged;
    - the second run calls `install` again, which restarts; there is still one unit file.
  - A requirement fail stops before any question.
  - Root (uid 0) is refused.
  - With `manager.unavailable()` set, setup still writes the config and says `Start Kage with: kage serve`.
  - The linger question is skipped when `lingerEnabled()` is true, and the `sudo loginctl` line is printed when `enableLinger()` fails.
  - The wait times out after `waitMs` (fake timers) with the journalctl line.
  - `suggestProjectsRoot`: a home with `code/{a,b,c}/.git` and `misc/d/.git` gives `~/code`.
  - `statusCommand`: running, stopped and not-installed outputs as above, and the server-not-answering line.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests on Windows (modes skipped), in WSL and in `test:linux`. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(server): kage setup (checks, questions, config, service, address check) and kage status`

---

### Task 6: SEA builds, release artifacts and the release workflow

**Files:**
- Create: `packages/server/src/release/build.ts`, `.github/workflows/release.yml`
- Modify:
  - `packages/server/src/bundle.ts` (`bundleSeaEntry`, from Task 2);
  - `package.json`: `"release:local": "pnpm build && node packages/server/src/release/build.ts --out dist/release"`; add `postject` at an exact version at least two weeks old, only if Task 1 found no `--build-sea`;
  - `e2e/harness.ts`, `e2e/perf.spec.ts`: with `KAGE_PERF_SEA=<path>`, the idle measurement runs that executable with `serviceEnv`, and records `idle RSS (SEA)` next to the bundle's.
- Test: `packages/server/src/release/build.test.ts`

**Interfaces:**
- Consumes: `bundleServer`, `bundleSeaEntry` (Task 2); the board in `packages/web/dist`.
- Produces:
  ```ts
  export type Target = 'linux-x64' | 'linux-arm64' | 'darwin-x64' | 'darwin-arm64';
  export function hostTarget(platform?: NodeJS.Platform, arch?: string): Target | null;
  export function seaConfig(entry: string, blob: string, board: Map<string, string>): object;
    // main, output, disableExperimentalSEAWarning: true, useCodeCache per Task 1, execArgv per Task 1,
    // assets: {'board/manifest.json': …, 'board/<path>': <file>}
  export function buildSea(o: { out: string; node?: string }): Promise<string>;  // dist/release/kage-<target>.gz; on darwin, codesign --sign - before gzip
  export function stageNpm(o: { out: string; version: string }): Promise<string>;  // dist/release/npm/ then `npm pack` → eridian-io-kage-<version>.tgz
  export function writeSums(dir: string, files: string[]): Promise<string>;  // "<sha256>  <name>\n" sorted, the format sha256sum -c reads
  export function writeVersion(dir: string, version: string): Promise<string>;  // VERSION: "<version>\n"
  // CLI: node packages/server/src/release/build.ts --out <dir> [--sea-only] [--version-override <v>]
  //   default: the SEA for the host, the npm package, VERSION and SHA256SUMS; --version-override is for Task 9's update check only
  ```
- **Release files** (the names `install.sh` and `kage update` rely on): `kage-linux-x64.gz`, `kage-linux-arm64.gz`, `kage-darwin-x64.gz`, `kage-darwin-arm64.gz`, `eridian-io-kage-<version>.tgz`, `VERSION` and `SHA256SUMS`, which covers every other file.
- **The npm package** (`dist/release/npm/`):
  - `package.json`: name `@eridian-io/kage`, the version, `bin: {"kage": "kage.mjs"}`, `engines: {"node": ">=24.2"}`, `license: "AGPL-3.0-only"`, `files: ["kage.mjs", "web/"]`, and no dependencies;
  - `kage.mjs`, the bundle;
  - `web/`, the board;
  - `README.md` and `LICENSE`.
- **Workflow** (`on: push: tags: ['v*']`, plus `workflow_dispatch` that builds without publishing):
  - `permissions: contents: read` by default;
  - job `build`, a matrix over `ubuntu-24.04` (linux-x64), `ubuntu-24.04-arm` (linux-arm64), `macos-15` (darwin-arm64) and `macos-15-intel` (darwin-x64). Each runs `setup-node` with `node-version-file: .node-version`, `pnpm install --frozen-lockfile`, `pnpm build` and `node packages/server/src/release/build.ts --out dist/release --sea-only`. It smoke-tests the binary (`--version` equals the tag; `kage hook Stop </dev/null` prints nothing and exits 0; `kage doctor` runs) and uploads the `.gz`;
  - job `publish` (needs `build`; `contents: write`, `id-token: write`, `attestations: write`) fails unless the tag equals `v<package version>`. It stages the npm package, writes `VERSION` and `SHA256SUMS`, runs `actions/attest-build-provenance` on every file, `gh release create "$TAG" --verify-tag dist/release/*` and `npm publish --provenance --access public` (npm trusted publishing, set up by the owner).
  - Actions are pinned by commit SHA with a version comment, like `ci.yml`, at releases at least two weeks old.

- [ ] **Step 1: Write the failing tests:**
  - `hostTarget` for each pair, and null for `win32`;
  - `seaConfig` lists every board file under `board/` plus the manifest, and has `disableExperimentalSEAWarning: true`;
  - `writeSums` output is checked by running `sha256sum -c` in its folder (`runIf` not win32);
  - `stageNpm`'s `package.json` has exactly the fields above, `npm pack --dry-run --json` lists only the allowed files, and `node <staged>/kage.mjs --version` prints the version;
  - `buildSea` on Linux (`describe.runIf(process.platform === 'linux')`, about 60 s, its own timeout):
    - the gunzipped executable's `--version` prints the version;
    - `hook Stop </dev/null` writes nothing to stdout or stderr and exits 0;
    - `serve --demo` with `KAGE_HOST=127.0.0.1` and a free port serves `/` with the board's `index.html` from the embedded assets, and `/app-*.js` with its immutable cache header.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Then write the workflow.
- [ ] **Step 4: Verify.**
  - In WSL: `corepack pnpm release:local`, then `cd dist/release && sha256sum -c SHA256SUMS`. Expected: every line `OK`.
  - In WSL: the `perf` project with `KAGE_PERF_SEA=<gunzipped kage>`. Expected: `idle RSS (SEA)` under 80 MB and CPU under 1%. Record the `kage hook` wall time from the SEA (§7 wants it improved, not asserted).
  - Nothing runs the workflow locally: read it against the list above, and run `corepack pnpm lint` (Biome skips YAML) and `typecheck`.
- [ ] **Step 5: Commit.** `feat(release): SEA builds with the board embedded, the npm package, SHA256SUMS, the release workflow (not run)`

---

### Task 7: `kage update` and `kage uninstall`

**Files:**
- Create: `packages/server/src/install/update.ts`, `install/uninstall.ts`
- Modify: `packages/server/src/main.ts`
- Test: `install/update.test.ts`, `install/uninstall.test.ts`

**Interfaces:**
- Consumes: `RunMode`, `KAGE_VERSION` (Task 2); `ServiceManager` (Task 3); `Prompter` (Task 5); `Target`, the file names (Task 6); `configPath`, `stateDir`, `displayPath`.
- Produces:
  ```ts
  // update.ts
  export const RELEASE_BASE = 'https://github.com/eridian-io/kage/releases/latest/download';
  export class ReleaseError extends Error {}
  export function releaseBase(env: NodeJS.ProcessEnv): URL;   // KAGE_RELEASE_BASE or RELEASE_BASE; https, or http on loopback, else ReleaseError
  export function assetName(t: Target): string;               // kage-<target>.gz
  export function parseSums(text: string): Map<string, string>;  // name → lowercase hex; ignores malformed lines
  export function compareVersions(a: string, b: string): -1 | 0 | 1;  // semver with numeric parts; a pre-release sorts below its release
  export function downloadVerified(fetch: typeof fetch, base: URL, name: string, sums: Map<string, string>,
    o?: { maxBytes?: number; timeoutMs?: number }): Promise<Uint8Array>;  // 200 MiB, 120 s; ReleaseError on any doubt
  export function replaceBinary(target: string, gz: Uint8Array): Promise<void>;
    // gunzip → <dir>/.kage-new-<pid> (0755, fsync) → rename over target; the temp file removed on any failure
  export function updateCommand(args: string[], io: Io, deps: { fetch: typeof fetch; mode: RunMode; manager: ServiceManager | null; uid: number | undefined }): Promise<number>;
  // uninstall.ts
  export function uninstallCommand(args: string[], io: Io, deps: { mode: RunMode; manager: ServiceManager | null; prompt: Prompter | null; uid: number | undefined; home: string; env: NodeJS.ProcessEnv }): Promise<number>;
  ```
- **Update flow and copy:**
  - Not a SEA:
    - bundle: `This Kage came from npm or a build. Update it with: npm install -g @eridian-io/kage@latest`;
    - source: `This Kage runs from a checkout. Update it with git pull and pnpm build.`

    Exit 1 in both cases.
  - Otherwise: fetch `VERSION`. When it is not newer, print `Kage <v> is the latest.` and exit 0, unless `--force`.
  - Then `SHA256SUMS`, then the asset, then `downloadVerified`, then `replaceBinary(mode.exe, …)`.
  - Then `manager.restart()` if the service is installed. Print `Updated Kage <old> → <new>.` and `Restarted the service.`, or `Restart Kage to use it.`
  - A `ReleaseError` prints `Update failed: <reason>. Nothing was changed.` and exits 1. The reasons are fixed words: `couldn't reach the release server`, `HTTP <status>`, `no checksum for <name>`, `checksum mismatch`, `download too large`, `timed out`.
- **Uninstall flow and copy:**
  - Refuse root.
  - Without `--yes`, confirm `Remove the Kage service and program? [y/N]`. With no terminal and no `--yes`, exit 1 with the same sentence shape as setup's.
  - `manager.remove()`. In SEA mode, delete `mode.exe`. In bundle mode, print `Remove the program with: npm uninstall -g @eridian-io/kage`.
  - With `--purge`, delete the config folder and the state folder (`stateDir`: records, `claude-settings.json`, the socket).
  - Then always print:
    ```
    Removed: <what was removed, one per line>
    Kept: your projects, their worktrees and branches, and the tmux session "kage" with its windows.
    Kept: <config path> and <state dir> (kage uninstall --purge removes them).   ← only without --purge
    ```

- [ ] **Step 1: Write the failing tests.** Run a release server on `127.0.0.1` (`node:http`) with `VERSION`, `SHA256SUMS` and the asset, as a SEA in a temporary folder would see them; the target is a temporary file holding `old`.
  - The happy path: the target holds the new bytes, mode 0755, and `restart` was called once.
  - **Review Focus 3:** each of these leaves the target byte-equal to `old`, leaves no `.kage-new-*` file in its folder, and prints the fixed reason:
    - a wrong sum;
    - `SHA256SUMS` without the line;
    - 404 on the asset;
    - a body cut halfway (the server destroys the socket);
    - a body over `maxBytes`;
    - a server that never answers (`timeoutMs` 200);
    - a gzip that doesn't decompress.
  - `releaseBase` refuses `http://example.com` and accepts `http://127.0.0.1:1234`.
  - `compareVersions`: `0.10.0 > 0.9.1`, `1.0.0 > 1.0.0-rc.1`, equal is 0.
  - Same version without `--force`: no asset download, and the message as above.
  - Bundle and source modes print their lines and touch nothing.
  - Uninstall:
    - **with `--purge`** on a temporary HOME holding a config, a state folder, a project with `.worktrees/x` and a branch: the project, the worktree and `git branch` are unchanged; the config and state folders are gone; the fake manager got `remove`; the fake `Run` never saw `tmux kill-*` or `git worktree remove`;
    - **without `--purge`:** both folders stay and the `Kept:` line names them;
    - root is refused, and no terminal without `--yes` exits 1.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests on Windows (the mode check skipped) and in WSL. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(server): kage update (verified, atomic, restarts the service) and kage uninstall (keeps your work)`

---

### Task 8: `install.sh`

**Files:**
- Create: `install.sh` (repo root, POSIX `sh`, mode 0755 in git, under 150 lines with comments)
- Test: `packages/server/src/install/install-sh.test.ts` (`describe.runIf(process.platform !== 'win32')`, runs `sh install.sh` against a release server on `127.0.0.1` with fake `uname` and `kage` on `PATH`)

**Interfaces:**
- Consumes: the release file names and the `SHA256SUMS` format (Task 6), `KAGE_RELEASE_BASE` (Task 7).
- Produces: `install.sh [setup flags…]`. Arguments are passed on to `kage setup`, so `curl -fsSL …/install.sh | sh -s -- --yes` works. The environment: `KAGE_INSTALL_DIR` (default `$HOME/.local/bin`), `KAGE_RELEASE_BASE`, `KAGE_NO_SETUP=1` (install only).
- **Behaviour, in order:**
  1. `set -eu`. Refuse root: `Run the installer as your own user, not root.`
  2. Detect `uname -s` / `uname -m`: `Linux`/`Darwin`, `x86_64`/`amd64` → x64, `aarch64`/`arm64` → arm64. Anything else exits with `Kage has no build for <os> <arch>.`. `MINGW*`, `MSYS*` and `CYGWIN*` exit with `On Windows, install Kage inside WSL: https://learn.microsoft.com/windows/wsl/install`.
  3. Need `curl`, `gunzip`, and `sha256sum` or `shasum -a 256`. Name whatever is missing.
  4. Make a temporary folder (`mktemp -d`) with `trap 'rm -rf "$tmp"' EXIT INT TERM`. Download `SHA256SUMS` and `kage-<target>.gz` with `curl -fsSL --proto '=https' --tlsv1.2`. The proto restriction is dropped only for a loopback `KAGE_RELEASE_BASE`.
  5. Find the asset's line in `SHA256SUMS` (an exact name match) and compare it with the computed sum. A mismatch or no line exits with `Checksum check failed for kage-<target>.gz. Nothing was installed.`
  6. `gunzip`, `chmod 755`, and `mv` into `$KAGE_INSTALL_DIR/kage` (`mkdir -p` first). The move is on the same file system: write `$dir/.kage-new.$$`, then rename.
  7. If the folder isn't on `PATH`, print `Add <dir> to your PATH: echo 'export PATH="<dir>:$PATH"' >> ~/.profile`.
  8. Unless `KAGE_NO_SETUP=1`: if `/dev/tty` can be opened, `exec "$dir/kage" setup "$@" </dev/tty`. Otherwise print `Installed <dir>/kage. Run "kage setup" in a terminal to finish.` and exit 0.

- [ ] **Step 1: Write the failing tests:**
  - a good release installs into `KAGE_INSTALL_DIR` (a folder with a space in its name), with mode 0755, and the fake `kage` records `setup --yes` (with `KAGE_NO_SETUP` unset; `script -qc` provides a tty, or the test asserts the no-tty message when `script` is absent);
  - **Review Focus 3:** a bad sum, a missing line, a 404 and a cut body each exit non-zero with the message, leave an existing `kage` byte-equal, and leave no temporary folder (the test points `TMPDIR` at its own folder and lists it after);
  - **Review Focus 1:** with no tty (`setsid` with stdin from `/dev/null`), the exit is 0 and the output says `Run "kage setup" in a terminal to finish.`;
  - uid 0 is refused (a fake `id` on `PATH`);
  - `uname` giving `MINGW64_NT` prints the WSL line, and `riscv64` prints the no-build line;
  - `install.sh` runs under `dash` as well as `bash` (both in WSL and Docker);
  - a test greps the script for `sudo` and finds none.
- [ ] **Step 2: Run them** in WSL. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** in WSL and `test:linux`. Expected: PASS. On Windows the file is skipped.
- [ ] **Step 5: Commit.** `feat: install.sh (detects the platform, verifies SHA256SUMS, installs to ~/.local/bin, runs kage setup)`

---

### Task 9: Clean-install check in Docker

A fresh container with Node's release image and no Kage: the real `install.sh`, the real SEA built in the container, `kage setup --yes`, a task through the hook socket, `kage update`, and `kage uninstall`. systemd doesn't run in the container, so a fake `systemctl` starts the unit's own `ExecStart` with its own `Environment=`. That runs exactly what the unit says. The real systemd check is the Phase 6 check in WSL.

**Files:**
- Create:
  - `Dockerfile.install`: `ARG NODE_VERSION` and `FROM node:${NODE_VERSION}-bookworm-slim` (the script passes `.node-version`), with tmux, git, curl, procps and `util-linux` (`script`, `setsid`), and a user `dev` (uid 1000);
  - `scripts/test-install.sh`: the same tracked-files copy as `test-linux.sh`;
  - `scripts/install-fakes/systemctl`, `loginctl`, `tailscale`, `claude` (POSIX sh). The `claude` fake fires `SessionStart` and `Stop` through `kage hook` and writes its environment to `$FAKE_LOG`;
  - `scripts/release-server.mjs` (a static `node:http` server for a folder, on 127.0.0.1).
- Modify: `package.json` (`"test:install": "bash scripts/test-install.sh"`)

**Interfaces:**
- Consumes: everything above.
- Produces: `corepack pnpm test:install`, which prints `== install check passed` or fails at the first broken stage.

- [ ] **Step 1: Write `scripts/test-install.sh`.** Its stages, each failing loudly:
  1. As root in the fresh container: `corepack pnpm install --frozen-lockfile` and `corepack pnpm release:local` (Linux x64 only). Every later stage runs as `dev`.
  2. Start `release-server.mjs` on `dist/release`. Put the fakes in `/opt/fakes`, and `claude` in `~/.npm-global/bin` (Review Focus 5). `PATH` holds both.
  3. `curl -fsSL http://127.0.0.1:<p>/install.sh | KAGE_RELEASE_BASE=http://127.0.0.1:<p> KAGE_INSTALL_DIR="$HOME/my bin" sh -s -- --yes --host 127.0.0.1 --port 4397 --projects ~/projects` (with `script -qc` for a tty). The release server also serves `install.sh` from the copied tree.
  4. Assert:
     - `~/.config/kage/config.json` is 0600 and holds a token;
     - the unit has `MALLOC_ARENA_MAX=2` and the `--v8-pool-size=1` route Task 1 chose, and doesn't contain the token;
     - `curl http://127.0.0.1:4397/` answers the login page;
     - `kage status` shows `Sessions: 0`;
     - `kage doctor` exits 0 except for the warnings it should give in a container.
  5. Start `claude` in a tmux window of `kage` the way the README says. `kage status` shows `Sessions: 1`. `$FAKE_LOG` holds no `MALLOC_ARENA_MAX` and no `NODE_OPTIONS`.
  6. Rebuild the release with version `0.0.1-test.2` (`--version-override`, a `release/build.ts` flag for this check only). `kage update` prints `Updated Kage …`, the new `kage --version` matches, and the fake `systemctl` saw `restart`.
  7. Tamper with `SHA256SUMS`. `kage update --force` fails with `checksum mismatch`, and `kage --version` is unchanged.
  8. `kage uninstall --yes`: the program and the unit are gone, `~/projects/demo/.worktrees/x` and the tmux session remain, and the config remains. Then run `install.sh` again, and `kage uninstall --yes --purge` removes the config and state folders and keeps the projects.
- [ ] **Step 2: Run** `corepack pnpm test:install`. Expected: `== install check passed`. Run it twice in a row.
- [ ] **Step 3: Commit.** `test: clean install, update and uninstall in a fresh container (pnpm test:install)`

---

### Task 10: Docs

**Files:**
- Modify `docs/specs/2026-11-21-kage-design.md`, with amendments marked "(amended 2026-11-22, phase 6)":
  - §3: the release Node from `.node-version`;
  - §5.8a: user units can't order on `tailscaled.service`, so the unit restarts Kage every 5 s until Tailscale has an address;
  - §5.10: install safety (no root, checksums, HTTPS, no secrets in units, what doctor may call);
  - §5.12: `GET /status` on the hook socket;
  - §5.13, as built: the run modes, the release file names, `VERSION`, `KAGE_RELEASE_BASE`, `KAGE_INSTALL_DIR`, `KAGE_NO_SETUP`, the setup flags, the unit and plist with the R91 flags, `KAGE_SERVICE` and why, update and uninstall as built, and the npm layout;
  - new §6.8, "Copy added in phase 6": every new sentence from Tasks 3–9;
  - §7: idle RSS on the SEA, and the `kage hook` wall time from the SEA;
  - §9: point the phase 6 check at the Docker and WSL steps, and name the Mac step as the owner's.
- `docs/specs/host-integration.md`: a "Read first" pointer to §7.
- `docs/backlog.md`: mark B52 done. Add what was deferred, at least:
  - macOS notarisation;
  - a Homebrew tap;
  - `kage update` checking provenance attestations as well as checksums;
  - pinning `node:` in `Dockerfile.install` by digest (with B18);
  - WSL starting at Windows boot (out of Kage's hands; document it).
- `docs/plans/README.md`: the phase 6 row links this plan, `Built, not merged (branch phase-6)`.
- `README.md`:
  - "Install": the one-liner, marked **"works once the first release is out"**, with the npm way and a "from a checkout" way that works today (`pnpm build`, then `node packages/server/dist/kage.mjs setup`);
  - what `install.sh` does, step by step, with a pointer to read it first;
  - `kage setup` / `status` / `update` / `uninstall` / `doctor`;
  - the service (systemd or launchd, linger, logs in `journalctl --user -u kage` or `~/Library/Logs/kage.log`);
  - WSL needs systemd on;
  - "Requirements" drops "Node.js" for release installs;
  - "Releasing" for maintainers: bump the version, tag `v<version>`, and the workflow does the rest, on the owner's go.
- `packages/web/src/copy.test.ts`: read §6.8 too.

- [ ] **Step 1: Update the docs** as listed, in the house style.
- [ ] **Step 2: Run** `corepack pnpm lint` and `copy.test.ts`. Expected: clean, PASS.
- [ ] **Step 3: Commit.** `docs: install and release — setup, the services, install.sh, SEA releases as built`

---

### Task 11: The landing page

**Files:** `site/index.html`, `site/style.css` if needed. No new images.

- [ ] **Step 1: Update `site/`:**
  - the status chip `In development · phases 1–6 built`;
  - the "One-line installer" card: drop `coming` for `with the first release`, and show the one-liner in the page's code style with the line under it, `Works once the first release is published. Until then, install from a checkout.`;
  - a short "What the installer does" list (detects your platform, verifies the checksum, installs to `~/.local/bin` without sudo, runs `kage setup`, starts on boot);
  - the roadmap's "Install and release" entry marked `built, not merged yet`, the same as phases 2–5;
  - the clone instructions point at `phase-6`.
  - Never say a release exists, give a download count, or link a Releases page as if it held files.
- [ ] **Step 2: Check** that the page renders at 1320 px and 390 px wide (a Playwright screenshot of `site/index.html`, the browser page only), with no horizontal scroll and no external requests but the existing ones.
- [ ] **Step 3: Commit.** `site: phase 6 — the installer, shown as coming with the first release`. Publishing (`scripts/publish-site.sh`) is the controller's step, as in phase 5 (R83).

---

**Phase 6 check (spec §9: "on a clean Linux machine and a clean Mac, the one-line install leads to a working board, and Kage survives a reboot"):**

1. **Clean Linux, in Docker:** `corepack pnpm test:install` passes, and `corepack pnpm test:linux` is all green, with the budgets table pasted into the ledger.
2. **Real systemd, and a reboot, in WSL:**
   - Record `loginctl show-user $USER -p Linger --value` first.
   - Build `dist/release` in WSL and serve it with `scripts/release-server.mjs`.
   - Run the one-liner with `KAGE_RELEASE_BASE=http://127.0.0.1:<p>`, in a real terminal, answering the questions: projects `/tmp/kp6/projects` (a scratch repo), host `127.0.0.1`, port 4396, token yes, linger yes.
   - Expect `systemctl --user is-active kage` to say `active`, and the board to answer.
   - Open the board in Chromium (a browser-page screenshot), sign in with the printed token, and start one task with real `claude` 2.1.330 (one prompt). It reaches done.
   - Run `wsl --terminate <distro>` from Windows, then `wsl -d <distro> -e true`. Within 30 s, `kage status` shows `Service: running`, the board answers again, and the task shows as ended with Resume.
   - Run `kage update` against a release built with a higher test version: `Updated …`, then the service is active again.
   - Run `kage uninstall --purge --yes`. The scratch repo and its worktree remain. Restore linger to what was recorded.
3. **Clean Mac: the owner's step.** There is no Mac here. After the owner's go for the first release, the workflow's macOS jobs smoke-test both darwin binaries. On a Mac, the owner runs the one-liner, opens the board, reboots, and checks the board again. The plan's launchd facts are marked "documented, not observed" until then.
4. **Not done in this phase:** tagging, creating the GitHub Release, publishing to npm and pushing `main` all wait for the owner's explicit go.
