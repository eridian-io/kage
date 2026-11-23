# Host integration: observed behaviour of git, tmux and the port tools

Recorded on 2026-11-21 for phase 3 (starting and controlling tasks), in WSL Ubuntu 24.04 with **git 2.43.0**, **tmux 3.4**, **iproute2 6.1.0 (`ss`)**, **procps-ng 4.0.4 (`ps`)**, **lsof 4.95.0**, Python 3.12 and Node 24.22. Scratch repos lived under `/tmp`, and tmux ran on a private socket with `-f /dev/null`. git ran with `LC_ALL=C`, `GIT_TERMINAL_PROMPT=0` and `GIT_OPTIONAL_LOCKS=0`. This file holds facts only. The Claude Code side is in `claude-code-integration.md` §7.

Fixtures: `packages/server/test/fixtures/ports/ss.txt` and `ps.txt` keep the observed shapes with invented pids. `ports/lsof.txt` uses the macOS form, which was not observed (see §3).

§4 (tmux control mode and xterm.js) and §5 (git for finishing) were recorded on 2026-11-22 for phase 4, with the same versions plus Node 24.22 in WSL, Node 26.13 and Playwright's Chromium on Windows. Their own "Read first" list is just below.

§7 (the SEA, systemd user units, launchd and Claude's sign-in) was recorded on 2026-11-22 for phase 6, with Node 24.22.3 and systemd 255. Its "Read first" list comes first below.

## Read first: what phase 6 built from §7

The design spec records what phase 6 built from these facts (all amended 2026-11-22, phase 6): the run modes, the release files, the unit, the plist, `install.sh`, setup, update and uninstall in §5.13; the restart loop and the tmux scope in §5.8a; install safety and the outbound calls in §5.10; `GET /status` in §5.12; the new copy in §6.8; the SEA's idle memory and hook time in §7. Two facts were found after the spike, while building (Task 9):

1. **tmux writes every tab of a `-F` format as `_` when no UTF-8 locale is set** (tmux 3.4 and 3.5a: `env -i tmux list-panes -F "#{window_id}<TAB>#{pane_id}"` gave `@0_%0`). A service has no `LANG`, so Kage passes `-u` on every tmux call.
2. **With systemd's default `KillMode=control-group`, stopping or restarting `kage.service` killed the tmux server Kage had started**, and every Claude in it, because tmux lived in the unit's cgroup (real systemd 257, in the reboot container). `systemd-run --user --scope --quiet --collect --unit=kage-tmux-<pid>-<n> tmux …` puts the server in a scope of its own, and it then outlived `restart`, `stop` and `start` with the same pid. It worked there with and without a session bus (systemd 257 falls back to the manager's private socket). systemd 255 (Ubuntu 24.04) wasn't probed.

## Read first: where §7 differs from the phase 6 plan

§7 (SEA, systemd user units, launchd and Claude's sign-in, recorded 2026-11-22) checked the plan's assumptions. Holds: a CommonJS entry, `execArgv` (so `NODE_OPTIONS` isn't needed), a manifest asset, user units restarted rather than ordered after Tailscale, and the credentials file check. The idle SEA is 77.1 to 77.2 MB, under the 80 MB gate. Where the plan must change:

1. **No `node --build-sea` on Node 24.22.3.** The build is `node --experimental-sea-config` plus **`postject` 1.0.0-alpha.6**, a dev dependency (§7.1).
2. **CommonJS is required, not just preferred.** `mainFormat` is silently ignored, and an ESM main fails with `SyntaxError: Cannot use import statement outside a module`. The CommonJS bundle can't hold `main.ts`'s top-level `await`, `import.meta.url` and `import.meta.dirname` must be defined, and the SEA's `require()` loads built-ins only (§7.1).
3. **The SEA config never reports an unknown key**, so Task 2's tests check behaviour: one `V8Worker` thread, an empty stderr (§7.1).
4. **The SEA honours `NODE_OPTIONS` as well as `execArgv`.** `execArgv` wins for the same flag, but any other flag in a user's `NODE_OPTIONS` reaches every `kage`, `kage hook` included (§7.1).
5. **`process.execPath` is the symlink's target**, not the `kage` on `PATH` (`process.argv[1]` is what was typed). A hook command written from `execPath` names the real file (§7.1).
6. **A code cache made on another architecture prints `Warning: Code cache data rejected.` on stderr.** `useCodeCache: true` (hook 39.6 ms against 50.8 ms without, and 77.2 ms for the bundle) needs its blob built on its own runner. Without a code cache, an x64-made blob runs on arm64 (§7.2, §7.3).
7. **Never `strip` an injected SEA**: it segfaults. The SEA is about 128 MB, 43.5 MB gzipped and 29.3 MB with xz -9 (§7.1, §7.2).
8. **A user unit's `PATH` has neither `~/.local/bin` nor `~/.local/node/bin`**, where Node and `claude` live in the owner's WSL, and a login shell doesn't find `claude` either. The unit has to carry a `PATH` (or Kage absolute paths) captured at setup. The same goes for launchd's `/usr/bin:/bin:/usr/sbin:/sbin` (§7.4, §7.5).
9. **`systemctl --user is-active` exits 3 for `activating`, `inactive` and `failed` alike** (4 for a missing unit, 1 with no user manager: `Failed to connect to bus: No medium found`). Status reads the word (§7.4).
10. **`loginctl enable-linger` for oneself needs no root** under the shipped polkit policy (`set-self-linger`: `allow_any yes`), unless a local rule in the unreadable `/etc/polkit-1/rules.d/` overrides it. Not tried (§7.4).
11. **`claude --version` is verified local**: it printed `2.1.330 (Claude Code)` in a network namespace with only `lo`, down (§7.6).

## Read first: what phase 5 built from §6

The ntfy facts in §6 are used by the notifier and the client as the design spec's §5.9 (notifications), §5.10 (the one outbound call) and §5.11 (the ntfy keys) describe them, and the new copy is in §6.7 of the design spec (all amended 2026-11-22, phase 5).

## Read first: where this differs from the phase 4 plan

The design spec records what phase 4 built from these facts: the terminal in §5.6, the git checks in §5.7 and §5.8, the routes in §5.12 and the new copy in §6.6 (all amended 2026-11-22, phase 4).

1. **tmux 3.4 reports a closed window of the client's own session as `%unlinked-window-close @W`, never as `%window-close`.** That happened for `kill-window` from the control client, `kill-window` from another tmux client, and a window whose process exited. Task 11 must treat both notifications as "window closed" (4409). `burst.txt` carries both.
2. **There is no per-pane opt-in.** `refresh-client -f no-output` stops all `%output`, and `refresh-client -A '%N:on'` does not bring one pane back. `-A '%N:off'` works as an opt-out for a known pane, but new panes start on. Use the planned fallback: filter by pane id.
3. **`resize-window -A` sets `window-size` back to `manual`.** It must not be in the restore sequence. `set-option -w -u -t @W window-size` alone restores normal sizing. `refresh-client -S` changes nothing.
4. **With no normal client attached** (Kage's usual detached `kage` session), the restore leaves the window at the terminal's last size. Nothing resizes it until a normal client attaches. Kage's pane parsers therefore read prompts at whatever width the browser last used; the 60- and 160-column fixtures cover that.
5. **F13, the one value to assert:** `show-options -w -q -v -t @W window-size` prints `manual` while a terminal has the window resized, and the empty string after the restore.
6. **F7: `git merge-tree --write-tree` runs a repository's merge driver.** The driver came from a committed `.gitattributes` or from `info/attributes`, with `merge.<name>.driver` in the repo config, and it ran (marker file written). `git --attr-source=<empty tree>` blocks the committed `.gitattributes` but not `info/attributes`. Task 3's merge-tree check needs the controller's ruling. A path comparison that runs no driver agreed with merge-tree in 9 cases, plus 1 n/a (a branch with no commits; §5.5).
7. **F1: xterm.js 6.0.0 has no nonce option, and a nonce wouldn't be enough.** The DOM renderer writes truecolor cells through `setAttribute('style', …)`, and a nonce never covers style attributes. `@xterm/addon-canvas` has no release for xterm 6. The WebGL addon puts the chunk at 123 KB gzipped, over the 100 KB budget, and still needs one `<style>`. A 370-byte CSSOM shim gives zero violations under Kage's CSP as it is now (§4.7).
8. **`ws`: the newest release at least two weeks old (8.22.2, 2026-11-08) has a remote memory-exhaustion DoS, which 8.23.0 (2026-11-12) fixes.** See §4.8.

## Read first: where this differs from the phase 3 plan

1. **`; set-option -w @kage_id <id>` after `new-window -d` tags the wrong window.** In one tmux invocation, the `set-option` targets the session's *current* window, not the new one. In the test that was the placeholder window `@0`, and the new window `@1` stayed untagged. Without `-d` the new window becomes current and does get the tag, but it also takes the focus. Use the planned fallback: `set-option -w -t <window_id> @kage_id <id>` as a second call, with `claim` covering the gap. A `;` sequence would tag (and later let Stop act on) whatever window the user has open.
2. **The first line of a failed `git worktree add` is not the error.** Without `-q`, git first writes `Preparing worktree (new branch 'kage/x')` to stderr, then the `fatal:` line. With `-q` the `Preparing` line goes away and the `fatal:` line comes first. To report `git couldn't create the worktree: <first line>`, pass `-q` or pick the first line starting `fatal:`.
3. **A failed `worktree add -b` can leave the new branch behind.** When the path already exists, git has already created the branch: `kage/q` was still there after `fatal: '<path>' already exists`. Rollback must delete the branch that this request created, even when `worktree add` failed. When the branch already existed (exit 255), nothing was created.
4. **`new-window` exits 0 for a launch that fails.**
   - If argv[0] doesn't exist, `new-window -P` prints a window id and exits 0, and then the window closes at once.
   - If the `-c` directory doesn't exist, tmux silently starts the process in `$HOME`, with exit 0.

   Kage can't treat exit 0 as "Claude started". Check that the directory exists first, and that the window still exists afterwards.
5. **`show-options -w -v -t <id> @kage_id` fails on an unset option.** It exits 1 with `invalid option: @kage_id`. Add `-q`: the command then exits 0 with empty output, which maps to `null`.
6. **In `ss`, Node listeners are named `MainThread`, not `node`.** In `users:(("MainThread",pid=…,fd=21))` the name is the listening thread's name. Python shows `python3`. Take the process label from `ps` args, never from the `ss` name. The plan's comment example `users:(("node",pid=4242,fd=23))` is not what Node 24 produces.
7. **`git rev-parse --git-path info/exclude` gives a relative path in a normal repo.** It prints `.git/info/exclude`, relative to the `-C` directory, even when called from elsewhere. Resolve it against the repo path. When `.git` is a file (a worktree or `--separate-git-dir`), the output is absolute.

## 1. git (2.43.0)

| Question | Answer |
|---|---|
| `git -C <repo> worktree add -b kage/x <repo>/.worktrees/x main` with no `.worktrees/` yet | Works. git creates the missing parent `.worktrees/` and the worktree. Exit 0. stdout: `HEAD is now at <sha> <subject>`. stderr: `Preparing worktree (new branch 'kage/x')`. |
| Branch already exists | Exit **255**. stderr: `Preparing worktree (new branch 'kage/x')`, then `fatal: a branch named 'kage/x' already exists`. With `-q`, only the `fatal:` line. |
| Path already exists (a worktree, or a non-empty folder) | Exit **128**. stderr: `Preparing worktree (new branch 'kage/z')`, then `fatal: '/…/.worktrees/x' already exists`. **The branch `kage/z` has already been created and stays.** |
| Path is an existing empty folder | Accepted (exit 0); git fills it. |
| Base doesn't exist | Exit 128. stderr: only `fatal: invalid reference: nosuchbase`, with no `Preparing` line. No branch is created. |
| `--` before the path (`worktree add -b kage/dd -- <path> main`) | Accepted; it works the same. |
| A branch name starting with `-` (`-b --evil`) | git passes it to `git branch`, which fails with `error: unknown option 'evil'` and a usage dump. Exit 255. (Kage refuses such names first.) |
| `rev-parse --git-path info/exclude`, normal repo | `.git/info/exclude`, **relative** to the `-C` folder. |
| The same from a worktree (`.git` is the file `gitdir: <repo>/.git/worktrees/x`) | `/…/repo/.git/info/exclude`, absolute, and the main repo's file: worktrees share one `info/exclude`. |
| The same with `--separate-git-dir` (`.git` is `gitdir: /…/sep.git`) | `/…/sep.git/info/exclude`, absolute. |
| Does `info/` exist after `git init`? | Yes, from the default template (`info/exclude`). A repo made without templates may lack it, so create the folder before appending. |
| `git status` in the main checkout with a worktree under `.worktrees/` | Lists `?? .worktrees/` (`--porcelain=v1` and `--short`). After appending `/.worktrees/` to the `info/exclude` file, nothing is listed. |
| `git rev-parse --git-common-dir` | `.git` in the main checkout (relative); absolute `/…/repo/.git` from a worktree. |

### `git diff --numstat -z <merge-base>` (default `diff.renames`, which is on)

The worktree's branch has one commit, which renamed `old.txt` to `new-name.txt`, changed `notes.txt` and added a 300-byte random `blob.bin`. On top of that, `keep.txt` has an uncommitted line. Raw output:

```
-\t-\tblob.bin\0
1\t0\tkeep.txt\0
0\t0\t\0old.txt\0new-name.txt\0
2\t1\tnotes.txt\0
```

- A normal record is `<added>\t<deleted>\t<path>\0`.
- A **binary** file has `-` for both counts.
- A **rename** has an empty path field: `<a>\t<d>\t\0<old>\0<new>\0`. That makes three NUL-terminated pieces, and the new path is the last.
- Without `-z`, the rename prints as `old.txt => new-name.txt`, and unusual names are quoted. Always use `-z`.
- With `--no-renames`, the rename becomes a delete (`0\t1\told.txt`) plus an add (`1\t0\tnew-name.txt`).
- The output covers the branch's commits plus uncommitted changes to tracked files (`keep.txt`). Untracked files are not in it.

### `git ls-files --others --exclude-standard -z`

The output is `quote"d.txt\0sub/space name.txt\0uni-é.txt\0untracked.txt\0`. Each path is raw UTF-8, relative to the worktree, sorted, and NUL-terminated. Without `-z`, git C-quotes names: `"quote\"d.txt"`, `"uni-\303\251.txt"`. Ignored files and the `.worktrees/` entry excluded through `info/exclude` don't appear.

## 2. tmux (3.4)

| Question | Answer |
|---|---|
| `new-window -d -P -F '#{window_id} #{pane_id}' -t =kage: -n x -c <dir> -e K=V -- /bin/sleep 60` | Prints `@1 %1`. The pane runs `sleep` directly (`#{pane_current_command}` = `sleep`, `#{pane_current_path}` = `<dir>`), with no shell in between. The new window is not selected (`window_active` 0). |
| Does `-e K=V` reach the process? | Yes: `sh -c 'printenv K'` printed `V`, and `pwd` printed the `-c` folder. Several `-e` flags work. |
| `new-window -d … \; set-option -w @kage_id <uuid>` in one invocation | **Tags the session's current window, not the new one.** The new window's `#{@kage_id}` stayed empty. A second run, after `select-window` on the placeholder, tagged the placeholder again. |
| The same without `-d` | Tags the new window, but the new window becomes current. |
| `\; set-option -w -t '{end}' …` | `no such window: {end}` (it isn't a valid target here). |
| Tagging in a second call: `set-option -w -t @13 @kage_id <uuid>` | Works. On a window that has already closed: `no such window: @11`, exit 1. |
| A 12,000-byte argument (ASCII, and also 3,000 four-byte emoji) | Passes through intact: the child's `printf %s "$1" \| wc -c` printed 12000 for both. |
| A 30,000-byte argument | Refused: `command too long`, exit 1, and no window opens. The limit lies between the two (tmux's message size). Kage's 12,000-byte task plus the rest of the argv fits. |
| `send-keys -t <pane> -l -- <2000 bytes>` (ASCII, emoji, `é`, quotes, `$()`, backslashes) | Arrives intact. It was compared byte for byte through `stty -icanon -echo; head -c` in the pane. A single 5,000-byte `-l` call also arrived complete. Text starting `-x` after `--` is sent literally. |
| Tab in `-F` | A real tab character inside the format string comes out as a tab. Empty fields stay empty (`@1\t\t%1`), so split on `\t` without collapsing. |
| `list-panes -s -t =kage -F '… #{@kage_id} …'` | The window option resolves for every pane of that window, and is the empty string when unset. |
| `#{pane_dead}` | `0` for a live pane. With `remain-on-exit on`, a pane whose process exited shows `pane_dead` `1` and `pane_dead_status` (here `3`). Without `remain-on-exit` (the default), the window closes when the process exits: a window running `/bin/true` was gone 0.5 s later. |
| `show-options -w -v -t <id> @kage_id` | Prints the value when set. When unset: `invalid option: @kage_id`, exit 1. With `-q`: empty output, exit 0. |
| `new-window` with a missing argv[0] | Exit 0. It prints the window id, and then the window closes at once. |
| `new-window` with a missing `-c` folder | Exit 0. The process starts in `$HOME`. |
| `new-window -t =nosuch:` | `can't find session: nosuch`, exit 1. |
| `list-panes -s -t =kage` after `rename-session -t =kage work`, or after `kill-session -t =kage` with another session left (tmux 3.4, WSL, 2026-11-23, hardening Task 10) | `can't find window: kage`, exit 1 (not "can't find session"). Kage's strict listing reads both as the session missing. |
| `display-message -p -t =kage '#{pid}'` with no session `kage` but a live server (same check) | Prints the server's pid, exit 0: it doesn't prove the session is there. `list-sessions -F '#{session_name}\t#{pid}'` lists each session with the server's pid, and with no server says `no server running on …`, exit 1. |

## 3. Ports and processes

Setup: one tmux pane ran a shell, which started five listeners in the background:
- `python3 -m http.server 8765 --bind 127.0.0.1`;
- `node -e "require('http').createServer().listen(8766)"`;
- `python3 -m http.server 8767 --bind ::1`;
- `python3 -m http.server 8768 --bind 0.0.0.0`;
- `node -e "…listen(8769,'::')"`.

| Question | Answer |
|---|---|
| `ss -ltnpH` line shape | `LISTEN 0      5           127.0.0.1:8765 0.0.0.0:* users:(("python3",pid=…,fd=3))`. The columns are State, Recv-Q, Send-Q, Local, Peer and Process. The address is right-aligned and the port left-aligned, so the colons line up, and lines are padded with trailing spaces. Split on runs of whitespace. |
| Local address forms | IPv4 `127.0.0.1:8765`; any IPv4 `0.0.0.0:8768`; IPv6 loopback `[::1]:8767` (peer `[::]:*`). Node's default `listen(port)` and `listen(port,'::')` both show `*:8766` and `*:8769` (peer `*:*`). Interface-scoped addresses also appear, for example `127.0.0.53%lo:53`. |
| `users:` field | `users:(("<name>",pid=<pid>,fd=<fd>))`. The name is the **thread** name: `python3` for Python, but **`MainThread`** for Node. Sockets of other users' processes have no `users:` field at all (`-p` shows only what we may see). |
| `ps -A -o pid=,ppid=,args=` | `%7d %7d <args>`: right-aligned pid and ppid, then the full command line, for example `   4202    4150 python3 -m http.server 8765 --bind 127.0.0.1`. A 444-character command line was not truncated, with or without `-ww`, and without a tty. In this WSL session procps printed `your 131072x1 screen size is bogus. expect trouble` on **stderr**; ignore stderr. `-ww` is accepted on Linux and is the safe form for macOS. |
| Pane process tree | The listeners were direct children of the pane's shell (`pane_pid`). In a Kage window, the pane process is `claude` (see integration §7), and servers started by its Bash tool are further down the tree. `ports/ps.txt` invents that two-level tree (`claude` → `/bin/bash -c …` → servers). The middle level was not observed. |
| `lsof -iTCP -sTCP:LISTEN -nP -F pn` (Linux, lsof 4.95) | Only `p<pid>` and `n<addr>` lines: `n127.0.0.1:8765`, `n*:8766`, `n[::1]:8767`. `0.0.0.0` and `::` **both** show as `*`. There are no `f` lines. |
| lsof on macOS | **Not observed** (no Mac). The lsof man page says that versions 4.88 to 4.93.2 always add the `f` (file descriptor) field to `-F` output, and macOS ships a version from that range. `ports/lsof.txt` therefore has `p`, `f`, `n` triples, built from the observed Linux names. The parser must skip `f` lines (and any other field letter it doesn't use). |

Port fixtures: `ports/ss.txt` (the observed lines, with pids changed to 4202–4206 and one DNS address changed at the same width) and `ports/ps.txt` (a matching tree: `claude` 4100 → bash 4150 → the five listeners, plus unrelated processes, among them a `node` outside the tree).

## 4. tmux control mode for the terminal (tmux 3.4)

Setup: `tmux -L <socket> -f /dev/null -C attach -t =s`, started with Node's `spawn` (no pseudo-terminal, no native module), stdout read as bytes and split on `\n`, commands written to stdin one per line. Fixtures: `packages/server/test/fixtures/terminal/burst.txt` and `capture.txt` (invented content, observed shapes). Fallback B (`script` as a pseudo-terminal) was **not needed**.

### 4.1 Output

| Question | Answer |
|---|---|
| Attach | The client first prints `%begin <time> <n> 0`, `%end <time> <n> 0` (flags `0`: not a client command), then `%session-changed $<id> <name>`. Commands the client writes come back framed with flags `1`. |
| What `%output %<pane> <data>` escapes | Every byte below 0x20 and `\` (0x5c), as `\ooo` (three octal digits): `\015\012`, `\033`, `\134`. Bytes 0x20–0x7e except `\`, **0x7f**, and **0x80–0xff** arrive raw. Checked with all 255 non-NUL byte values `cat` into a raw pane. |
| Can a UTF-8 character split across two `%output` lines? | **Yes.** 160,000 multi-byte characters gave 260 `%output` lines, and 32 of them ended inside a character. The longest line was 2,741 bytes. Forward bytes and never decode one line on its own. xterm.js accepts split UTF-8 across `write(Uint8Array)` calls. |
| `%extended-output` without `pause-after` | Never seen. |
| `refresh-client -f pause-after=2` | All output then comes as `%extended-output %<pane> <age-ms> : <data>` (for example `%extended-output %0 0 : …`). **`%pause` never appeared**, even with the client's stdout unread for 5 s under `yes`. After `refresh-client -A '%0:continue'` no `%continue` was printed either. Kage doesn't need `pause-after`. |
| `refresh-client -f no-output` | Stops all `%output`. `refresh-client -A '%1:on'` (exit 0) does not bring pane `%1` back while the flag is set. `-f '!no-output'` restores output. |
| `refresh-client -A '%N:off'` without `no-output` | Works: that pane's output stops and other panes' output continues. `'%N:on'` turns it back on. It is an opt-out per known pane only; there is no opt-in. |
| `%layout-change` | `%layout-change @<win> <layout> <visible-layout> <flags>`, for example `%layout-change @0 aafd,120x40,0,0,0 aafd,120x40,0,0,0 *` after a resize, and `c196,80x24,0,0[80x12,0,0,0,80x11,0,13,3] … *` after a split. The window flags field can be empty, which leaves a trailing space (`… 0,13,3] `). |
| Closing a window | `%unlinked-window-close @<win>` in every case tried, also for windows of the attached session (see Read first 1). `%window-add @<win>` appears for new windows of the session, `%unlinked-window-add` for windows of other sessions. The `%window-close @5` line in `burst.txt` is **synthetic**: tmux 3.4 sent only `%unlinked-window-close` here, but the documented `%window-close` form stays in the fixture so the parser handles both. |
| `%exit` | `%sessions-changed`, then `%exit`, after `kill-session` of the attached session or `kill-server`. The client process then exits with code 0. |
| Other lines seen | `%window-renamed @<win> <name>` (automatic rename follows the running command), `%session-window-changed $<s> @<win>`, `%sessions-changed`. |
| Two commands on one line (`a ; b`) | Two blocks, `%begin`/`%end` each, with consecutive numbers. |
| A failed command | `%begin …`, the error text (for example `parse error: yacc stack overflow`), then `%error <time> <n> 1`. |

### 4.2 Keys (`send-keys -t %N -H …`)

Checked in a pane that prints every byte it reads, in hex, from a raw-mode terminal.

| Question | Answer |
|---|---|
| Bytes above 0x7f | Arrive raw and unchanged: `c3 a9` (é), `f0 9f 98 80` (a 4-byte emoji). |
| Control bytes | `1b 5b 41` (Up), `03`, `0d`, `7f`, `09`, a lone `1b`, and `00` all arrive as sent, each as one read. |
| Bracketed paste | `1b 5b 32 30 30 7e 61 0a 62 1b 5b 32 30 31 7e` arrives byte for byte, `0a` included. |
| Hex spelling | Upper case (`C3 A9`) and `0xc3` are accepted. An invalid word (`zz`, `100`) sends nothing and prints **no** `%error`. |
| Longest `-H` line | 8,000 bytes (a 24,018-character line) arrived complete. 10,000 bytes failed with `parse error: yacc stack overflow` and `%error`, and nothing was sent. The limit is on the number of words, not the line length. The plan's 256 bytes per line is far below it. |
| Round trip (write `send-keys -H 61` to the echoed `%output`, `cat` pane, 50 keys) | min 0.33 ms, **median 0.56 ms**, p90 0.71 ms, max 0.75 ms. |

### 4.3 A consistent snapshot

One line: `display-message -p -t %N '<format>' ; capture-pane -p -e -N -S -1000 -t %N`.

| Question | Answer |
|---|---|
| Blocks | Two: the `display-message` block (one row), then the capture block. |
| Is the capture count exact? | **Yes:** `min(history_size, 1000) + pane_height` rows in every case (0 + 24 = 24; 51 + 24 = 75; 1,801 history lines → 1,000 + 24 = 1,024). |
| Row bytes | Capture rows are **not** escaped: ESC, raw UTF-8 and `\` appear as they are (`ESC[1mESC[32mgreenESC[0m café back\slash`). `-N` keeps trailing spaces. |
| A pane printing `%end 1700000000 7 1` | The row appears raw inside the capture block (here with one trailing space). A parser that looks for `%end` would end the block early, so frame by count (Task 11's plan holds). `capture.txt` has a row that repeats its own block's `%end` line exactly. |
| `%output` ordering around the capture | 200 snapshots of a pane running `seq -f L%.0f 1 1000000000`: **no `%output` inside either block, no output after the capture's `%end` that repeated a captured line, and no gap**: output after `%end` always continued from the capture's last line. 200 more under `while :; do yes \| head -c 50000000; done`: no framing failure. |
| Format variables in tmux 3.4 | Present: `cursor_x`, `cursor_y`, `cursor_flag`, `alternate_on`, `keypad_cursor_flag`, `keypad_flag`, `mouse_standard_flag`, `mouse_button_flag`, `mouse_any_flag`, `mouse_all_flag`, `mouse_sgr_flag`, `mouse_utf8_flag`, `insert_flag`, `origin_flag`, `wrap_flag`, `scroll_region_upper`/`lower`, `alternate_saved_x`/`y`. **Absent: `focus_flag` and any bracketed-paste flag** (checked against `display-message -a`). An unknown variable expands to the empty string. |
| Flags after `?2004h ?1004h ?1000h ?1002h ?1003h ?1006h ?1h ESC= ?25l ?1049h` | `alternate_on=1`, `keypad_cursor_flag=1`, `keypad_flag=1`, `cursor_flag=0`, `mouse_any_flag=1`, `mouse_sgr_flag=1`, and `mouse_standard_flag`/`mouse_button_flag` `0`: tmux keeps only the last mouse tracking mode (`?1003` → `mouse_all_flag`). |

`capture.txt` uses this format (one proposal for Task 11's `PANE_INFO_FORMAT`; the command goes last because it is free text):
`#{pane_width} #{pane_height} #{history_size} #{cursor_x} #{cursor_y} #{cursor_flag} #{alternate_on} #{keypad_cursor_flag} #{keypad_flag} #{mouse_standard_flag} #{mouse_button_flag} #{mouse_all_flag} #{mouse_sgr_flag} #{pane_current_command}`. Bracketed paste can't be read back, so Task 11 replays `?2004h` for a pane whose command is `claude` (the planned fallback; Claude's start-up modes are in `claude-code-integration.md` §8).

### 4.4 Size

A control client and a normal client (`script -qfc "stty cols 100 rows 30; exec tmux … attach -t s" /dev/null`) on one session.

| Question | Answer |
|---|---|
| Does a control client affect window size without `-C`? | **No.** A session at 80×24 stayed 80×24 with only the control client attached, and became 100×29 (one row for the status line) when the 100×30 client attached. `list-clients` shows the control client as `80x` (no height). |
| `resize-window -t @W -x 120 -y 40` | The window becomes 120×40, and the window option `window-size` becomes **`manual`** (set locally on `@W`). It works on a window that isn't current too. One `%layout-change @W …,120x40,…` follows. |
| What the 100×30 client sees | The top-left 100×29 part of the 120×40 window, and its status line shows the offset `[0,0]`. |
| `set-option -w -u -t @W window-size` alone | Restores normal sizing: the window went back to 100×29 at once, with a `%layout-change`. **This is the restore.** |
| …then `resize-window -A -t @W` | Sets `window-size` back to `manual` (the size stays 100×29). **Don't use it.** |
| …then `refresh-client -S -t <normal client>` | No change. |
| No normal client attached | `set-option -w -u` unsets the option but the window stays 120×40 until a normal client attaches. |
| A normal client attaching while the window is `manual` | Doesn't resize it. After `set-option -w -u`, the window takes that client's size. |
| `refresh-client -C @W:120x40` (control client) | Leaves no window option behind. With **no** normal client, the window becomes 120×40, and `refresh-client -C @W:` (empty size) clears it: the window goes back to `default-size` (80×24). With a 100×30 normal client attached under the default `window-size latest`, it **has no effect** (window stays 100×29); only `largest` lets it win. It is not an alternative to `resize-window`. |

### 4.5 Fallback B

Not needed: control mode worked for output, keys, snapshots and size.

### 4.6 Versions to pin

| Package | Version | Published | Note |
|---|---|---|---|
| `@xterm/xterm` | **6.0.0** | 2025-12-22 | the newest stable |
| `@xterm/addon-fit` | **0.11.0** | 2025-12-22 | peer of xterm 6 |
| `ws` | **8.22.2** by the two-week rule, or **8.23.0** | 2026-11-08 / 2026-11-12 | see §4.8 |

`ws` bundles with esbuild (`platform: node`) without warnings (130,575 bytes). With nothing else installed, `import.meta.resolve('bufferutil')` and `('utf-8-validate')` both throw `ERR_MODULE_NOT_FOUND`; they are optional peer dependencies.

### 4.7 xterm.js under Kage's CSP

Test page served with `app.ts`'s exact `CSP` (`style-src 'self'`, `script-src 'self'`, …), `xterm.css` as a file, Chromium (Playwright 1.64.1, headless, WebGL through SwiftShader). Sizes are esbuild `--minify` ESM bundles, gzip level 9.

| Bundle | Minified | Gzipped |
|---|---|---|
| `new Terminal()` + `FitAddon` | 345,415 B | **87,997 B** |
| the same + `WebglAddon` (0.19.0) | 471,128 B | **123,119 B** |
| `xterm.css` | 7,112 B | 2,509 B (1,903 B minified) |
| the CSSOM shim below | 684 B | **370 B** |

| Option | CSP violations | Result |
|---|---|---|
| DOM renderer, no change | 14 (`style-src-elem` and `style-src-attr`) | Unusable: serif font, dark text on dark, no colours (xterm's own rules never apply). |
| (a) `'unsafe-inline'` | not tried | Ruled out (R55, F1). |
| (b) nonce: `style-src 'self' 'nonce-…'` plus a shim that sets `el.nonce` on every `<style>` xterm creates (xterm 6 has **no nonce option**; its only hook is `documentOverride`, which must be a real `Document`) | 4 (`style-src-attr`) | The three `<style>` elements apply, but **truecolor cells lose their colour**: xterm writes 24-bit foreground and background through `setAttribute('style', 'color: …')` (`_addStyle`). A nonce never covers attributes. 256-colour cells use classes and work. |
| (c) `@xterm/addon-canvas` | n/a | No release for xterm 6 (last 0.7.0, for 5.5). |
| (c) `@xterm/addon-webgl`, loaded before `open()` | 2 | Canvas rendering. xterm's core still creates one `<style>` (scrollbar colours). Loaded after `open()`: 8, because the DOM renderer's styles come first. **Chunk 123 KB + CSS, over the 100 KB budget.** Needs WebGL2, with a DOM fallback on context loss. |
| WebGL + nonce shim, or WebGL + CSSOM shim | 0 | Works, still over budget. |
| **DOM renderer + CSSOM shim** (Kage CSP unchanged) | **0** | Renders correctly, truecolor foreground and background included (screenshots compared). |

The CSSOM shim, installed by the terminal chunk before `new Terminal()`:
- `document.createElement('style')` returns an inert `<template>` whose `textContent` setter calls `replaceSync` on a constructable `CSSStyleSheet` added to `document.adoptedStyleSheets`, and whose `remove()` drops that sheet. (An empty real `<style>` still reports a violation, with the hash of the empty string.)
- `Element.prototype.setAttribute('style', v)` on an `HTMLElement` sets `el.style.cssText = v` instead. CSSOM writes are not checked by CSP.

The full source as tested (spike code; the 370-byte figure is this logic, minified and gzipped):

```js
// Before `new Terminal()`. xterm 6.0.0 creates three <style> elements (one in the core viewport,
// two in the DOM renderer) and writes truecolor cells with setAttribute('style', …).
const origCreate = Document.prototype.createElement;
document.createElement = function (t, o) {
  const isStyle = String(t).toLowerCase() === 'style';
  // An inert <template> instead of a <style>: even an empty <style> reports a violation.
  const el = origCreate.call(this, isStyle ? 'template' : t, o);
  if (isStyle) {
    const sheet = new CSSStyleSheet();
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    let text = '';
    Object.defineProperty(el, 'textContent', {
      get: () => text,
      set: (v) => { text = String(v); sheet.replaceSync(text); },
    });
    const rm = el.remove.bind(el);
    el.remove = () => {
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== sheet);
      rm();
    };
  }
  return el;
};
const origSet = Element.prototype.setAttribute;
Element.prototype.setAttribute = function (n, v) {
  if (n === 'style' && this instanceof HTMLElement) { this.style.cssText = v; return; }
  return origSet.call(this, n, v);
};
```

How the colours were checked. The page wrote 30 plain rows, then one line holding:
- `ESC[38;2;215;119;87mTRUECOLOR` (24-bit foreground);
- `ESC[48;2;40;80;40mTRUEBG` (24-bit background);
- `ESC[38;5;70mCOLOR256`;
- `ESC[1mBOLD`.

After 800 ms the page read the rendered spans:

| Check | With the shim | Without it (nonce variant) |
|---|---|---|
| `getComputedStyle(TRUECOLOR span).color` | `rgb(215, 119, 87)` | `rgb(208, 208, 208)`, the theme default |
| TRUECOLOR span's `style` | `color: rgb(215, 119, 87); letter-spacing: …` | `letter-spacing: …` only |
| `getComputedStyle(TRUEBG span).backgroundColor` | `rgb(40, 80, 40)` | `rgba(0, 0, 0, 0)` |
| COLOR256 span's class | `xterm-fg-70` | the same |
| Row heights | one value (18.0 px) | the same |
| `securitypolicyviolation` events | 0 | 4 (`style-src-attr`) |

Screenshots of the 800×300 terminal area were also compared by eye. With the shim, the monospace font, the theme colours and the orange/green truecolor text showed. The unshimmed DOM renderer showed a serif font with dark text on the dark background.

Measured total for the terminal chunk: about 88.0 + 0.4 KB JS and 1.9 KB CSS gzipped, about 90.3 KB, inside the 100 KB budget. Other facts: no `script-src` violation in any run (xterm needs no `eval`). `term.modes.bracketedPasteMode` turned true after `?2004h`, so xterm wraps pastes itself once the snapshot replays the mode.

**F9, Shift+Esc in Chrome: not observed.** Playwright's `keyboard.press('Shift+Escape')` reached the page as `keydown` `Shift` then `Escape` with `shiftKey`, and no other page opened. Playwright injects keys into the page through the DevTools protocol, past Chrome's own shortcut handling, so this says nothing about whether Chrome's Task Manager (Shift+Esc on Windows and Linux) takes the key first. Only a real key press in a desktop Chrome window can settle it.

### 4.8 `ws` 8.23.0

8.23.0 (released 2026-11-12, with backports 7.5.14, 6.2.7 and 5.2.8) fixes "a remote memory exhaustion DoS": a peer floods Ping frames while it stops reading, and the automatic Pongs pile up until the process runs out of memory. It also adds a `maxPendingAutoPongs` option. In older versions the release notes' mitigation is `autoPong: false`, or rate limits with heartbeats. 8.22.2 is the newest release at least two weeks old (14 days on 2026-11-22). Kage's upgrade checks (Host, exact Origin, cookie) run before any frame, so only a page that passes them could try this.

## 5. git for finishing (2.43.0)

Temp repos with `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, `LC_ALL=C`, `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0` and `-c core.fsmonitor=false`, one worktree per branch under `.worktrees/`.

### 5.1 Removing a worktree and its branch

| Case | Exact output | Exit |
|---|---|---|
| `worktree remove` with a modified tracked file | `fatal: '.worktrees/x' contains modified or untracked files, use --force to delete it` | 128 |
| …with only an untracked file | the same message | 128 |
| …with only a staged change | the same message | 128 |
| `worktree remove --force` (modified or untracked) | removes it, no output | 0 |
| a locked worktree, with or without one `--force` | `fatal: cannot remove a locked working tree;` then `use 'remove -f -f' to override or unlock first` | 128 |
| …with `-f -f` | removes it | 0 |
| `branch -D kage/b` (and `-d`) while its worktree exists | `error: cannot delete branch 'kage/b' used by worktree at '<repo>/.worktrees/b'` | 1 |

### 5.2 `worktree list --porcelain` and prune

- A normal entry is `worktree <abs path>`, `HEAD <sha>`, `branch refs/heads/<b>`, then an empty line. The main worktree comes first.
- When the folder is gone, the entry gains a line `prunable gitdir file points to non-existent location`.
- `worktree prune -v` prints `Removing worktrees/gone: gitdir file points to non-existent location` and drops the entry. The branch stays.

### 5.3 Unpushed commits

`git rev-list --count refs/heads/kage/x --not --exclude=kage/x --branches --remotes --tags`:

| State | Count |
|---|---|
| two commits only on `kage/x` | 2 |
| after `git push origin kage/x` to a local bare remote | 0 |
| after deleting that remote branch again (`push --delete`, `fetch --prune`) | 2 |
| the first of the two commits also on branch `other` | 1 |
| the tip tagged | 0 |
| both commits also on branch `other` (`other` = `kage/x`) | 0 |
| both commits on branch `other2`, which has one more commit of its own | 0 |
| after `merge --no-ff kage/x` into `main` | 0 |
| a branch named `-x` | `fatal: ambiguous argument 'refs/heads/-x': unknown revision …` (Kage refuses such names first, `SAFE_REF`) |

### 5.4 Uncommitted entries

`git status --porcelain=v1 -z --untracked-files=normal` with one modified, one staged and one untracked file, an untracked folder of two files, an ignored file and a new `.gitignore`: **5 entries** (`A  staged.txt`, ` M x.txt`, `?? .gitignore`, `?? ud/`, `?? untracked.txt`). The untracked folder counts once and the ignored file doesn't count. A staged rename shows as one entry, `R  renamed.txt\0staged.txt\0`: with `-z` the old path follows as an extra NUL-terminated field, so count records, not NULs.

### 5.5 Merged detection

Branch `kage/x` has two commits from base `B`; `main` moved on with another file unless stated.

"path-equal" means every path the branch changed since `B` is identical in `kage/x` and `main`. The exact commands, as run (bash, with the environment above and `-c core.fsmonitor=false` on every call):

```sh
# B = the branch's base commit (Kage's baseCommit); exit 0 from the second command = merged
mapfile -d '' files < <(git diff --no-ext-diff --no-textconv --no-renames --name-only -z "$B" kage/x)
if [ ${#files[@]} -eq 0 ]; then echo "n/a (no changes)"
else git diff --quiet --no-ext-diff --no-textconv --no-renames kage/x main -- "${files[@]}" && echo yes || echo no
fi
```

- The first command lists the branch's changed paths, NUL-separated. A rename counts as a delete plus an add, because of `--no-renames`.
- The second exits 0 when every listed path has the same content (or is absent) in both trees, and 1 otherwise.
- With no listed paths there is nothing to compare, so the result is "n/a". Kage's "a commit past `baseCommit`" rule decides that case first.

Result: path-equal agreed with `merge-tree` in **9 cases, plus 1 n/a** (no commits).

| Case | `merge-base --is-ancestor kage/x main` | `merge-tree --write-tree refs/heads/main kage/x` = `main^{tree}` | path-equal | `git cherry main kage/x` |
|---|---|---|---|---|
| not merged | no | no | no | `+ +` |
| fast-forward | yes | yes | yes | (empty) |
| `--no-ff` | yes | yes | yes | (empty) |
| squash merge | **no** | yes | yes | `+ +` |
| rebase merge (copies on `main`) | **no** | yes | yes | `- -` |
| squash, then `main` changes another file | no | yes | yes | `+ +` |
| squash, then `main` changes the same file | no | no | no | `+ +` |
| conflicting branch | no | no (exit **1**, conflict listing) | no | `+ +` |
| only the first of two commits merged | no | no | no | `- +` |
| no commits past the base | yes | yes | **n/a** (no paths) | (empty) |

- A branch with no commits is an ancestor, so "a commit past `baseCommit`" must be checked first (as planned).
- `git cherry` finds rebase merges but not squash merges.
- `merge-tree --write-tree` exits 0 when clean and 1 on conflicts. It changed no file under `.git` other than objects: one new loose object per run, and no pack.

### 5.6 F7: merge drivers

Setup: `merge.evil.driver` set in the repo config to a command that writes a marker file; `main` and `kage/x` both change `f.txt` on different lines, so a content merge runs.

| Attributes | Extra | Driver ran? |
|---|---|---|
| committed `.gitattributes` `* merge=evil` | none | **yes** |
| `.git/info/attributes` `* merge=evil` | none | **yes** |
| committed `.gitattributes` | `git --attr-source=4b825dc…` (empty tree) | no |
| `info/attributes` | `--attr-source=<empty tree>` | **yes** |
| none | none | no |
| (comparison) `git merge kage/x` | none | yes |

The table above configured only the merge driver. A separate check used one hostile repo with all three:
- `.gitattributes`: `* merge=evil diff=evil`;
- `merge.evil.driver`, `diff.evil.textconv` and `diff.evil.command`, each writing its own marker file.

`main` and `kage/x` changed `f.txt` on different lines.

| Command | Markers written |
|---|---|
| path-equal (§5.5, with `--no-ext-diff --no-textconv --no-renames`), exit 1 | none |
| `git cherry main kage/x` | none |
| control: `git diff kage/x main` (no flags) | `ext-diff` |
| control: `git diff --no-ext-diff kage/x main` (textconv allowed) | `textconv` |
| control: `git diff --quiet kage/x main` (no flags), exit 1 | none (`--quiet` compares object ids) |
| control: `git merge-tree --write-tree refs/heads/main kage/x` | `merge-driver` |

So the configured programs are live in that repo, and the path comparison and `git cherry` still run none of them. The driver command itself must come from git config (the repo's `.git/config` or the user's), not from a cloned tree: a cloned `.gitattributes` alone names a driver but can't define one.

### 5.7 What changes in the git common directory, and `fs.watch`

Top-level entries of `git rev-parse --git-common-dir` compared before and after each operation (in the main checkout unless stated), and `fs.watch(<dir>)` (not recursive) during it:

| Operation | Top-level entries changed | `fs.watch` names on WSL ext4 (`/tmp`) |
|---|---|---|
| `git fetch` (new remote commit) | `+FETCH_HEAD`, `objects/` | `FETCH_HEAD` |
| `git pull --ff-only` | `FETCH_HEAD`, `+ORIG_HEAD`, `objects/` | `FETCH_HEAD`, `ORIG_HEAD.lock`, `ORIG_HEAD` |
| `git merge --no-ff kage/x` | `index`, `objects/` | `ORIG_HEAD.lock`, `index.lock`, `index`, `AUTO_MERGE`, `MERGE_HEAD`, `MERGE_MODE`, `MERGE_MSG`, `HEAD.lock` |
| `git merge --squash kage/y` + commit | `COMMIT_EDITMSG`, `ORIG_HEAD`, `index`, `objects/` | `ORIG_HEAD.lock`, `ORIG_HEAD`, `index.lock`, `index`, `AUTO_MERGE`, `SQUASH_MSG`, `COMMIT_EDITMSG`, `HEAD.lock` |
| `git rebase main` inside worktree `z` | `objects/` | `packed-refs.lock` |
| a commit inside a worktree | `objects/` | none |
| `git push origin kage/z` | none | none |
| `git status` (`GIT_OPTIONAL_LOCKS=0`), `git merge-tree --write-tree` | none | none |

- Branch refs live under `refs/heads/…` and per-worktree state under `worktrees/<name>/`, so they change no top-level entry.
- On **`/mnt/c`** (the same script, the repo on the Windows drive) `fs.watch` fired **no events at all** for any operation, although the same entries changed. Use the planned fallback there: rely on the other triggers, and the docs say so.
- Kage's own reads (`status` with `GIT_OPTIONAL_LOCKS=0`, `rev-list`, `merge-tree`) change no top-level entry, so they can't set off the watch.

## 6. ntfy (recorded 2026-11-22 for phase 5, from ntfy's documentation; no calls)

Facts for `NtfyClient` (`packages/server/src/notify/ntfy.ts`), taken from ntfy's own documentation (the publishing, configuration and access-control pages, and the public server's pricing page). **No request was made to ntfy.sh or any other ntfy server** (ruling R85): every test runs against `e2e/fake-ntfy.ts` on `127.0.0.1`, and a vitest setup file (`packages/server/test/setup-fetch.ts`) rejects any non-loopback `fetch` with `Tests may not call <host>`. The real-phone check is the owner's optional step.

### 6.1 JSON publish

- `POST <server>/` (the server's root, or its base path behind a proxy) with a JSON object as the body. `Content-Type: application/json` is what Kage sends; ntfy detects a JSON publish from the root path and the body.
- Fields: `topic` (required, string), `message`, `title`, `priority` (integer 1–5; 3 is the default, 4 is "high"), `tags` (array), `click` (a URL opened when the notification is tapped), and others Kage does not use (`actions`, `attach`, `filename`, `icon`, `markdown`, `delay`, `email`, `call`).
- Kage sends exactly `topic`, `title`, `message`, `priority` and, when there is one, `click`. Putting the topic in the body rather than in the URL path (`POST /<topic>`) keeps it out of URLs, so neither a proxy log nor a fetch error (undici puts the URL in its error message) can carry it.
- Authentication: `Authorization: Bearer <access token>` (ntfy's tokens start with `tk_`); Basic auth also exists and Kage doesn't use it.
- A successful publish answers 200 with the stored message as JSON. Kage discards the body unread.
- Topic names are 1–64 characters of letters, digits, `_` and `-`.
- **Sequence ID** (recorded 2026-11-23 for hardening, R139, from https://docs.ntfy.sh/publish/ "Updating + deleting notifications" and https://docs.ntfy.sh/releases/; read on the web, no call to an ntfy server). A publish may carry a sequence id: the header `X-Sequence-ID` (aliases `Sequence-ID`, `SID`), the path `POST /<topic>/<sequence_id>`, the `sequence-id` query parameter, or the JSON field `sequence_id`. A later publish with the same id updates the notification: "Clients will replace the previous notification with the new one." Both messages stay in the server's cache (it is append-only). It arrived in server v2.16.0 (2026-01-19, "Support for updating and deleting notifications") and the Android app v1.22.2 (2026-01-20, which needs server v2.16.0). The documentation's examples use ids such as `xE73Iyuabi` and states no length or character limit; Kage's id is 22 characters of letters, digits, `-` and `_`. The documentation doesn't say in so many words that the header applies to a JSON publish at the root (its JSON form is the `sequence_id` field); Kage sends the header only (R139). An older server, or one that ignores it, treats each try as a new message, so the worst case is the duplicate M8 described.

### 6.2 Size limits

- The server's `message-size-limit` defaults to 4,096 bytes. A larger message is turned into an attachment when attachments are enabled, and refused otherwise.
- A Kage message is at most 100 characters (`NTFY.messageChars`, at most 400 bytes of UTF-8), and a title is cut at the same length, so a ping never comes near the limit.

### 6.3 Rate limits on the public server

- ntfy's per-visitor request limit (by IP address, or by user when signed in) defaults to a burst of 60 requests, then one more every 5 seconds (`visitor-request-limit-burst: 60`, `visitor-request-limit-replenish: 5s`). Over it, ntfy answers **429**.
- ntfy.sh also caps messages a day per visitor or account by plan (its pricing page lists the numbers; they change over time and were not checked here).
- Kage stays far below both: the notifier allows at most 10 pings in any 10 minutes (Task 6), and `NtfyClient` makes at most 4 attempts per ping, honouring a 429's `Retry-After` (seconds) up to 60 s. ntfy's documentation does not promise a `Retry-After` header; without one Kage keeps its own backoff (2 s, 8 s, 30 s).

### 6.4 Who can read a topic

- **On ntfy.sh a topic is public: anyone who knows or guesses its name can subscribe and read every message sent to it**, past messages included while the server keeps them (12 hours by default). The topic name is the only secret unless the topic is reserved with access control (a paid feature on ntfy.sh) or the server is self-run with `auth-default-access: deny-all`.
- Hence the config rule (Task 6): with no token on ntfy.sh, `ntfyTopic` must be at least 16 characters.
- What the ntfy server itself sees for each ping: the topic, the title (`<project> needs you` or `<project> is done`), the task text (stripped and cut to 100 characters), the priority, and the `click` link, which carries the machine's MagicDNS name, Kage's port and the session id. It also sees the sender's IP address, and (amended 2026-11-23, hardening, R139) an `X-Sequence-ID` header: 16 random bytes in base64url, new for each ping and the same for its retries, made from nothing of the session, the topic or the token. It never sees a question, a command, a branch, a path, output or file names.
- **Hand-off to Task 11 (PF5 F15):** the README states the previous bullet in plain words for users of ntfy.sh.

### 6.5 What the client does with each answer

| Answer | Kage |
|---|---|
| 2xx | done, nothing logged |
| 3xx | not followed (`redirect: 'manual'`), so the token never reaches another host; `ntfy: the server refused the ping (HTTP <n>).` |
| 401, 403 | final; `ntfy: the server refused the ping (HTTP <n>). Check ntfyToken.` |
| other 4xx | final; `ntfy: the server refused the ping (HTTP <n>).` |
| 429, 5xx, a network error, no answer within 5 s | retried after 2 s, 8 s, 30 s (a 429's `Retry-After` replaces the wait, at most 60 s); after the 4th attempt `ntfy: couldn't send a ping (<timeout, HTTP <n>, an error code such as ECONNREFUSED, or network error>).` (amended 2026-11-23, hardening; reliability M8, R139): every try of one ping carries the same random `X-Sequence-ID` (§6.1), so a retry after a try that timed out but was delivered replaces that notification on ntfy 2.16.0+ instead of adding a copy. |

- `http:` is used only for a loopback or tailnet server (100.64.0.0/10, `fd7a:115c:a1e0::/48`, a `.ts.net` name); for any other `http:` server the client sends nothing and logs `ntfy: ntfyServer must be https: unless it is on this machine or your tailnet; no ping sent.` The config (Task 6) refuses such a value at start.
- No log line, error or `redact` result contains the topic, the token or the server URL.

## 7. Install: SEA, systemd and launchd (recorded 2026-11-22 for phase 6)

Facts for phase 6's single executable (SEA), the systemd user unit and the launchd agent. §7.1 to §7.4 and §7.6 were observed in WSL Ubuntu 24.04 (x86_64, 12 GB, `nproc` 8) with **Node 24.22.3** (`~/.local/node/bin`), **systemd 255** (255.4-1ubuntu8.18) and Claude Code **2.1.330**, and in throwaway `node:24.22.3-bookworm-slim` containers (amd64, and arm64 under Docker Desktop's emulation). §7.5 (launchd) is from Apple's documentation and the `launchd.plist(5)` and `launchctl(1)` man pages. There is no Mac here, and no page was fetched for this record (no external hosts), so **every line of §7.5 is documented, not observed**.

Spike hygiene (F15): scratch files lived in `/tmp/kage-sea`, a copy of the committed branch built with `node packages/web/build.ts` and `node packages/server/src/bundle.ts`. `postject` was installed only inside the container. Nothing was installed on the host or in WSL. Every `kage` process ran under a temp `HOME`, `XDG_*` and `KAGE_SOCKET`. The throwaway user unit was installed and removed within one script, and linger was never changed. `/tmp/kage-sea` was deleted at the end.

### 7.1 Building a SEA on Node 24.22.3

- **There is no `node --build-sea` on 24.22.3.** `node --help` lists only `--experimental-sea-config=...`. The build is the documented two steps: make the blob with the release Node, then inject it into a copy of that same Node binary with **`postject` 1.0.0-alpha.6** (the version `npm install postject` resolved on 2026-11-22):
  ```
  node --experimental-sea-config sea-config.json
  # Wrote single executable preparation blob to kage.blob
  cp "$(command -v node)" kage
  npx postject kage NODE_SEA_BLOB kage.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
  ```
  On macOS the documented inject adds `--macho-segment-name NODE_SEA` (§7.5).
- **The config accepts unknown keys silently.** `{"noSuchField":1}` made a blob with exit 0 and no warning, so a misspelt key is never reported. The checks below therefore test behaviour (threads, stderr), not the config.
- **The main script must be CommonJS.** `"mainFormat":"module"` with an ESM `probe.mjs` built a blob (exit 0), and the SEA then failed at start:
  ```
  (node:354678) Warning: Failed to load the ES module: probe.mjs. Make sure to set "type": "module" in the nearest package.json file or use the .mjs extension.
  probe.mjs:2
  import { isSea } from 'node:sea';
  ^^^^^^
  SyntaxError: Cannot use import statement outside a module
      at embedderRunCjs (node:internal/main/embedding:63:7)
  ```
  `mainFormat` is ignored on this Node. A CommonJS bundle also can't hold `main.ts`'s top-level `await`, and `import.meta.url` and `import.meta.dirname` are empty in it. The spike bundled a `sea-main.ts` with esbuild `format: 'cjs'`. It holds the same steps as `main.ts`'s `if (import.meta.main)` block, inside an async function, and the build defines `import.meta.url` and `import.meta.dirname` from `process.execPath`. The SEA's `require()` loads built-in modules only: `require('/tmp/…')` throws `ERR_UNKNOWN_BUILTIN_MODULE`. ws's optional `require('bufferutil')` is caught, and with the warning disabled nothing is printed for it.
- **`execArgv` in the config works.** With `"execArgv":["--v8-pool-size=1"]`, `process.execArgv` is `["--v8-pool-size=1"]` and the process has one V8 platform worker. The threads in `/proc/self/task` (names from `comm`):

  | Run | Threads | V8 workers |
  |---|---|---|
  | SEA, no `execArgv` | 7: `MainThread, DelayedTaskSche, V8Worker ×4, SignalInspector` | 4 |
  | SEA, no `execArgv`, `NODE_OPTIONS=--v8-pool-size=1` | 4: `MainThread, DelayedTaskSche, V8Worker, SignalInspector` | 1 |
  | SEA with `execArgv` | 4 (as above) | 1 |
  | SEA with `execArgv`, `NODE_OPTIONS=--v8-pool-size=4` | 4 | 1 (`execArgv` wins) |
  | `node -e …` / `node --v8-pool-size=1 -e …` (reference) | 7 / 4 | 4 / 1 |

  So the SEA also honours `NODE_OPTIONS`: a user's `NODE_OPTIONS` reaches every `kage` the SEA runs, `kage hook` included. An idle `kage serve --demo` SEA has 8 threads: the 4 above plus 4 `libuv-worker`.
- **`disableExperimentalSEAWarning: true` keeps stderr empty.** `kage hook Stop` with empty stdin (as `</dev/null`) and with a hook body: exit 0 and 0 bytes on stderr, for both SEAs in §7.2. Without the key, every start prints `ExperimentalWarning: Single executable application is an experimental feature and might change at any time` on stderr.
- **`process.argv` is `[execPath, argv0 as typed, …args]`, and `process.execPath` is the resolved file.** `./probe-exec a b` gave `["/tmp/kage-sea/out/probe-exec","./probe-exec","a","b"]`. Through a symlink on `PATH`, `kage hook Stop` gave `["/tmp/kage-sea/out/probe-exec","kage","hook","Stop"]` with `execPath` `/tmp/kage-sea/out/probe-exec`: the symlink's target, not the symlink. `argv.slice(2)` holds the arguments, as `main.ts` expects.
- **Assets.** With `"assets":{"board/manifest.json":"manifest.json"}`:
  - `sea.isSea()` is `true`;
  - `sea.getAsset('board/manifest.json', 'utf8')` returns the text (without an encoding, an `ArrayBuffer`);
  - `sea.getRawAsset(key).byteLength` and `sea.getAssetAsBlob(key).size` are 25;
  - **`sea.getAssetKeys()` exists** and returns `["board/manifest.json"]` (`[]` with no assets);
  - a missing key throws `ERR_SINGLE_EXECUTABLE_APPLICATION_ASSET_NOT_FOUND`.
- **The board from disk.** With `import.meta.dirname` defined as `<dirname(execPath)>/../src`, the SEA in `packages/server/dist/` served `packages/web/dist`: `GET /` gave 200 and 1,067 B. SIGTERM printed `Stopping…` and exited 0.
- **Stripping after the inject breaks the binary.** `strip` on an injected SEA printed ``section `.text' can't be allocated in segment 1``, and the result died with a segmentation fault on `--help`. Stripping before the inject was not tried.

### 7.2 Code cache, size, start-up time and idle memory

Two SEAs from the same CommonJS bundle (634,852 B), both with `execArgv` `--v8-pool-size=1`, the warning off and the manifest asset:

| | Blob | SEA | gzip -9 | xz -9 | `kage hook` (median of 10) | `kage --help` (median of 10) |
|---|---|---|---|---|---|---|
| sources, `node --no-warnings src/main.ts` | | | | | 101.0 ms | 95.5 ms |
| bundle, `node --v8-pool-size=1 kage.mjs` (629,213 B; 149,079 B gzipped) | | | | | 77.2 ms | 66.0 ms |
| SEA `useCodeCache: false` | 634,989 B | 127,601,856 B | 43,416,945 B | 29,290,860 B | 50.8 ms (45.6–69.7) | 38.8 ms |
| SEA `useCodeCache: true` | 728,717 B | 127,732,928 B | 43,456,399 B | 29,325,504 B | **39.6 ms** (37.5–43.0) | **31.4 ms** |

- The container's Node binary is 127,012,032 B (with debug info, not stripped). The code cache adds 93,728 B to the blob.
- The timing is spawn to exit, as §7 of the design spec measures it: `kage hook Stop` with a hook body on stdin and `TMUX_PANE` set, posting to a stub server on `KAGE_SOCKET` that answers 204 (all 40 posts arrived), after one warm-up run. The design spec's 96 ms was the sources (101 ms here), not the bundle. `kage --version` doesn't exist yet, so `--help` stands in for it.
- **Idle memory, the 80 MB gate: passed.** The run was the perf spec's idle test: 10 done sessions, no page or stream, 10 s to settle, 30 s measured, from `/proc`. The scratch copy's harness swapped the shipped server for the SEA (`spawn(sea, ['serve', '--port', …])`, `MALLOC_ARENA_MAX=2`, the pool size from `execArgv`). The three runs went one after another in the same session:

  | Server | Idle RSS | Idle CPU (30 s) | Threads |
  |---|---|---|---|
  | SEA `useCodeCache: false` | **77.1 MB** | 0.17% | 8 |
  | SEA `useCodeCache: true` | **77.2 MB** | 0.17% | 8 |
  | bundle, `node --v8-pool-size=1 kage.mjs` | 78.6 MB | 0.17% | 8 |

  `ps` at 35 s showed the expected process each time: `/tmp/kage-sea/repo/packages/server/dist/kage-nocache serve --port 4395`, then `kage-cache`, then `node --v8-pool-size=1 …/kage.mjs`. Each run reported "1 failed" only because the test's `afterEach` asks for a `page` and WSL has no Playwright browser; both budgets were recorded before that. The bundle measured 75.8 to 76.6 MB in phase 5, so this session ran about 2 MB high for all three. The margin to 80 MB is under 3 MB.

### 7.3 linux-arm64

- **A blob made on x64 without a code cache runs in the arm64 Node.** The arm64 `node` came out of `docker create --platform linux/arm64 node:24.22.3-bookworm-slim` (`ELF 64-bit LSB executable, ARM aarch64`). It was injected with postject in the x64 container and run in `docker run --platform linux/arm64` (`uname -m`: `aarch64`). The probe printed its JSON (one V8 worker, the asset found), and `kage-nocache --help` printed the usage with exit 0.
- **A code cache made on x64 is rejected on arm64.** The program still runs, but it prints a warning on stderr, so the hook's stderr would no longer be empty:
  ```
  (node:29) Warning: Code cache data rejected.
  (Use `kage-cache-arm64 --trace-warnings ...` to show where the warning was created)
  ```
  So a SEA with `useCodeCache: true` must have its blob made on its own architecture. The workflow builds natively on each runner, which does that.
- Pulling the arm64 image re-pointed the local `node:24.22.3-bookworm-slim` tag at arm64. `docker pull --platform linux/amd64` put it back (`docker image inspect … {{.Architecture}}`: `amd64`).

### 7.4 systemd user units in WSL

WSL starts systemd from `/etc/wsl.conf` (read only):
```
[boot]
systemd=true
```
PID 1 is `systemd`. The session had `XDG_RUNTIME_DIR=/run/user/1000/` and `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus`. `XDG_CONFIG_HOME` was unset.

- **Unit path:** `${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/kage-spike.service`. `~/.config/systemd/user` didn't exist before, and the spike's empty folders were removed afterwards.
  - `enable` printed `Created symlink /home/evir/.config/systemd/user/default.target.wants/kage-spike.service → /home/evir/.config/systemd/user/kage-spike.service.`
  - `disable` printed `Removed "/home/evir/.config/systemd/user/default.target.wants/kage-spike.service".`
- The unit:
  ```
  [Unit]
  Description=Kage spike (throwaway)
  After=network-online.target
  Wants=network-online.target

  [Service]
  ExecStart=/bin/sh -c 'echo "PATH=$PATH"; exec sleep 600'
  Restart=on-failure
  RestartSec=5

  [Install]
  WantedBy=default.target
  ```
- **Commands and exit codes** (all `systemctl --user`):

  | Command | Output | Exit |
  |---|---|---|
  | `daemon-reload` | | 0 |
  | `enable --now kage-spike.service` | the symlink line | 0 |
  | `is-enabled` | `enabled` | 0 |
  | `is-active`, running | `active` | 0 |
  | `restart` | (MainPID 358792 → 358804) | 0 |
  | `is-active` after `kill -KILL` of the main process (`Restart=on-failure`) | `activating` (SubState `auto-restart`) | 3 |
  | `is-active` after `disable --now` | `inactive` | 3 |
  | `is-active`, the file present but not yet loaded (before `daemon-reload`) | `inactive` | 3 |
  | `is-active`, `ExecStart=/bin/false` with no restart | `failed` | 3 |
  | `is-active`, file removed and `daemon-reload` (missing) | `inactive` | **4** |
  | `reset-failed` on the missing unit | `Failed to reset failed state of unit kage-spike.service: Unit kage-spike.service not loaded.` | 1 |
  | `is-active` or `daemon-reload` under `env -u XDG_RUNTIME_DIR -u DBUS_SESSION_BUS_ADDRESS` (no user manager in reach) | `Failed to connect to bus: No medium found` | 1 |

  Only `active` exits 0. `activating`, `inactive` and `failed` all exit 3, so the word, not the code, tells them apart. A missing unit exits 4.
- **The default `PATH` of a user unit** (from the journal, `journalctl --user -u kage-spike.service -o cat`): `PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games:/snap/bin:/snap/bin`. `systemctl --user show -p Environment` was empty.
  - **Neither `~/.local/node/bin` (where Node and `claude` live in this WSL) nor `~/.local/bin` is on it.**
  - `claude` isn't on a non-interactive login shell's `PATH` either: `bash -lc 'command -v claude'` printed nothing. Only `~/.bashrc` adds `~/.local/node/bin`.
- **`After=network-online.target` means nothing in the user manager.**
  - `systemctl --user status network-online.target`: `Unit network-online.target could not be found.` (exit 4).
  - `list-dependencies` shows it as `○ └─network-online.target`, and `show -p After -p Wants` lists it, but the unit started anyway.
  - `systemctl --user show tailscaled.service -p LoadState` is `LoadState=not-found`: a user unit can't order itself after a system unit. Restarting until Tailscale has an address (R105) is the way.
- **Linger:** `loginctl show-user evir -p Linger --value` printed `no` before and after; it was not changed.
  - In `/usr/share/polkit-1/actions/org.freedesktop.login1.policy`, the action `org.freedesktop.login1.set-self-linger` has `allow_any`, `allow_inactive` and `allow_active` all `yes`. `set-user-linger` (another user) is `auth_admin_keep`.
  - So by the shipped policy, `loginctl enable-linger` for oneself needs no root, unless a local rule says otherwise. `/usr/share/polkit-1/rules.d/` holds `49-ubuntu-admin.rules`, `50-default.rules`, `org.freedesktop.packagekit.rules` and `systemd-networkd.rules`, and `/etc/polkit-1/rules.d/` is not readable (`Permission denied`).
  - Not tried: there is no second throwaway user.
- Before and after: `systemctl --user list-unit-files --no-pager | grep kage` printed nothing (grep exit 1). 71 unit files were listed before.

### 7.5 launchd (documented, not observed)

Every line here is **documented, not observed**. The sources are Apple's "Creating Launch Daemons and Agents", `launchd.plist(5)`, `launchctl(1)` and Node's SEA page for macOS.

- **Path and label:** a per-user agent is `~/Library/LaunchAgents/<label>.plist`. The label is `io.eridian.kage`, so the file is `~/Library/LaunchAgents/io.eridian.kage.plist`, with `Label` equal to the file's name and `ProgramArguments` an array (the executable first). Agents in that folder are loaded into the user's GUI domain at login, so without automatic login the agent starts only once the user logs in.
- **launchctl:**
  - `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/io.eridian.kage.plist` loads it and, with `RunAtLoad`, starts it. Bootstrapping a label that is already loaded fails (commonly `Bootstrap failed: 5: Input/output error`), so a reinstall boots it out first.
  - `launchctl kickstart -k gui/$(id -u)/io.eridian.kage` kills the running instance and starts it again.
  - `launchctl bootout gui/$(id -u)/io.eridian.kage` stops and unloads it. The plist form, `bootout gui/<uid> <plist>`, works too.
  - `launchctl print gui/$(id -u)/io.eridian.kage` describes the service. Its `state = running` line (or `state = not running`, `state = waiting`) is the status. For a label that isn't loaded it fails with `Could not find service "io.eridian.kage" in domain for user gui: <uid>` (exit 113). Apple says `print`'s output is not API and may change, so a check should look for `state = running` and treat anything else as not running.
- **Keys:**
  - `RunAtLoad` `true`: start when loaded (at bootstrap and at login).
  - `KeepAlive` as a dictionary `{SuccessfulExit: false}`: restart only when the job exits non-zero or by a signal. A clean `exit 0` stays stopped.
  - `ThrottleInterval`: the least time between starts, 10 s by default. A job that exits sooner is restarted only after the interval, so a failing start retries about every 10 s.
  - `EnvironmentVariables`: a dictionary of strings. It is the only environment the job gets beyond launchd's own; no shell profile is read.
  - `StandardOutPath` and `StandardErrorPath`: files for stdout and stderr. They are created if missing, but their folder must exist.
  - `Umask` (an integer; added in hardening, security M8): the job's umask. Kage sets 63 (octal 077), so files the job creates are `0600`. Kage also creates the log file `0600` before the bootstrap, since a default home is `0755`.
  - `AbandonProcessGroup` `true` (added in phase 6, R122): when the job stops, launchd kills what is left in its process group unless this key is set. tmux daemonises into a process group of its own anyway, so the key only makes sure the tmux server, and Claude, outlive a stop of Kage.
- **Default `PATH` of an agent:** launchd's standard path, `/usr/bin:/bin:/usr/sbin:/sbin`. Homebrew (`/opt/homebrew/bin`, `/usr/local/bin`), `~/.local/bin` and the Tailscale app's CLI are not on it, so the plist sets `PATH` in `EnvironmentVariables`, or Kage uses absolute paths.
- **Codesigning a SEA:** the Node binary is signed. So `codesign --remove-signature kage` comes before the inject, then `npx postject kage NODE_SEA_BLOB kage.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 --macho-segment-name NODE_SEA`, then `codesign --sign - kage` (an ad-hoc signature). On Apple silicon an arm64 binary without a valid signature is killed at start.
- **Quarantine:** `curl` does not set the `com.apple.quarantine` extended attribute (only apps that opt in, such as browsers, AirDrop and Mail, do), so Gatekeeper doesn't check a binary that `install.sh` fetched with `curl`. A browser download carries it: `xattr -p com.apple.quarantine <file>` shows it, and `xattr -d com.apple.quarantine <file>` removes it.

### 7.6 Claude signed in, locally

- `test -e` only (the file was never read): `~/.claude/.credentials.json` **exists** on Linux with Claude Code 2.1.330 (`stat`: mode 600, owner evir). `~/.config/claude/.credentials.json` does not. `~/.claude.json` also exists (Claude's settings and state, not the credentials).
- **`claude --version` makes no network call: verified.** `strace` is not installed, so it ran in a new user and network namespace, made without root, where only `lo` exists and it is down (`unshare -rn ip -o link`: `1: lo: <LOOPBACK> mtu 65536 qdisc noop state DOWN`):
  ```
  $ timeout 20 unshare -rn /home/evir/.local/node/bin/claude --version
  2.1.330 (Claude Code)
  [exit 0]
  ```
  It took 11 ms. With `HTTPS_PROXY` and `HTTP_PROXY` (both cases) set to `http://127.0.0.1:9`, it also printed `2.1.330 (Claude Code)` with exit 0.
- `claude` here is `~/.local/node/bin/claude` → `~/.local/node/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe`, a native ELF (x86-64).
