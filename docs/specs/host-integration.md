# Host integration: observed behaviour of git, tmux and the port tools

Recorded on 2026-11-21 for phase 3 (starting and controlling tasks), in WSL Ubuntu 24.04 with **git 2.43.0**, **tmux 3.4**, **iproute2 6.1.0 (`ss`)**, **procps-ng 4.0.4 (`ps`)**, **lsof 4.95.0**, Python 3.12 and Node 24.22. Scratch repos lived under `/tmp`, and tmux ran on a private socket with `-f /dev/null`. git ran with `LC_ALL=C`, `GIT_TERMINAL_PROMPT=0` and `GIT_OPTIONAL_LOCKS=0`. This file holds facts only. The Claude Code side is in `claude-code-integration.md` §7.

Fixtures: `packages/server/test/fixtures/ports/ss.txt` and `ps.txt` keep the observed shapes with invented pids. `ports/lsof.txt` uses the macOS form, which was not observed (see §3).

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
