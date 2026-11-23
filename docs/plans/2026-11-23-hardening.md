# Hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix what four deep reviews of the whole product (security, reliability, performance, usability) found, within the scope ruling R126, without breaking a budget:
- **Security:** per-login server sessions with expiry and a sign-out; a Host and Origin allow-list of names nobody else can answer for; no live mode without a token unless the user opts out; git pinned to the record's repository; the cheap minors.
- **Reliability:** a detached control client isn't a dead tmux server; a lost `Stop` doesn't leave a session running; the board notices a dead stream; history doesn't slow the start; the cheap minors.
- **Performance:** the board compressed at build time; a light `kage hook`; memoised rows; a smaller first load; done sessions' tails stop polling; the young generation, if it measures safe; anonymous memory in the budget.
- **Usability:** a Quick start, `pnpm demo`, setup on loopback, advice that fits a checkout, phone pings in setup, `kage restart` and `kage logs`, doctor that agrees with itself, a calm demo, the right `--help` line, an honest README.
- **R125's parked items.**

**Architecture:**
- **No new subsystem.** Each task fixes one finding (or one tight group) in the module that owns it, with the test the review proposed, in the review's own terms. The reviews' scenarios become the tests' names.
- **Auth moves from a value to a store.** `auth.ts` gets a `SessionStore` (random ids, kept hashed, in memory only, bound to the login's peer address). `createApp`, the terminal upgrade and the event hub take one `Auth` object instead of the token, so a sign-out reaches every stream and terminal that session opened.
- **Copy stays in step.** Every task that adds, changes or removes a sentence edits spec §6.6–§6.8 or the new §6.9 in the same commit; `spec-copy.test.ts` keeps both sides honest.

**Tech Stack:** as phase 6 (Node ≥ 24.2, TypeScript strict with `erasableSyntaxOnly`, Hono, Preact with signals, esbuild, vitest, Playwright 1.64.1, tmux 3.4 and git 2.43 in WSL Ubuntu 24.04 and Docker). No new dependency.

**Spec:** [`docs/specs/2026-11-21-kage-design.md`](../specs/2026-11-21-kage-design.md): §5.3 (status), §5.5 (live updates), §5.8 and §5.8a, §5.9 (pings), §5.10 (security, every bullet), §5.11 (config), §5.12 (API), §5.13 (install, as built), §6.5–§6.8 (states and copy), §7 (budgets), §8, §9.

Facts: [`host-integration.md`](../specs/host-integration.md) §7 (systemd, launchd, SEA). Backlog: [`docs/backlog.md`](../backlog.md) (B20, B21, B26, B42, B50 and B51 touch this plan). Ledger: R125 (phase 6's parked minors) and R126 (this scope). The four reviews are in `.superpowers/sdd/hardening/` (git-ignored, this PC only); each task restates what it needs from them.

**Owner decisions, excluded from this plan (R126):**
- **Release signing (security I4, B57).** It needs an owner-held key, or a decision to verify GitHub's attestation offline. Until then the spec's "checksums protect against corruption, not a compromised release host" stays true, and Task 20 only documents the tag-pinned installer URL (M9).
- **The phone layout (B51, usability U1).** The owner chose desktop first. It becomes its own future phase; this plan only corrects the README's claim (Task 20) and widens B51 to the whole board.
- **The contrast tokens (usability U10).** `--fg-3` and the age colour are a design change: the target page and the reference screenshots change with them (§8). Backlog only.

## Global Constraints

- **Everything in the phase 1–6 Global Constraints still applies:**
  - Node ≥ 24.2, strict mode plus `erasableSyntaxOnly`, no native modules, no new runtime dependency;
  - `execFile`/`spawn` with argument arrays, never a shell (`install.sh` and the fakes excepted);
  - invented test data; tests run under a temporary `HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME` and `XDG_RUNTIME_DIR`, with a fake `Run`, and never touch the user's tmux server, config, state, git config, `~/.claude`, systemd or launchd;
  - `describe.runIf(hasTmux)` for tmux tests, and `describe.runIf(process.platform !== 'win32')` for `sh`, socket and file-mode tests;
  - hooks stay silent; the rulings R4–R126, K1–K10, N0–N4 and PF4 still hold.
- **Start point:** branch `hardening` from `phase-6` at `de284bc`.
- **Every budget of spec §7 holds, measured by its rules:**
  - first load at most **27,456 B** gzipped (`packages/web/sizes.ts`); Task 14 lowers the cap to its new measurement plus 1,024 B, and no task may raise it;
  - fonts at most 61,440 B; the terminal chunk at most 102,400 B and its loader at most 600 B;
  - time to a usable board under 300 ms; hook to screen under 150 ms (p95 of 40);
  - idle server under 1% CPU and under **80 MB RSS** with 10 done sessions, on the shipped bundle with the service's flags (`--v8-pool-size=1`, `MALLOC_ARENA_MAX=2`);
  - SSE under load at most 43 `session.updated` frames per session and 1,290 in all; rendering at most 500 line nodes, a diff at most 1,000 line elements;
  - no `allowFail` marker (`perf-markers.test.ts`).
- **Kage never writes Claude's configuration (R25).** Hooks reach Claude only through `claude --settings <kage hooks-path>`; Claude's credentials file is checked for existence only, never read.
- **Tests never contact an external host (R85).** The vitest fetch guard (`packages/server/test/setup-fetch.ts`) stays; ntfy, releases and Kage's own address are always fakes on `127.0.0.1`.
- **The owner's machine (R106, F17):** no task or check changes linger, runs `wsl --terminate` or `wsl --shutdown`, or touches the default tmux server. One Docker run at a time (`test:linux`, `test:install`, `test:reboot`). Red-team probes attack `127.0.0.1` servers only.
- **Releases are the owner's step (R107):** no tag, no GitHub Release, no npm publish, no push to `main`, no run of the release workflow.
- **Copy:**
  - short plain sentences in the house style, calm, each ending in a full stop, except an address line that has to copy cleanly ("Kage is running at <url>");
  - a task that changes or removes a sentence quoted in spec §6.6, §6.7 or §6.8 edits that section in the same commit;
  - every new sentence goes into the new §6.9, "Copy added in hardening" (Task 1 creates it), in the same commit as the code; `packages/web/src/spec-copy.test.ts` checks §6.6–§6.9.
- **Spec amendments** are marked "(amended 2026-11-23, hardening)", in the section they change, in the task that changes the behaviour (Task 20 sweeps what is left).

## Review Focus

1. **Kage restarts while a phone has the board open** (an update, a reboot, `kage restart`). Sessions don't survive a restart (Task 1), so the open board must land on the login screen once Kage is back, not spin on "Reconnecting" or show stale state.
   Tests: Task 1 (`it('a new SessionStore (a restart) refuses every old cookie')` and the web `it('a 401 after the stream drops shows the login screen')`), Task 8 (the watchdog reconnects, and the reconnect's 401 goes to login).
2. **A stale `.br` or `.gz` beside a rebuilt `index.html`** (a `--watch` rebuild, a hand-copied `dist/`). Kage must never serve compressed bytes that don't match the body.
   Tests: Task 12 (`it('a sidecar whose body changed is ignored and the file is compressed at start')`).
3. **A config written before this plan with `"token": ""`.** After an update the service refuses to start (Task 3); a reasonable person expects `kage doctor` and `kage status` to say exactly why and what to run, not a silent restart loop.
   Tests: Task 3 (`it('a tokenless config without the opt-out fails doctor\'s token check with "Run kage setup to set one."')`).
4. **`localhost` and `127.0.0.1` on a loopback bind** (`pnpm demo`, setup without Tailscale). The tighter allow-list must still let the address Kage prints, and `localhost`, through.
   Tests: Task 2 (`it('a loopback bind also trusts localhost; a Tailscale bind does not')`), Task 18 (the demo answers at the URL it prints).
5. **`kage-hook.mjs` missing next to `kage.mjs`** (a partial build, an older package). The hooks must still reach Kage.
   Tests: Task 13 (`it('hookArgv names kage-hook.mjs beside kage.mjs, and the bundle when it is missing')`).

---

## File structure

```
packages/server/src/
  auth.ts                       Task 1: SessionStore, Auth, cookie per port; Task 5: limiter
  app.ts                        Tasks 1, 5, 18: Auth, headers, the demo sentence
  events.ts                     Tasks 1, 5, 8, 18: owners, per-peer cap, named heartbeat, demo flag
  terminal/upgrade.ts, server.ts  Tasks 1, 18: sessions, closeOwner, the demo sentence
  terminal/control.ts, bridge.ts  Task 11: timeouts, size restore
  listen.ts, security.ts        Tasks 2, 5: the allow-list, exact Origin
  config.ts, serve.ts           Tasks 3, 5, 11, 18: allowNoToken, server caps, --host
  git/exec.ts, git/branch.ts, preview/files.ts, preview/diff.ts, finish/auto-archive.ts   Tasks 4, 6
  tmux/watcher.ts, tmux/client.ts   Tasks 6, 10
  live-source.ts                Tasks 6, 7, 9, 10
  transcript/tail.ts            Tasks 5, 7, 9
  notify/notifier.ts, ntfy.ts, test-ping.ts   Tasks 11, 17
  control/launcher.ts, hooks/settings.ts      Task 11
  assets.ts                     Tasks 12, 14
  hooks/cli.ts, hooks/hook-main.ts, bundle.ts Task 13
  install/runtime.ts            Tasks 13, 15, 16, 19
  install/checks.ts, status.ts, setup.ts, update.ts, uninstall.ts, restart.ts, systemd.ts, launchd.ts, service-files.ts, config-file.ts   Tasks 3, 5, 11, 16, 17, 19
  release/build.ts              Tasks 5, 12, 13, 15
  main.ts                       Tasks 3, 16, 17, 18
packages/shared/src/types.ts    Tasks 1, 8, 18: snapshot auth and demo, hb
packages/web/
  build.ts, sizes.ts            Tasks 12, 14
  src/sse.ts, store.ts, api.ts, main.tsx, link.ts, notify.ts, lazy.tsx   Tasks 1, 8, 14, 18
  src/components/SessionList.tsx, Archived.tsx, ArchivedList.tsx, TopBar.tsx   Tasks 14, 18
  src/palette/commands.ts, src/spec-copy.test.ts   Task 1
.github/workflows/release.yml   Task 5
scripts/install-fakes/systemctl Task 19
e2e/harness.ts, perf.spec.ts, visual.spec.ts, login.spec.ts   Tasks 1, 3, 13, 15, 18
package.json                    Task 18: pnpm demo
docs/…, README.md               Task 20
site/index.html                 Task 21
```

---

### Task 1: Per-login sessions and a sign-out (security I1, B20, B50)

Today the cookie is `HMAC(token, 'kage-auth-v1')`: the same value on every device, for 30 days, revocable only by changing the token. When Kage is down for a moment, another local user can bind its port, receive the open board's cookie on reconnect, and replay it. This task replaces it with random per-login sessions.

**Decision: sessions live in memory only, so a restart signs every browser out.** The leak in I1 happens exactly while Kage is down, so a session that survives the restart is the one the squatter holds. Signing in again after an update or a reboot is the price, and it's rare. Each session is also bound to the TCP peer address that signed in (a tailnet device keeps its Tailscale IP across networks), so a cookie replayed from another address is refused.

**Files:**
- Modify: `packages/server/src/auth.ts`, `app.ts`, `events.ts`, `terminal/upgrade.ts`, `terminal/server.ts`, `serve.ts`, `packages/shared/src/types.ts`, `packages/web/src/store.ts`, `api.ts`, `palette/commands.ts`, `e2e/login.spec.ts`
- Modify: `docs/specs/2026-11-21-kage-design.md` (§5.10 the token bullets, §5.12 the auth rows, a new §6.9 after §6.8)
- Test: `auth.test.ts`, `app.test.ts`, `events.test.ts`, `terminal/upgrade.test.ts`, `terminal/server.test.ts`, `packages/web/src/palette/commands.test.ts`, `sse.test.ts`, `spec-copy.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // auth.ts
  export const SESSION_IDLE_MS = 7 * 24 * 60 * 60 * 1000;
  export const SESSION_MAX_MS = 30 * 24 * 60 * 60 * 1000;
  export const SESSION_MAX = 64;
  export function authCookieName(port: number): string;          // `kage_auth_${port}`
  export function normalizePeer(address: string): string;        // '::ffff:100.1.2.3' → '100.1.2.3'
  export interface SessionStoreOptions { idleMs?: number; maxAgeMs?: number; max?: number; clock?: () => number }
  export class SessionStore {
    constructor(o?: SessionStoreOptions);                         // clock: performance.now (monotonic)
    create(peer: string): string;                                 // the raw id: 32 random bytes, base64url; only its SHA-256 is kept
    check(id: string, peer: string): string | null;               // the session's key (the hash) when live and from that peer; touches last-seen
    revoke(key: string): void;                                    // fires onRevoke
    onRevoke(fn: (key: string) => void): () => void;
    readonly size: number;
  }
  export interface Auth { token: string; sessions: SessionStore; cookie: string }
  /** '' (open) when no token is set; else the session key, or null. Every cookie of that name is checked. */
  export function sessionOf(auth: Auth, cookieHeader: string | undefined, peer: string): string | null;
  export function setCookieHeader(name: string, id: string, secure: boolean): string;  // HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000[; Secure]
  export function clearCookieHeader(name: string): string;
  export function authGuard(auth: Auth): MiddlewareHandler;      // c.set('session', key) for the routes
  // removed: AUTH_COOKIE, authCookieValue, isAuthorised
  // app.ts
  AppDeps.auth: Auth                                              // replaces AppDeps.token
  export function remoteAddress(env: unknown): string;            // normalised; exported for terminal/server.ts
  // events.ts
  EventHub.prototype.stream(owner?: string | null): ReadableStream<Uint8Array>;
  EventHub.prototype.dropOwner(key: string): void;                // errors every stream that session opened
  // terminal/upgrade.ts, server.ts
  checkUpgrade(req, o: { allowed: Allowed; auth: Auth; peer: string }): UpgradeCheck & { session?: string };
  TerminalServerDeps.auth: Auth                                   // replaces token
  TerminalServer.prototype.closeOwner(key: string): void;         // closes that session's terminals: 4403, reason SIGN_IN
  // shared/types.ts: the snapshot event gains
  auth: boolean                                                   // a token is set (the board offers Sign out)
  // web
  export const tokenSet: Signal<boolean>;                         // store.ts, from the snapshot
  export async function logout(): Promise<void>;                  // api.ts: POST /api/logout, then authRequired = true
  ```
- `serve.ts` builds one `Auth` (`cookie: authCookieName(cfg.port)`), passes it to `createApp` and `TerminalServer`, and wires `auth.sessions.onRevoke((k) => { hub.dropOwner(k); terminals.closeOwner(k); })`. `POST /api/logout` revokes the session its cookie names (if any) and clears the cookie, 204 always. `GET /api/auth` stays 204 or 401.
- The least recently seen session goes when a 65th is created. Expiry is checked on every `check`: idle over `SESSION_IDLE_MS`, or older than `SESSION_MAX_MS`.

- [ ] **Step 1: Write the failing tests.**
  - `auth.test.ts`:
    - `it('a login gets its own id; a second login gets another; both check')`;
    - `it('the cookie is kage_auth_<port>, HttpOnly, SameSite=Strict, Path=/, Max-Age=2592000, Secure only when asked')`;
    - `it('revoke refuses that session only and fires onRevoke once')`;
    - `it('a session idle for 7 days, or 30 days old, is refused')` (injected clock; one ms short of each limit still passes);
    - `it('a cookie from another peer address is refused; ::ffff:100.64.0.1 is 100.64.0.1')`;
    - `it('a new SessionStore (a restart) refuses every old cookie')` (Review Focus 1);
    - `it('a 65th session drops the least recently seen')`;
    - `it('the old HMAC value of the token is no longer accepted')`;
    - `it('with no token, sessionOf is open ("")')`.
  - `app.test.ts`: `it('logout revokes its session: that cookie gets 401, another login\'s still 204')`; `it('a wrong token still answers 401 and counts toward the limiter')`.
  - `events.test.ts`: `it('dropOwner errors the streams that session opened, and no others')`.
  - `terminal/upgrade.test.ts`: `it('the upgrade needs a live session from the same peer')`; `terminal/server.test.ts`: `it('revoking a session closes its terminals with 4403 and "Sign in to Kage"')`.
  - Web: `commands.test.ts` `it('Sign out is listed only when a token is set, and signing out shows the login screen')`; `sse.test.ts` `it('a 401 after the stream drops shows the login screen')` (Review Focus 1).
  - `spec-copy.test.ts`: `describe('spec §6.9 copy (hardening) is in the code or install.sh')`, the same two checks as §6.8's (`quoted68`), with at least one sentence.
- [ ] **Step 2: Run them.** `corepack pnpm vitest run packages/server/src/auth.test.ts packages/server/src/app.test.ts packages/server/src/events.test.ts packages/server/src/terminal packages/web/src/palette packages/web/src/sse.test.ts packages/web/src/spec-copy.test.ts`. Expected: FAIL (no `SessionStore`, no §6.9).
- [ ] **Step 3: Implement** the interfaces above. Create spec §6.9, "Copy added in hardening (amended 2026-11-23, hardening)", with §6.8's opening rule, and add the palette command "Sign out" to it. Rewrite §5.10's token bullets: per-login sessions, kept hashed in memory, bound to the address that signed in, idle 7 days and at most 30, lost at a restart (and why), `kage_auth_<port>`, sign out from the palette, and the advice to use `tailscale serve` for HTTPS. Update `e2e/login.spec.ts` for the cookie name.
- [ ] **Step 4: Run** Step 2's command, then `corepack pnpm lint` and `corepack pnpm typecheck`. Expected: PASS, clean.
- [ ] **Step 5: Commit.** `feat(server): per-login sessions bound to their address, lost at a restart; sign out from the palette (security I1, B20, B50)`

---

### Task 2: The Host and Origin allow-list (security I2)

Today `hostNames` always holds the raw `os.hostname()`, its short form and `cfg.name`, so `owners-macbook.local` or a single label `box`, answered by an attacker over mDNS or LLMNR, passes both guards. The list becomes: the bound IP, the MagicDNS name and its first label, an explicitly configured `host`, and `localhost` on a loopback bind (a browser resolves `localhost` itself, so nobody on the network can answer for it).

**Files:**
- Modify: `packages/server/src/listen.ts`, `serve.ts`, `install/setup.ts` (its `resolveListenAddress` call and expected URL), `notify/notifier.ts` (only if it calls `linkHost`)
- Modify: spec §5.10 (the DNS rebinding bullet; B12's `.local` and single-label rule is gone)
- Test: `listen.test.ts`, `security.test.ts`, `install/setup.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // listen.ts
  export function hostNamesFor(cfg: KageConfig, address: string, dnsName: string | null): string[];
  export function displayHost(cfg: KageConfig, listen: { address: string; dnsName: string | null }): string;  // configured name, else the MagicDNS first label, else the IP ([v6])
  export function linkHost(cfg: KageConfig, listen: { address: string; dnsName: string | null }): string;
  // ListenOptions loses `hostname`; resolveListenAddress returns hostNames from hostNamesFor
  // removed: isSafeName, shortHostname (if nothing else uses it)
  ```
- `cfg.name` stays the host pill's label only. A configured `host` that is a name (even `.local` or one label) is trusted, because the user chose it.

- [ ] **Step 1: Write the failing tests.**
  - `it('trusts the bound IP, the MagicDNS name and its first label, and an explicit host only')`: with `os.hostname()` `Owners-MacBook.local` and `name: 'box'`, neither `owners-macbook.local`, `owners-macbook` nor `box` is in the list;
  - `it('a loopback bind also trusts localhost; a Tailscale bind does not')` (Review Focus 4);
  - `it('a configured host name, even .local, is trusted')`;
  - `it('displayHost prints the MagicDNS first label, else the IP')`;
  - `security.test.ts`: `it('Host: owners-macbook.local:8080 and Origin http://box:8080 are refused (403)')`.
- [ ] **Step 2: Run them.** `corepack pnpm vitest run packages/server/src/listen.test.ts packages/server/src/security.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** `serve.ts` prints `http://${displayHost(cfg, listen)}:${port}`, so the address it prints always passes its own guard. Amend §5.10: the list, why `.local` and single labels are out, and that configuring one means trusting the local network.
- [ ] **Step 4: Run** Step 2's command plus `install/setup.test.ts` and `main.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit.** `fix(server): the Host and Origin allow-list is the bound IP, the MagicDNS names and an explicit host (security I2)`

---

### Task 3: No token, no live mode (security I3)

Today live mode without a token prints one line to a journal nobody reads. It must refuse to start unless the user opts out on purpose.

**Decision:** the opt-out is the config key `"allowNoToken": true` or the serve flag `--allow-no-token`. `kage setup`'s "no" to the token question (or `--no-token`) writes `"token": ""` with `"allowNoToken": true` and says what that means; turning the token on writes `"allowNoToken": false`. The demo needs no token.

**Files:**
- Modify: `packages/server/src/config.ts`, `serve.ts`, `main.ts` (`USAGE`), `install/setup.ts`, `install/checks.ts` (a `token` check), `install/status.ts`, `e2e/harness.ts` (live runs without a token pass `--allow-no-token`)
- Modify: spec §5.10 (the "Without a token" bullet), §5.11 (the key), §6.8 (setup's token line), §6.9
- Test: `config.test.ts`, `main.test.ts` (serve), `install/setup.test.ts`, `install/checks.test.ts`, `install/status.test.ts`

**Interfaces:**
- Produces:
  ```ts
  KageConfig.allowNoToken: boolean                     // default false; must be true or false
  export const NO_TOKEN_REFUSAL: string;               // serve.ts
  CheckId: … | 'token'                                 // checks.ts, in installChecks after 'config'
  ```
- **Copy** (into §6.9):
  - serve refuses: “No access token is set, so anyone who can reach Kage could run commands as you. Run kage setup to set one, or add "allowNoToken": true to <config path>.”;
  - the existing warning stays when allowed: "No token set: anyone on your tailnet can start and approve tasks.";
  - doctor: ✗ "No access token is set, so Kage won't start." with "Run kage setup to set one."; ! "No access token: anyone on your tailnet can start and approve tasks." with the same fix; ✓ "An access token is set.";
  - status: "Access token: on" or "Access token: off";
  - setup, turning it off: "Turned off the access token: anyone on your tailnet can open Kage."; this replaces "Saved the access token…" for that case (U20);
  - usage: "--allow-no-token runs live mode without an access token.".

- [ ] **Step 1: Write the failing tests.**
  - `it('live mode with no token and no opt-out exits 1 with the refusal, before tmux starts')` (the fake tmux exec records no call);
  - `it('allowNoToken: true, or --allow-no-token, starts with the warning')`;
  - `it('the demo needs no token')`;
  - `it('allowNoToken must be true or false')`;
  - setup: `it('no to the token writes token "" and allowNoToken true, and says so')`, `it('turning the token back on writes allowNoToken false')`;
  - doctor: `it('a tokenless config without the opt-out fails doctor\'s token check with "Run kage setup to set one."')` (Review Focus 3), and the warn and ok cases;
  - status: `it('status says Access token: on or off')`.
- [ ] **Step 2: Run them.** `corepack pnpm vitest run packages/server/src/config.test.ts packages/server/src/main.test.ts packages/server/src/install`. Expected: FAIL.
- [ ] **Step 3: Implement.** The refusal comes after the config and before anything starts. Pass `--allow-no-token` in `e2e/harness.ts` wherever it starts live mode without a token.
- [ ] **Step 4: Run** Step 2's command, then `corepack pnpm vitest run packages/web/src/spec-copy.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(server): live mode refuses to start without a token unless allowNoToken says so; doctor and status show it (security I3)`

---

### Task 4: git runs pinned to the record's repository (security M4)

Kage runs git unattended in worktrees Claude can write (the file list, branch counts, the diff, auto-archive). An injected Claude in `acceptEdits` can rewrite the worktree's `.git` file to a gitdir it controls, with a `filter.<x>.clean` command, and Kage's next refresh runs it. Every worktree call now sets `GIT_DIR` and `GIT_WORK_TREE` from the record, after checking that git's own bookkeeping still names this worktree.

**Files:**
- Modify: `packages/server/src/git/exec.ts`, `git/branch.ts`, `preview/files.ts`, `preview/diff.ts`, `preview/tracker.ts`, `finish/auto-archive.ts`, `finish/actions.ts` (delete's recount), `live-source.ts` (`previewTarget` carries the repo), `serve.ts`
- Test: `git/exec.test.ts`, a new `git/pin.int.test.ts`, `preview/files.test.ts`, `git/branch.test.ts`, `preview/diff.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // git/exec.ts
  export interface GitPin { gitDir: string; workTree: string }
  GitExec opts gain `pin?: GitPin`; gitStream's `o` gains `pin?: GitPin`
  export function gitEnv(pin?: GitPin): NodeJS.ProcessEnv;   // still drops GIT_INDEX_FILE and GIT_COMMON_DIR; sets GIT_DIR and GIT_WORK_TREE from the pin
  /** <repo>/.git/worktrees/<basename(worktree)>, only when its `gitdir` file names <worktree>/.git; else null. */
  export function worktreePin(repo: string, worktree: string): Promise<GitPin | null>;
  export const UNPINNED: string;                              // the refusal sentence
  // PreviewTarget gains `repo: string`
  ```
- **Copy** (§6.9): "This worktree's .git file no longer points at its repository, so Kage won't run git there." The file list shows it as its note, the diff answers it with 409, and auto-archive skips the session and logs it once.
- The repository's own calls (launch, `worktree list`, the branch delete) run in the repo with no pin: the repo is the trust root (R67).

- [ ] **Step 1: Write the failing tests.**
  - `it('gitEnv(pin) sets GIT_DIR and GIT_WORK_TREE and still drops GIT_INDEX_FILE and GIT_COMMON_DIR')`;
  - `git/pin.int.test.ts` (runIf git, non-Windows): `it('worktreePin finds the worktree\'s gitdir for a real worktree')`; `it('a .git file rewritten to a gitdir inside the worktree, with a clean filter, runs nothing: the pin is refused')`. Set up a repo and a worktree, point `<worktree>/.git` at `<worktree>/evil` holding `config` with `filter.x.clean = touch <marker>`, add `.gitattributes` `* filter=x`, call `changedFiles` as the tracker does, and assert the marker doesn't exist and the result is `UNPINNED`;
  - `it('changedFiles, branchCounts, branchState and the diff pass the pin to git')` (fake exec recording `opts.pin`).
- [ ] **Step 2: Run them.** `corepack pnpm vitest run packages/server/src/git packages/server/src/preview packages/server/src/finish`. Expected: FAIL.
- [ ] **Step 3: Implement.** The pin is looked up per call, never cached, so a `.git` rewritten between two refreshes is caught at the next one.
- [ ] **Step 4: Run** Step 2's command on Windows and in WSL. Expected: PASS (the integration test runs in WSL).
- [ ] **Step 5: Commit.** `fix(server): git in a worktree runs with GIT_DIR and GIT_WORK_TREE from the record, and not at all when its .git was redirected (security M4)`

---

### Task 5: The cheap security minors (M1, M2, M3, M5, M7, M8)

**Files:**
- Modify: `packages/server/src/transcript/tail.ts` (M1), `auth.ts` (M2), `serve.ts` and `events.ts` (M3), `.github/workflows/release.yml` (M5), `app.ts` and `security.ts` (M7), `install/launchd.ts` (M8)
- Modify: spec §5.10 (the limiter; the connection caps), §6.9
- Test: `transcript/tail.test.ts`, `auth.test.ts`, `events.test.ts`, `app.test.ts`, `security.test.ts`, `install/launchd.test.ts`, `release/build.test.ts`

**Interfaces:**
- **M1, the transcript file:** the tail opens with `O_RDONLY | O_NONBLOCK`, `fstat`s the handle, and reads only a regular file whose name ends in `.jsonl`; anything else is treated as missing. (The containment under `~/.claude/projects/` is parked in the backlog: it needs every e2e fake to write there.)
- **M2, the limiter:** `LoginLimiter.allow(key)` lets an address with no failure in the window through even when the global ceiling is full. §5.10's limiter sentence changes to match.
- **M3, caps:** `server.maxConnections = 256` and `server.headersTimeout = 10_000` after `serve()`; `EventHub` refuses a 17th open stream from one peer: `GET /api/events` answers 429 with "Too many open boards from this address." (§6.9). `EventHub.prototype.stream(owner, peer)` and `EventHub.prototype.streamsFrom(peer): number`.
- **M5:** no `cache:` in the release workflow's jobs (cache poisoning); Task 20 documents the `release` environment's reviewers and the `v*` tag ruleset, which the YAML can't show.
- **M7, headers:** `Cross-Origin-Resource-Policy: same-origin` and `Cross-Origin-Opener-Policy: same-origin` on every answer; `object-src 'none'` and `frame-src 'none'` in the CSP; `Cache-Control: no-store` on every `/api/*` JSON answer; `originOk` compares the Origin exactly (a trailing `/` is refused).
- **M8:** the launchd log file is created `0600` before the bootstrap, and the plist sets `<key>Umask</key><integer>63</integer>`.

- [ ] **Step 1: Write the failing tests.**
  - `it('a FIFO named like a transcript is treated as missing and blocks nothing')` (non-Windows, `mkfifo` through `execFile`); `it('a path not ending in .jsonl is treated as missing')`;
  - `it('the global ceiling no longer blocks an address with no recent failures')` (the review's probe: six addresses fail five times; a seventh with the right token gets 204);
  - `it('a 17th stream from one peer gets 429; another peer still connects')`;
  - `it('every answer carries CORP and COOP same-origin, and the CSP has object-src and frame-src none')`; `it('/api JSON answers are no-store')`; `it('Origin http://127.0.0.1:4385/ with a trailing slash is refused')`;
  - `it('the plist sets Umask 63, and the log file is created 0600')`;
  - `it('the release workflow restores no cache')` (reads the YAML, no `cache:` line).
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the touched test files on Windows and in WSL. Expected: PASS.
- [ ] **Step 5: Commit.** `fix: a transcript is a regular .jsonl opened non-blocking, a fair login ceiling, connection and stream caps, stricter headers, a private launchd log, no release cache (security minors)`

---

### Task 6: A detached control client isn't a dead tmux server (reliability I1)

Today any exit of the watcher's `tmux -C attach` emits `down`. A `tmux attach -d -t kage` at the PC (confirmed on tmux 3.4), `detach-client -a`, or a slow client dropped by tmux ends every session, pings the phone again for every question, and can auto-archive a live session whose branch is merged and clean.

**Files:**
- Modify: `packages/server/src/tmux/watcher.ts`, `finish/auto-archive.ts`, `serve.ts`
- Test: `tmux/watcher.test.ts`, a new `tmux/watcher.int.test.ts`, `live-source.test.ts`, `finish/auto-archive.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // watcher.ts: a new constructor option
  alive?: () => Promise<boolean>;   // default: `tmux has-session -t =<session>` (tmuxArgs, 5 s timeout) succeeds
  // auto-archive.ts: a new dependency
  AutoArchiverDeps.confirm: (id: string) => Promise<boolean>;   // re-checked right before archiving; false skips
  ```
- When the client ends while `alive()` is true, the watcher spawns a new client at once (no backoff) and emits nothing until that client's first line (which emits `up`, a resync). It emits `down` only when `alive()` is false, then backs off as today. Three re-attaches in 10 s without a line in between count as `down`, so a client tmux keeps refusing can't spin.
- `serve.ts` wires `confirm` to a fresh `listWindows` that finds no window tagged with the session's `@kage_id`.

- [ ] **Step 1: Write the failing tests.**
  - `it('a client that exits while has-session succeeds re-attaches at once and emits no down')`;
  - `it('a client that exits with the server gone emits down and backs off')`;
  - `it('three re-attaches in 10 s without a line emit down')`;
  - `live-source.test.ts`: `it('tmux attach -d at the PC keeps needs-you, emits no ended and touches no auto-archive')` (the review's R1, with the fixed watcher's events: only `up`);
  - `auto-archive.test.ts`: `it('a candidate that has a window again at archive time is not archived')`;
  - `watcher.int.test.ts` (runIf tmux and `script`, a private `-L` socket): `it('tmux attach -d leaves the watcher up while has-session succeeds')`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tmux and live-source tests on Windows and in WSL. Expected: PASS; the integration test runs in WSL.
- [ ] **Step 5: Commit.** `fix(server): a detached control client re-attaches without ending sessions; auto-archive re-checks the window first (reliability I1)`

---

### Task 7: A turn that ends without a `Stop` (reliability I2, M1, B26)

Today a lost `Stop` hook (the event loop stalled past the hook's 1.5 s, a refused socket, or B26's swallowed Esc) leaves a hooks-mode session running until the user types, though the transcript says the turn ended. And at every tail start, interrupts already in the file replay, so a resume blinks "done".

**Files:**
- Modify: `packages/server/src/transcript/tail.ts`, `live-source.ts`
- Test: `transcript/tail.test.ts`, `live-source.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // tail.ts
  TranscriptTail.prototype.onTurnEnd(fn: () => void): () => void;  // a record that ends the turn (lines.ts endsTurn)
  // interrupt and turn-end listeners fire only for records read after start()'s first read (M1)
  // TailLike adds 'onTurnEnd'
  // live-source.ts
  const TURN_END_CHECK_MS = 2000;
  ```
- **The check:** in hooks mode, a turn end while the status is running arms one timer. At `TURN_END_CHECK_MS` it captures the pane; no `BUSY_FOOTER` and no prompt means done, through `#setStatus` (so `doneAt`, the done ping and auto-archive follow). Any hook cancels it.
- **B26:** an interrupt ignored as Kage's own Escape (inside `REPLY_INTERRUPT_MS`) arms the same check, so a real Esc swallowed there still ends in done when the pane is idle.

- [ ] **Step 1: Write the failing tests.**
  - `it('a lost Stop: the turn ends in the transcript and the pane is idle, so the session is done 2 s later')` (the review's R2);
  - `it('a hook within those 2 s cancels the check')`; `it('a busy footer at the check keeps it running')`;
  - tail: `it('interrupts and turn ends in the first read don\'t fire; ones appended later do')` (R3);
  - `it('a resume over a transcript ending in an interrupt stays Starting Claude…')` (R3b);
  - `it('an Esc swallowed by the reply window still ends in done when the pane is idle')`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `corepack pnpm vitest run packages/server/src/transcript packages/server/src/live-source.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit.** `fix(server): a turn the transcript ends becomes done without its Stop; old interrupts don't replay (reliability I2, M1, B26)`

---

### Task 8: A stream that knows when it is dead (reliability I3)

The heartbeat is an SSE comment, which `EventSource` never shows to script, and the board reconnects only on `onerror`. A half-open connection (the PC lost power, the phone changed networks) leaves the board "live" with stale statuses forever.

**Files:**
- Modify: `packages/server/src/events.ts`, `packages/shared/src/types.ts`, `packages/web/src/sse.ts`, `store.ts`
- Modify: spec §5.5 (the heartbeat and the watchdog)
- Test: `events.test.ts`, `packages/web/src/sse.test.ts`, `store.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // shared/types.ts
  ServerEvent: … | { type: 'hb' }                      // applyEvent ignores it
  // events.ts: every 30 s, one shared constant frame
  const HEARTBEAT: Uint8Array;                         // encodes 'event: hb\ndata: {"type":"hb"}\n\n'
  // sse.ts
  connect(url?: string, opts?: { retryMs?: number; maxRetryMs?: number; watchdogMs?: number }): () => void;  // watchdogMs default 75_000 (2.5 × 30 s)
  ```
- No event for `watchdogMs` closes the stream and reconnects, which brings a fresh snapshot. Back to `visible` with the last event older than 30 s reconnects at once. The reconnect goes through the existing error path, so a 401 shows the login screen (Review Focus 1). The hub also encodes each event once for all clients (P9).

- [ ] **Step 1: Write the failing tests.**
  - `it('the heartbeat is a named hb event every 30 s')`;
  - web, a fake `EventSource` and fake timers: `it('75 s without an event: reconnecting and a new EventSource')`; `it('hb events keep it live')`; `it('back to visible with the last event over 30 s old reconnects')`; `it('applyEvent ignores hb')`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the touched tests, and `e2e/perf.spec.ts`'s SSE-under-load test in WSL (hb frames aren't `session.updated`, so 43 and 1,290 still hold). Expected: PASS.
- [ ] **Step 5: Commit.** `fix: a named heartbeat and a watchdog, so the board reconnects from a half-open stream (reliability I3)`

---

### Task 9: History doesn't slow the start; done tails stop polling (reliability I4, performance P7)

Every archived record gets a `Live` and a transcript read at start (up to 256 KiB and 200 lines each), so start time and memory grow with history, and hooks wait in `#early` the whole time. And every tail stats its file every 2 s, done sessions included.

**Files:**
- Modify: `packages/server/src/live-source.ts`, `transcript/tail.ts`
- Test: `live-source.test.ts`, `transcript/tail.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // live-source.ts
  const READ_ONCE_CONCURRENCY = 4;
  // tail.ts
  TranscriptTail.prototype.setIdle(idle: boolean): void;  // idle with a working file watcher: no stat poll; otherwise FOLLOW_POLL_MS
  // TailLike adds 'setIdle'
  ```
- Archived records get no `Live` and no read at start: `archivedList()` and `archivedCount()` read the records. Restoring one builds its `Live` and reads its transcript then; archiving one stops and drops its `Live` after `session.removed`.
- `start()` sets `#ready` and replays early hooks **before** the transcript reads of ended records, which then run at most 4 at a time and emit each session's lines as they finish.
- `#setStatus` calls `tail.setIdle(status !== 'running')`. Each tail reads into one reused buffer (`Buffer.allocUnsafe`).

- [ ] **Step 1: Write the failing tests.**
  - `it('50 archived records start no tail; GET /api/archive still lists them')` (the review's R4);
  - `it('restoring an archived record reads its transcript and shows its lines')`;
  - `it('a hook that arrives during start is applied before the transcript reads finish')`;
  - `it('ended records read at most 4 transcripts at a time')`;
  - tail: `it('an idle tail with a working watcher polls nothing; without a watcher it polls every 2 s')`;
  - `it('a done session\'s tail is idle, and running again makes it poll')`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `corepack pnpm vitest run packages/server/src/live-source.test.ts packages/server/src/transcript packages/server/src/finish`. Expected: PASS.
- [ ] **Step 5: Commit.** `perf(server): archived records cost nothing at start, ended ones are read after the board is up, and done tails don't poll (reliability I4, performance P7)`

---

### Task 10: tmux edges in LiveSource (reliability M3, M4, M9, M11)

**Files:**
- Modify: `packages/server/src/live-source.ts`, `tmux/client.ts`
- Test: `live-source.test.ts`, `tmux/client.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // tmux/client.ts
  export class SessionMissing extends Error {}
  TmuxClient.prototype.listWindows(o?: { strict?: boolean; … }): Promise<TmuxWindow[]>;  // strict: "can't find session" throws SessionMissing instead of []
  // live-source.ts
  const ACTIVITY_RELIST_MS = 5000;
  ```
- **M3:** `down` also clears `#unknown`, `#ignoredPanes` and `#unknownTimer`, and bumps a server generation. Set-aside hooks carry their generation, and `claim()` takes only the current one.
- **M4:** LiveSource lists with `strict: true`. `SessionMissing` while the watcher is attached (it saw `up` and no `down` since) keeps every state, and logs once per episode: “kage: the tmux session "<name>" isn't there by that name any more, so Kage keeps the last state.” (§6.9). Resume then still sees the window and refuses ("This session already has a window.").
- **M9:** activity from a running hooks-mode session re-lists at most every `ACTIVITY_RELIST_MS`. A `Stop` or `SessionEnd`, and the shell-ended and activity modes, keep today's immediate re-list.
- **M11:** pending tools are a set of `tool_use_id`s (a `PostToolUse` before its `PreToolUse` leaves none pending); `#ignoredPanes` entries past their expiry are pruned in `#onHook`.

- [ ] **Step 1: Write the failing tests.**
  - `it('a hook from a dead server\'s %1 isn\'t claimed by the new server\'s %1')` (the review's M3 steps 1–4);
  - `it('the session missing while the watcher is attached keeps every state and logs once')`;
  - `it('a running hooks-mode session under constant activity re-lists about once per 5 s')` (activity every 250 ms for 10 s: at most 3 listings);
  - `it('a PostToolUse arriving before its PreToolUse leaves no tool pending')`;
  - `it('expired ignored panes are pruned')`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `corepack pnpm vitest run packages/server/src/live-source.test.ts packages/server/src/tmux`, on Windows and in WSL. Expected: PASS.
- [ ] **Step 5: Commit.** `fix(server): a tmux restart's old hooks stay old, a renamed session keeps its state, fewer re-lists, pending tools by id (reliability M3, M4, M9, M11)`

---

### Task 11: Reliability minors outside LiveSource (M2, M5, M6, M7, M8, M10, M11)

**Files:**
- Modify: `packages/server/src/notify/notifier.ts` (M2), `hooks/settings.ts` and `serve.ts` (M5), `terminal/control.ts` and `terminal/bridge.ts` (M6, M7), `notify/ntfy.ts` (M8), `control/launcher.ts` and `serve.ts` (M10), `install/uninstall.ts` and `install/service-files.ts` (M11)
- Modify: spec §5.9 (retries), §6.9
- Test: `notifier.test.ts`, `hooks/settings.test.ts`, `terminal/control.test.ts`, `terminal/bridge.test.ts`, `ntfy.test.ts`, `control/launcher.test.ts`, `install/uninstall.test.ts`

**Interfaces:**
- **M2:** `NotifierDeps.clock?: () => number` (default `performance.now`) for the hold, the quiet period, `lastPingAt` and the rate window. `Date.now` stays only where a time is shown.
- **M5:** `writeHooksSettings` removes its temp file when the write fails. If serve's write fails and the file there already holds exactly what it would write, serve goes on and logs: "kage: couldn't rewrite the Claude settings file (<reason>), but the one there is current." (§6.9).
- **M6:** `ControlClient` gives `start()` and each `run()` 5 s. A timeout rejects, kills the client and marks it gone (later answers would be mismatched), so `bridge.open` settles and the bridge's count drops.
- **M7:** a new control client first writes `set-option -w -u -t <window> window-size` for every window in `#resized` that has no rw terminal.
- **M8:** a try that timed out after its request was sent is not tried again (the ping may have arrived). §5.9's retry sentence changes to match.
- **M10:** `TaskLauncher` takes `resolveClaude: () => Promise<string | null>` instead of `claudeBin`. It caches a hit, and looks again on a miss or when the cached path no longer exists.
- **M11:** `writeServiceFile` fsyncs the file and its folder before and after the rename. Uninstall ends with "Claude sessions still running will show hook errors until you restart them." (§6.9) when it removed the hooks file.

- [ ] **Step 1: Write the failing tests.**
  - `it('a wall clock stepped back an hour delays no ping')` (the review's R5);
  - `it('a failed settings write leaves no .tmp')`; `it('serve starts when the write fails but the file is current, and logs one line')`;
  - `it('a control client that never answers fails open within 5 s, and the count drops')` (fake timers);
  - `it('a new control client restores the sizes the last one left manual')`;
  - `it('a ping that timed out after sending is not tried again')` (a fake fetch resolving after 6 s: one call);
  - `it('claude installed after Kage started is found at the next launch')`;
  - `it('uninstall says running sessions will show hook errors')`; `it('the service file is fsynced before the rename')` (an injected fs seam).
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the touched tests, on Windows and in WSL. Expected: PASS.
- [ ] **Step 5: Commit.** `fix(server): monotonic ping clock, temp files cleaned, terminal client timeouts and size restore, no duplicate pings, claude found late, fsynced units (reliability minors)`

---

### Task 12: The board is compressed at build time (performance P1)

`loadAssets` spends 537–578 ms at every start on brotli 11 and gzip 9, and leaves about 6 MB of freed encoder memory resident (R100's residue). The build does it once instead.

**Files:**
- Modify: `packages/web/build.ts`, `packages/server/src/assets.ts`, `release/build.ts` (if its board map filters files)
- Modify: spec §7 (replace R100's start-up compression paragraph)
- Test: `packages/web/build.test.ts`, `packages/server/src/assets.test.ts`, `release/build.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // web/build.ts
  export const PRECOMPRESSED = 'precompressed.json';        // { "/<path>": "<sha256 of the body, base64url, 22 chars>" }
  export async function writeCompressed(outDir: string, paths: string[]): Promise<void>;  // <file>.br (quality 11) and <file>.gz (level 9), one at a time
  // assets.ts
  loadAssets(src: BoardFiles | string, encode?: Compress): Promise<Map<string, Asset>>;  // unchanged signature
  ```
- `build()` writes the sidecars for every compressible output (not fonts or images) and the manifest last. `watch()` writes none, so the dev path compresses at start as today.
- `loadAssets` never serves `*.br`, `*.gz` or the manifest as files. It uses a file's sidecars only when the manifest holds its body's hash (Review Focus 2); otherwise it compresses that file at start, one at a time (R100). The ETag stays the raw body's.
- The SEA embeds `dist/` as it is, so the sidecars ride along through `boardMap`.

- [ ] **Step 1: Write the failing tests.**
  - `it('the build writes .br and .gz beside each compressible file, and a manifest of body hashes')` (each sidecar decompresses to its file);
  - `it('loadAssets uses the sidecars and never calls the encoder')`;
  - `it('a sidecar whose body changed is ignored and the file is compressed at start')` (Review Focus 2);
  - `it('sidecars and the manifest are not served')`;
  - `it('the SEA board reads the same sidecars')` (a fake `seaFiles`).
- [ ] **Step 2: Run them.** `corepack pnpm vitest run packages/web/build.test.ts packages/server/src/assets.test.ts packages/server/src/release`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** Step 2's command, then in WSL `corepack pnpm build` and three starts of `node --v8-pool-size=1 packages/server/dist/kage.mjs serve --demo` with `MALLOC_ARENA_MAX=2` on `127.0.0.1`: start to first HTTP 200, and VmRSS after 10 s. Paste both into the report. Expected: PASS; start about 150 ms, idle RSS about 6 MB lower than before.
- [ ] **Step 5: Commit.** `perf: compress the board at build time; Kage starts about half a second sooner and idles about 6 MB lower (performance P1)`

---

### Task 13: A light `kage hook` (performance P2)

The bundle hoists every builtin the server uses (`http`, `http2`, `zlib`, …) to static imports, so each hook from the bundle costs about 73 ms, against 29 ms for a hook-only entry over `node:net`. Claude fires several hooks per tool call.

**Files:**
- Create: `packages/server/src/hooks/hook-main.ts`
- Modify: `hooks/cli.ts`, `bundle.ts`, `install/runtime.ts`, `install/checks.ts` (`hookProgram` reads the new path), `release/build.ts` (`stageNpm`), `e2e/perf.spec.ts`
- Modify: spec §7 (`kage hook`'s wall time becomes a budget), §5.13 (the npm package's files)
- Test: `hooks/cli.test.ts`, `install/runtime.test.ts`, a new `bundle.test.ts`, `release/build.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // hooks/cli.ts
  export const netPost: PostFn;      // "POST /hook HTTP/1.1" with Host, Content-Type, Content-Length and Connection: close over node:net connect(socket); resolves on the status line, then closes; rejects on error or abort
  // runHookCli's default post becomes netPost; HOOK_DEADLINE_MS is unchanged
  // hooks/hook-main.ts: reads `hook <Event>` from argv, runs runHookCli, exits 0, prints nothing
  // bundle.ts
  export const HOOK_BUNDLE: string;  // packages/server/dist/kage-hook.mjs
  export async function bundleHook(outfile?: string): Promise<void>;  // ESM, one file; part of `pnpm build`
  // runtime.ts
  export function hookArgv(m: RunMode, exists?: (p: string) => boolean): string[];
  // bundle: [node, '--no-warnings', <dir of script>/kage-hook.mjs] when it exists, else [node, '--no-warnings', script]; sea and source unchanged
  ```
- `stageNpm` ships `kage-hook.mjs` next to `kage.mjs` (`files` lists it). `kage serve` already rewrites the hooks file from `hookArgv` at every start, so an install moves over at its next start.
- `perf.spec.ts` records "kage hook wall time (bundle, median of 10)" with a limit of **45 ms**.

- [ ] **Step 1: Write the failing tests.**
  - `it('netPost sends one POST /hook with the body and resolves on the status line')` (a real `HookServer` on a temporary socket, non-Windows);
  - `it('netPost rejects on a closed socket well within the deadline')`;
  - `it('kage-hook.mjs is under 8 KB and imports no node:http')` (the metafile's imports);
  - `it('hookArgv names kage-hook.mjs beside kage.mjs, and the bundle when it is missing')` (Review Focus 5);
  - `it('the npm package ships kage-hook.mjs')`;
  - `it('kage-hook.mjs delivers a Stop to a running server')` (spawn it with `hook Stop` and JSON on stdin; the server sees one event).
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the unit tests on Windows and in WSL, then in WSL the perf project's hook test against the bundle. Paste the median. Expected: PASS; about 30 ms.
- [ ] **Step 5: Commit.** `perf: kage hook runs from a 3 KB entry over node:net, about 30 ms from the bundle (performance P2)`

---

### Task 14: A lighter board (performance P3, P6)

Every `session.updated` re-renders every row (0.16 ms at 200 sessions, 3–5 times that on a phone), and the first load carries New task, the archived list, Login and notifications, which most loads never use.

**Files:**
- Create: `packages/web/src/lazy.tsx`, `packages/web/src/link.ts`, `packages/web/src/components/ArchivedList.tsx`
- Modify: `packages/web/src/components/SessionList.tsx`, `Archived.tsx`, `main.tsx`, `notify.ts`, `palette-loader.tsx`, `packages/web/build.ts` (`LAZY`, `HASHED`), `packages/server/src/assets.ts` (`HASHED`), `packages/web/sizes.ts`
- Modify: spec §7 (the new first load and cap)
- Test: `components/board.test.tsx`, `newtask.test.tsx`, `archived.test.tsx`, `login.test.tsx`, `notify.test.ts`, `packages/web/build.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // lazy.tsx: the palette-loader pattern, generalised
  export function lazyChunk<M>(name: string, load: (retry: number) => Promise<M>): { load(): Promise<M>; loaded(): M | null };
  export function NewTaskHost(): JSX.Element;    // "Loading…" until the chunk is in; prefetched on idle after the first snapshot, so N stays instant
  export function LoginHost(): JSX.Element;
  // ArchivedList.tsx: the list; Archived.tsx keeps the "archived N" button and loads the list on open
  // link.ts
  export function installLink(w?: Window): () => void;  // the #s=<id> follow, moved out of notify.ts; stays in the first load
  // notify.ts loads with import() after the first snapshot; palette-loader awaits it for notifyApi
  // SessionList.tsx
  class Row extends Component<{ s: Session; on: boolean; age: string }>  // shouldComponentUpdate: status, statusSince, pinned, external, project, task, on, age
  // build.ts
  LAZY gains newtask, archived, login, notify; HASHED gains their names (and assets.ts's copy)
  ```
- `SIZE_LIMITS.firstLoad` becomes the new measured first load plus 1,024 B, written as a sum with a comment, as today.

- [ ] **Step 1: Write the failing tests.**
  - `it('a session.updated that changes only now renders no Row')` (count `Row` renders through Preact's `options.diffed`);
  - `it('NewTask, the archived list, Login and notify are lazy chunks outside the first load')` (build.test, from the metafile);
  - `it('the first load is under the new cap')`;
  - `it('N after the idle prefetch shows the form at once; before the chunk loads, Loading…')`;
  - `it('a #s= link still selects its session on the first snapshot')`;
  - `it('the login screen loads its chunk and signs in')`; `it('the title count still follows needs-you once notify has loaded')`.
- [ ] **Step 2: Run them.** `corepack pnpm vitest run packages/web`. Expected: FAIL.
- [ ] **Step 3: Implement.** Then measure the first load (`measureSizes`), set the cap, and amend §7.
- [ ] **Step 4: Run** `corepack pnpm vitest run packages/web` and `corepack pnpm build`, then in WSL the visual, board, palette and notify-browser e2e specs. Expected: PASS; the first load about 24 KB.
- [ ] **Step 5: Commit.** `perf(web): memoised rows; New task, the archived list, Login and notify load on demand; the first-load cap comes down (performance P3, P6)`

---

### Task 15: The memory budget measures what Kage controls; the young generation (performance P4, P5)

About 48 MB of the 75 MB idle RSS is the `node` binary's shared text, which moves with the Node version, not with Kage. Kage controls the anonymous part.

**Files:**
- Modify: `e2e/harness.ts`, `e2e/perf.spec.ts`, and only if Step 3 keeps the flag: `packages/server/src/install/runtime.ts`, `release/build.ts`
- Modify: spec §7 (a row for anonymous memory; the flag's measurement, kept or not)
- Test: `install/runtime.test.ts`, `release/build.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // e2e/harness.ts
  serveAnon(): number;   // MB: the Anonymous line of /proc/<pid>/smaps_rollup; Linux only
  // perf.spec.ts records "Idle server anonymous memory (shipped bundle)", limit 32 MB, next to the RSS row
  ```
- **The flag is kept only if it measures safe.** In WSL, three runs each, with and without `--max-semi-space-size=1`: idle RSS and anonymous memory, the SSE-under-load test (43 and 1,290 frames, longest task under 100 ms), and hook to screen. Keep it only if RSS drops by at least 1 MB and those three still pass. If kept: `serviceArgv(bundle)` is `[node, '--v8-pool-size=1', '--max-semi-space-size=1', script, 'serve']` and the SEA's `execArgv` is `['--v8-pool-size=1', '--max-semi-space-size=1']`.

- [ ] **Step 1: Write the failing tests:** `it('serveAnon reads Anonymous from smaps_rollup')` (a fixture file); if the flag is kept, `it('the service runs the bundle with --max-semi-space-size=1')` and `it('the SEA\'s execArgv carries it')`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Measure** as above, in WSL, on the bundle from `corepack pnpm build`, and paste the six runs into the report. Decide by the rule above.
- [ ] **Step 4: Implement** the harness and the budget row (and the flag, if kept). Run the perf project in WSL. Expected: PASS; anonymous memory about 21–23 MB.
- [ ] **Step 5: Commit.** `perf: budget Kage's anonymous memory; the young generation at 1 MB` (or `…; the young generation stays as it was`)

---

### Task 16: `kage restart`, `kage logs`, and advice that fits a checkout (usability U2, U3, U4, U8, U9)

A checkout is the only install that works today, yet `kage update` and `kage uninstall` tell it to use npm, and every doctor run ends with a warning it can't act on. Doctor's one red line points at `kage serve` when setup is the next step. Nothing restarts the service or shows its log.

**Files:**
- Create: `packages/server/src/install/restart.ts`
- Modify: `install/runtime.ts` (`checkoutOf`), `install/update.ts`, `install/uninstall.ts`, `install/checks.ts`, `install/doctor.ts` (the summary), `main.ts` (commands, `USAGE`, `kage ping` with no topic)
- Modify: spec §5.13 (the commands), §6.7 and §6.8 (the sentences replaced below), §6.9
- Test: `install/runtime.test.ts`, a new `install/restart.test.ts`, `install/update.test.ts`, `install/uninstall.test.ts`, `install/checks.test.ts`, `install/doctor.test.ts`, `main.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // runtime.ts
  /** The checkout folder of a bundle or source run (its script under <dir>/packages/server/{dist,src} with <dir>/.git), else null. */
  export function checkoutOf(m: RunMode, exists?: (p: string) => boolean): string | null;
  // restart.ts
  export function restartCommand(args: string[], io: Io, deps: Pick<CheckDeps, 'manager' | 'env' | 'platform' | 'status' | 'uid'> & { waitMs?: number }): Promise<number>;
  export function logsArgv(m: ServiceManager, home: string): [cmd: string, args: string[]];  // journalctl --user -u kage -e -f, or tail -f ~/Library/Logs/kage.log
  export function logsCommand(args: string[], io: Io, deps: { manager: ServiceManager | null; home: string; spawn?: (cmd: string, args: string[]) => Promise<number> }): Promise<number>;
  ```
- **Copy, replaced:**
  - `USAGE`'s hooks-path line: `Start Claude with: claude --settings "$(kage hooks-path)" --permission-mode default` (U2);
  - update, for a checkout (replaces "This Kage runs from a checkout. Update it with git pull and pnpm build."): "This Kage runs from a checkout in <dir>. Update it with: cd <dir> && git pull && pnpm install && pnpm build, then kage restart." The npm sentence stays for a bundle that isn't a checkout;
  - uninstall, for a checkout (instead of the npm line): "The program is this checkout, <dir>. Delete the folder if you no longer need it.";
  - doctor's install-path, for a checkout (instead of "may not stay there"): ✓ "Claude's hooks run this checkout's build (<path>). If you move the checkout, run kage setup again.";
  - doctor's server check (U8): with no config and no service, ! "Kage isn't running." with "Run kage setup."; with a service, ✗ "Kage isn't running." with "Start it with kage restart, or see the service log: <log>"; with a config and no service (`--no-service`), ✗ with "Start it with kage serve." as today;
  - doctor's service check, installed but stopped: "Start it with: kage restart" (replaces "Run kage setup again to start it."); `restartHint`: "Restart it with kage restart, then run kage doctor again.";
  - doctor's summary with no config: "Run kage setup to finish.";
  - `kage ping` with no topic (replaces "No ntfyTopic in <config path>."): "No ntfyTopic yet. Run kage setup to set up phone pings.".
- **Copy, new** (§6.9): "Restarted Kage."; then "Kage is running at <url>" or "Kage didn't answer after the restart. See: <log>"; with no service: "Kage's service isn't installed. Run kage setup, or run kage serve yourself."; "kage restart takes no arguments."; "kage logs takes no arguments."; usage: "Restart Kage's service and check that it answers." and "Follow Kage's log.".

- [ ] **Step 1: Write the failing tests:** each sentence above in its case, table-driven with the fake `Run` and a temporary checkout layout (`<dir>/.git`, `<dir>/packages/server/dist/kage.mjs`). Also `it('restart restarts the service and waits for /status')`, `it('logs runs journalctl with inherited output')` (a fake spawn), and `it('a fresh machine\'s doctor has no ✗ for a Kage that isn\'t set up yet')`.
- [ ] **Step 2: Run them.** `corepack pnpm vitest run packages/server/src/install packages/server/src/main.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**, editing §6.7, §6.8 and §6.9 with the code.
- [ ] **Step 4: Run** Step 2's command and `spec-copy.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(install): kage restart and kage logs; a checkout gets checkout advice; doctor points at setup first (usability U2, U3, U4, U8, U9)`

---

### Task 17: Setup works on loopback, and sets up phone pings (usability U14, U7)

Setup stops when Tailscale is down, even for someone who only wants to try Kage on `127.0.0.1`. Phone pings, the headline feature, need a hand-edited JSON file and a restart nobody explains.

**Files:**
- Create: `packages/server/src/notify/test-ping.ts`
- Modify: `install/setup.ts`, `install/config-file.ts`, `main.ts` (`pingCommand` uses `sendTestPing`)
- Modify: spec §5.13 (setup's steps and flags), §6.9
- Test: `install/setup.test.ts`, `install/config-file.test.ts`, a new `notify/test-ping.test.ts`, `main.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // config-file.ts
  export function generateTopic(): string;   // 'kage-' + 20 base64url characters from crypto.randomBytes (25 in all)
  // notify/test-ping.ts
  export async function sendTestPing(cfg: KageConfig, fetchFn?: typeof fetch): Promise<{ ok: true; host: string } | { ok: false; reason: string }>;
  // setup.ts
  SetupDeps.ping?: typeof sendTestPing       // test seam
  // flags: --ntfy | --no-ntfy
  ```
- **Loopback:** when doctor's only failure is Tailscale and `--host` is `127.0.0.1`, `::1` or `localhost`, setup prints the check as ! and goes on. Interactively, with no `--host`, it asks “Tailscale isn't up, so only this machine can open Kage. Continue on 127.0.0.1?” (default No); yes sets `host` to `127.0.0.1`. With `--yes` and no loopback host it stops as today.
- **ntfy**, asked after the token unless a topic is already set (then it stays and nothing is asked), or `--ntfy`/`--no-ntfy` answers. The default is No, so `--yes` sets up no pings. On yes, setup:
  1. generates the topic;
  2. prints the hint and the topic on its own line;
  3. waits for Enter;
  4. saves the topic with the other settings;
  5. sends the test ping once the service answers;
  6. asks whether it arrived.
- **Copy** (§6.9): "Send pings to your phone through ntfy?"; "Subscribe to this topic in the ntfy app, then press Enter:" (the topic follows on its own line, indented two spaces); "Keep the topic secret: anyone who knows it can read your pings, and each ping carries the task's text."; "Sent a test ping. Did it arrive?"; "Check the topic in the ntfy app, then run kage ping to try again."; "Couldn't send the test ping (<reason>). Run kage ping to try again."; the Tailscale question above.

- [ ] **Step 1: Write the failing tests.**
  - `it('Tailscale down, --host 127.0.0.1: a ! line, and setup goes on')`;
  - `it('Tailscale down, interactive: y to the question writes host 127.0.0.1')`;
  - `it('Tailscale down with --yes and no loopback host stops as before')`;
  - `it('ntfy yes: a 25-character topic is saved, the hint and the topic print, the test ping goes after the service answers, and n prints the kage ping line')`;
  - `it('--yes asks nothing about ntfy and leaves ntfyTopic unset')`;
  - `it('a rerun with a topic keeps it and asks nothing')`;
  - `it('the test ping goes only to the injected sender')` (R85);
  - `it('kage ping uses sendTestPing and prints as before')`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `corepack pnpm vitest run packages/server/src/install packages/server/src/notify packages/server/src/main.test.ts packages/web/src/spec-copy.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(install): setup goes on over loopback without Tailscale, and sets up phone pings with a test (usability U14, U7)`

---

### Task 18: The demo on loopback, and a calm demo (usability U5, U6)

The demo is the first impression, yet it is buried, needs Tailscale for `pnpm dev`, and answers every click with "Demo mode can't …", sometimes with the wrong verb. Nothing says it is a demo.

**Files:**
- Modify: `package.json` (`demo`), `packages/server/src/serve.ts` (`--host`), `main.ts` (`USAGE`), `events.ts` (the snapshot's `demo`), `app.ts`, `terminal/server.ts`, `packages/shared/src/types.ts`, `packages/web/src/store.ts`, `api.ts`, `components/TopBar.tsx`, `styles/board.css`, `e2e/visual.spec.ts`
- Modify: spec §6.5 and §6.6 (the demo sentences), §8 (the visual test hides the badge), §6.9
- Test: `main.test.ts`, `app.test.ts`, `terminal/server.test.ts`, `events.test.ts`, `components/board.test.tsx`, `store.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // serve.ts: --host ADDR overrides the config's host (checked like it)
  // shared/types.ts: the snapshot gains `demo: boolean`; EventHub opts gain `demo?: boolean`
  export const DEMO: string;    // app.ts; terminal/server.ts uses it as its demo close reason
  export const demo: Signal<boolean>;   // web store.ts
  ```
- `package.json`: `"demo": "pnpm build && node packages/server/dist/kage.mjs serve --demo --host 127.0.0.1"`. It prints "Kage is running at http://127.0.0.1:8080", which passes Task 2's list (Review Focus 4).
- **Copy:** DEMO = "This is the demo, so nothing here changes. Install Kage to run your own sessions." It replaces "Demo mode can't start tasks.", "Demo mode can't run tasks.", "Demo mode can't show diffs." and "Demo mode has no terminal.". In the web's `request()`, a 501 shows the server's sentence alone, as a note, with no "Couldn't <verb>." in front (the diff and the terminal the same). The badge is `<span class="k-demo">demo</span>` beside the host pill: a grey outline like the ended chip, no fill.
- `e2e/visual.spec.ts` adds `.k-demo{display:none}` to the app's page only: the target has no badge, and the badge isn't part of the design.

- [ ] **Step 1: Write the failing tests.**
  - `it('serve --demo --host 127.0.0.1 listens on loopback, and the snapshot says demo: true')`;
  - `it('every demo refusal is the one demo sentence')` (each 501 route and the terminal's close);
  - `it('the demo badge shows only in demo mode')`; `it('a 501 shows the sentence alone, without Couldn\'t')`;
  - `it('pnpm demo builds and serves the demo on 127.0.0.1')` (reads `package.json`).
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the unit tests, then in WSL the visual and board e2e specs. Take a browser-page screenshot of `pnpm demo` at 1320×900 (the browser page only) for the report. Expected: PASS.
- [ ] **Step 5: Commit.** `feat: pnpm demo on 127.0.0.1, a demo badge, and one calm demo sentence (usability U5, U6)`

---

### Task 19: Phase 6's parked items (R125)

**Files:**
- Modify: `packages/server/src/install/systemd.ts`, `install/update.ts`, `install/runtime.ts`, `install/checks.ts`, `scripts/install-fakes/systemctl`
- Modify: spec §5.13 (the unit folder, the release pin, the carried environment), §6.8 (the sign-in lines), §6.9
- Test: `install/systemd.test.ts`, `install/update.test.ts`, `install/runtime.test.ts`, `install/checks.test.ts`

**Interfaces:**
- **The unit folder:** `systemdUnitDir(run, home, env)` asks `systemctl --user show -p UnitPath --value` and takes the first space-separated entry that ends in `/systemd/user` and isn't under `/etc/`, `/run/`, `/usr/` or `/lib/`. Otherwise it falls back to `~/.config/systemd/user`, also when the manager doesn't answer.
- **The release pin:** `pinRelease` pins only a first hop to the base's origin whose path ends in `/releases/download/v<semver>/VERSION`. That release's VERSION must then equal the tag without its `v`, or the update fails with the reason `the release's VERSION doesn't match its tag` (§6.8's reasons list). Any other hop is followed for VERSION only, as today.
- **`KAGE_SOCKET`:** `serviceEnv` carries an absolute `KAGE_SOCKET` like `KAGE_TMUX_SOCKET`.
- **Doctor's sign-in:** with `ANTHROPIC_API_KEY` set and a service installed, an existing credentials file gives ✓ "Claude Code is signed in."; the warning stays only without one.
- **The fake systemctl** keeps its units in the manager's folder, `$HOME/.config/systemd/user`, whatever the caller's `XDG_CONFIG_HOME`, and answers `show -p UnitPath --value`.

- [ ] **Step 1: Write the failing tests:** `it('the unit folder is UnitPath\'s user entry')`, `it('no answer falls back to ~/.config/systemd/user')`, `it('a hop to another origin isn\'t pinned')`, `it('a pinned release whose VERSION isn\'t its tag fails')`, `it('serviceEnv carries an absolute KAGE_SOCKET')`, `it('an API key with a credentials file is signed in')`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `corepack pnpm vitest run packages/server/src/install`, on Windows and in WSL. Expected: PASS. (`test:install` runs in the Hardening check.)
- [ ] **Step 5: Commit.** `fix(install): the unit folder from UnitPath, a strict release pin, KAGE_SOCKET carried, the sign-in check folded (R125)`

---

### Task 20: Docs

**Files:**
- `README.md`:
  - **a Quick start right under the banner:** try it with `git clone … && cd kage && corepack enable && pnpm install && pnpm demo` (no tmux, no Tailscale); use it with `pnpm build && node packages/server/dist/kage.mjs setup`; then open the address setup prints and press N. Add a pointer to getting Node 24 (nvm, fnm or NodeSource) in Requirements;
  - **"Phone-friendly" corrected:** "Desktop first. A phone shows the board, and a phone layout is planned.";
  - token login as built in Tasks 1 and 3: sessions per sign-in, sign out from the palette, sign in again after a restart, `allowNoToken`, HTTPS through `tailscale serve`;
  - every "restart Kage" becomes `kage restart`, and logs are `kage logs`;
  - notifications through `kage setup` first, the hand-edited way second; the host allow-list (Task 2), and what a `.local` or single-label `host` means;
  - a tag-pinned installer URL next to the one-liner (M9); "Releasing" moves to `CONTRIBUTING.md`, with the `release` environment's required reviewers and the `v*` tag ruleset (M5).
- `docs/specs/2026-11-21-kage-design.md`, whatever the tasks left, each marked "(amended 2026-11-23, hardening)":
  - §5.5 the heartbeat; §5.8a the watcher's re-attach; §5.9 retries and the monotonic clock;
  - §5.10 sessions, the allow-list, the token refusal, the caps, the headers, git's pin;
  - §5.11 `allowNoToken`; §5.12 the auth rows and 429 for streams; §5.13 restart, logs, setup's new steps and flags, the hook entry, the npm files;
  - §6.9 complete; §7 the as-built numbers (first load and cap, start time, idle RSS and anonymous memory, the hook's wall time); §8 the badge; §9 "Hardening (after phase 6)", pointing at the Hardening check.
- `docs/backlog.md`:
  - mark B20, B21 and B50 done, B26 done (Task 7's check), and B42's live half done (Task 11);
  - widen B51 to the whole board, as its own future phase;
  - add the excluded and parked items: release signing (with B57), the contrast tokens (U10), transcript containment (M1), title-only pings (M6), Tailscale-identity login (I1's longer term), the usability minors not taken (U11–U13, U15–U30), and P8, P10 and P11.
- `docs/plans/README.md`: a "Hardening" row linking this plan, `Built, not merged (branch hardening)`.

- [ ] **Step 1: Update the docs** as listed, in the house style.
- [ ] **Step 2: Run** `corepack pnpm lint` and `corepack pnpm vitest run packages/web/src/spec-copy.test.ts`. Expected: clean, PASS.
- [ ] **Step 3: Commit.** `docs: hardening as built — sessions, the allow-list, the token rule, kage restart and logs, the Quick start, desktop first`

---

### Task 21: The landing page

**Files:** `site/index.html`, `site/style.css` if needed. No new images.

- [ ] **Step 1: Update `site/`:**
  - the status chip `In development · phases 1–6 built, hardening built`;
  - "Try it" leads with `pnpm demo` (no tmux, no Tailscale), and the clone instructions point at `hardening`;
  - a short "Safe by default" list: a token for each sign-in, sign out any time, only your tailnet names are trusted, no live mode without a token unless you say so;
  - a roadmap entry "Hardening (security, reliability, speed, ease of use)" marked `built, not merged yet`;
  - wherever the page implies a phone layout, say desktop first, with a phone layout planned;
  - never claim a release, a download count, a phone layout or a signed release.
- [ ] **Step 2: Check** that the page renders at 1320 px and 390 px wide (a Playwright screenshot of `site/index.html`, the browser page only), with no horizontal scroll and no external requests but the existing ones.
- [ ] **Step 3: Commit.** `site: hardening — pnpm demo first, safe defaults, desktop first`. Publishing (`scripts/publish-site.sh`) is the controller's step (R83).

---

**Hardening check (R126: every finding in scope fixed, every budget held, nothing of the owner's touched):**

1. **Windows:** `corepack pnpm lint`, `corepack pnpm typecheck`, `corepack pnpm test --maxWorkers=4`, `corepack pnpm build`. Rerun a file that times out under load on its own, and report both runs.
2. **WSL:** the unit tests again (the tmux, socket, FIFO and git integration tests run here).
3. **Docker, one at a time:** `corepack pnpm test:linux` all green, with the budgets table pasted into the ledger (first load and its new cap, idle RSS and anonymous memory, `kage hook`'s wall time, SSE frames); then `corepack pnpm test:install` (the fake systemctl's unit folder, the hook entry in the package); then `corepack pnpm test:reboot` (after a `docker restart` the board asks for the token again, and the task shows as ended).
4. **By hand in WSL**, on `127.0.0.1` only, with a temporary `HOME`, a private tmux socket and the fake ntfy on loopback; browser-page screenshots only:
   - **Sessions:** sign in from two browser contexts; Sign out in one; its stream drops and it shows the login screen, while the other stays live. Restart Kage: both show the login screen, and the old cookie gets 401.
   - **The watcher:** with a session waiting on a question, run `script -qc "tmux -L <socket> attach -d -t kage"`. The session stays needs-you, the fake ntfy receives nothing, and nothing is archived.
   - **The demo:** `pnpm demo` shows the badge; New task, an answer, Pin, T and View diff each show the one demo sentence.
   - **Setup:** with the fake `tailscale` reporting Stopped, `kage setup --host 127.0.0.1` goes on, installs nothing for systemd (`--no-service`), and `kage serve` answers at the printed address.
   - **Doctor:** fresh, then set up, then stopped. Its lines match Task 16 (no ✗ before setup; `kage restart` once a service exists).
5. **Not done here:** release signing, the phone layout and the contrast tokens are the owner's decisions (see the header). Tagging, releasing, publishing and pushing `main` wait for the owner's explicit go.
