<p align="center">
  <img src="https://raw.githubusercontent.com/eridian-io/kage/main/assets/kage-banner.jpg" alt="Kage: a ninja directing several AI coding agents from the shadows" width="100%">
</p>

<h1 align="center">kage</h1>

<p align="center">
  <b>Your Claude Code agents, working in the shadows.</b><br>
  Run Claude Code sessions on your server or home PC. Start, watch, answer and stop them from your laptop, and get a ping on your phone when one needs you.
</p>

<p align="center">
  <a href="https://github.com/eridian-io/kage/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue" alt="License: AGPL-3.0"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A524.2-brightgreen" alt="Node 24.2 or newer">
  <img src="https://img.shields.io/badge/status-early%20development-orange" alt="Status: early development">
</p>

---

## Quick start

```sh
# Try it: the demo, with no tmux, no Tailscale and no token
git clone https://github.com/eridian-io/kage.git && cd kage && corepack enable && pnpm install && pnpm demo
# Use it with your own sessions (Linux, or WSL on Windows)
pnpm build && node packages/server/dist/kage.mjs setup
```

`pnpm demo` keeps running until you press Ctrl+C, so stop it before the second line. Then open the address setup prints and press `N` to start a task. You need Node 24.2 or newer (see Requirements). No release exists yet, so this checkout is the way in for now.

---

*Kage* (影) is Japanese for "shadow".

You leave your desk, but your agents keep working. Kage is a small web dashboard that runs on your server or home PC and gives you every Claude Code session in one place. It works from the couch, the office or a train. When an agent needs an answer, Kage pings your phone. When it starts a dev server, Kage gives you the preview link.

It is a thin layer over tools you already trust: **tmux** keeps the sessions alive, **git** tracks what changed, and **Tailscale** keeps everything private. Kage adds no database and no open router ports.

## Features

- **Every session at a glance.** Each Claude Code session is a tmux window with a status: 🟢 running, 🟡 waiting for you, ⚪ done.
- **Live output.** Follow the last lines of any session as it works.
- **Start tasks from anywhere.** Type a task and Kage opens a new tmux window in its own git worktree and starts `claude` on it.
- **Answer from the board.** When an agent asks a question, reply in the browser and Kage sends your answer to the session.
- **Preview links.** Kage finds the ports your agents are serving and links you straight to `http://your-pc:PORT`.
- **Files changed.** See what each agent touched, with a diff view.
- **Finish sessions.** Pin, archive, resume and delete sessions. Delete tells you what you would lose first.
- **A terminal in the browser.** Open the real tmux window of a session when the buttons are not enough.
- **Notifications.** A ping on your phone through [ntfy](https://ntfy.sh) when a session needs you, and the count in the browser's tab title.
- **A command palette.** `⌘K` (`Ctrl+K` off a Mac) jumps to a session or runs a command.
- **Attach any time.** Kage only adds to your setup: `tmux attach -t kage` still drops you into the real terminal.
- **Desktop first.** A phone shows the board, and a phone layout is planned.

## How it works

<p align="center">
  <img src="https://raw.githubusercontent.com/eridian-io/kage/main/assets/kage-how-it-works.jpg" alt="The ninja on the couch checks a phone; a private encrypted link runs through a tunnel to the home PC, where the agents are working" width="100%">
</p>

```mermaid
flowchart LR
  L["💻 Laptop / 📱 Phone<br>(browser)"] -- "Tailscale<br>(private, encrypted)" --> K
  subgraph PC["🏠 Server or home PC"]
    K["kage<br>web dashboard"] --> T["tmux session 'kage'"]
    T --> A1["claude: fix login bug"]
    T --> A2["claude: dark mode"]
    T --> A3["claude: update docs"]
    K --> G["git worktrees"]
  end
```

Kage listens on your Tailscale address only, so the dashboard can't be reached from the public internet or your local Wi-Fi. Without Tailscale it can listen on loopback, for this machine only.

## Requirements

- A server or home PC that stays on (Linux or macOS; on Windows, use WSL)
- [tmux](https://github.com/tmux/tmux) 3.2 or newer
- [git](https://git-scm.com) 2.40 or newer
- [Claude Code](https://docs.claude.com/en/docs/claude-code), signed in on the PC
- [Tailscale](https://tailscale.com) on the PC and on every device you connect from. Without it, Kage runs for this machine only.
- [Node.js](https://nodejs.org) 24.2 or newer, only for the npm package or a checkout. A release install brings its own. Ubuntu 24.04's own Node is too old: get Node 24 with [nvm](https://github.com/nvm-sh/nvm), [fnm](https://github.com/Schniz/fnm) or [NodeSource](https://github.com/nodesource/distributions). With a Node installed for your user, `corepack enable` needs no root.

`kage setup` checks each of these and says how to install what's missing. The demo needs only Node.

## Install

**The one-line install works once the first release is out.** No release exists yet. Until then, install from a checkout (below).

```sh
curl -fsSL https://raw.githubusercontent.com/eridian-io/kage/main/install.sh | sh
```

That line fetches `install.sh` from `main`, which can change. Once a release is tagged, you can fetch the script from the release's tag instead, so the script you read is the one that runs:

```sh
curl -fsSL https://raw.githubusercontent.com/eridian-io/kage/<tag>/install.sh | KAGE_RELEASE_BASE=https://github.com/eridian-io/kage/releases/download/<tag> sh
```

Here `<tag>` is the release's tag, `v<version>`. `KAGE_RELEASE_BASE` makes it install that release; without it, the script installs the latest one.

`install.sh` is short and plain POSIX shell, so read it before you run it: open the same URL in your browser, or save it first with `curl -fsSL … -o install.sh`. It:

1. refuses to run as root, and never calls `sudo`;
2. picks the build for your machine: Linux or macOS, x64 or arm64 (a shell under Rosetta gets the arm64 build). On Windows it tells you to use WSL;
3. downloads that build and `SHA256SUMS` from the release, over HTTPS only, and stops unless the checksum matches;
4. puts the program at `~/.local/bin/kage` in one step, replacing an older one;
5. if that folder isn't on your `PATH`, adds an `export PATH=…` line, marked `# Added by the Kage installer.`, to your shell's start-up file: `~/.zshrc` for zsh; `~/.bashrc` and `~/.bash_profile` (or `~/.profile`) for bash; `~/.profile` otherwise. It says what it changed;
6. runs `kage setup` in your terminal, which asks before it changes anything.

To pass setup's options, put them after `sh -s --`, for example `… | sh -s -- --yes --no-linger`. These variables change what the installer does:

| Variable | Effect |
|---|---|
| `KAGE_INSTALL_DIR` | Install into this folder instead of `~/.local/bin` |
| `KAGE_NO_MODIFY_PATH=1` | Print the `PATH` line instead of writing it |
| `KAGE_NO_SETUP=1` | Install only; run `kage setup` yourself later |
| `KAGE_RELEASE_BASE` | Download from this release folder (`https:` only) instead of the latest release |

**With npm**, once the first release is out, if you already use Node 24.2 or newer:

```sh
npm install -g @eridian-io/kage
kage setup
```

**From a checkout**, which works today:

```sh
git clone https://github.com/eridian-io/kage.git
cd kage
corepack enable
pnpm install
pnpm build
node packages/server/dist/kage.mjs setup
```

The service then runs this checkout's build with this Node. To use `kage` by name, add a shell function to your shell's start-up file (adjust the path):

```sh
kage() { node "$HOME/kage/packages/server/dist/kage.mjs" "$@"; }
```

Kage knows when it runs from a checkout. `kage update` prints the commands that update it (`git pull`, `pnpm install`, `pnpm build`, then `kage restart`), and `kage uninstall` removes the service but never the checkout. The service and Claude's hooks name the checkout's path, so if you move it, run `kage setup` again.

On Windows, clone inside WSL's own file system (for example `~/kage`), not under `/mnt/c`.

**Without Tailscale.** Setup can still set Kage up for this machine only. With a terminal it asks "Continue on 127.0.0.1?"; or pass `--host 127.0.0.1`. Kage then opens at `http://127.0.0.1:<port>` on the PC itself. Once Tailscale is up, run `kage setup` again to reach Kage from your other devices.

## Commands

- **`kage setup`** checks what Kage needs, asks for the projects folder, the host name, the port, whether to set an access token and whether to send pings to your phone, saves them in the config, and installs and starts the service. Then it checks that the board answers and prints its address. Run it again any time to change a setting. `--yes` takes every default and asks nothing; `--projects DIR`, `--host NAME`, `--port N`, `--token` or `--no-token`, `--ntfy` or `--no-ntfy`, `--no-service`, and `--linger` or `--no-linger` answer one question each.
- **`kage status`** shows the version, the service, whether an access token is on, the board's address and how many sessions need you.
- **`kage restart`** restarts the service (or starts a stopped one), waits until the new Kage answers, and prints its address.
- **`kage logs`** prints the last 100 lines of the service's log. `kage logs -f` keeps following it.
- **`kage doctor`** checks everything again (the tools, Claude's sign-in, Tailscale, the config and its token, the service, the board, your `PATH`) and says what to fix. It changes nothing.
- **`kage ping`** sends one test ping to your phone (see Notifications).
- **`kage update`** installs the latest release, checked against its SHA-256 like the installer does, and restarts the service if it was running. It runs only when you ask: Kage never checks for updates on its own. The old program stays next to the new one as `kage.previous`, and if the new one doesn't answer, update prints the command that goes back. `--force` installs the release even if it isn't newer. An npm install is updated with npm, and a checkout as above.
- **`kage uninstall`** asks, then removes the service, the program and Kage's hooks file. It keeps your projects, their worktrees and branches, the tmux session (`kage`, or the `tmuxSession` you set) with its windows, and Kage's config and state folders; `--purge` removes those two folders too. It never edits your shell's start-up file: it names the lines the installer added, for you to remove. `--yes` skips the question.

## The service

`kage setup` installs Kage as a service, so it starts on boot and comes back if it stops:

- **Linux:** a systemd user unit, `kage.service`, in the folder systemd's user manager reads units from: `~/.config/systemd/user` (or under the manager's own `XDG_CONFIG_HOME`, if it has one; one set only in your shell doesn't count). `kage logs` shows its log (`journalctl --user -u kage`).
- **macOS:** a launchd agent, `~/Library/LaunchAgents/io.eridian.kage.plist`. Its log is `~/Library/Logs/kage.log`, readable by you only, and `kage logs` shows it. (Documented, not observed: see "On macOS".)

Restart it with `kage restart`, and read its log with `kage logs`.

The unit holds no secrets: just the program and what it adds to the user manager's environment, a `PATH` and two settings, plus these when they are set where you run setup: `KAGE_CLAUDE_BIN`, `CLAUDE_CONFIG_DIR`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, `KAGE_SOCKET` and `KAGE_TMUX_SOCKET`. The token stays in the config. An `ANTHROPIC_API_KEY` set in your shell never goes into the unit, so Claude in Kage's windows needs its own sign-in (run `claude` once); `kage doctor` reminds you.

**Linger.** A user unit normally stops when you log out, and starts only when you log in. With linger on, systemd starts it at boot and keeps it running. Setup asks to turn it on (`--yes` turns it on; `--no-linger` leaves it off) and says so when it does. To turn it off again: `loginctl disable-linger`. `kage uninstall` leaves linger as it is and reminds you if it is on.

**Waiting for Tailscale.** Kage listens on your Tailscale address. Until Tailscale has one, Kage stops and the service starts it again every 5 seconds; `kage status` says "starting (waiting for Tailscale?)" meanwhile.

**Your sessions outlive the service.** Under systemd, Kage starts tmux in a scope of its own (`systemd-run --user --scope`), so restarting, updating or uninstalling Kage leaves tmux and every Claude session running. If that doesn't work on your machine, Kage logs one line, "couldn't start tmux in a scope of its own", and starts tmux inside the service. Then a restart, `kage update` or `kage uninstall` ends the tmux session and every Claude in it. On macOS the agent is set so launchd leaves tmux running when Kage stops (documented, not observed).

**After a reboot**, sessions show as "ended", and you resume the ones you want with `U`. Every restart also signs every browser out (see Signing in).

**The `PATH` the service sees** is the one setup ran with, and so are the settings above. If you move `claude`, `tmux` or `git` later, or change one of those settings, run `kage setup` again; `kage doctor` tells you when the service can't find a program.

### On WSL

- The service needs systemd. Add this to `/etc/wsl.conf`, then run `wsl --shutdown` in Windows and open WSL again:
  ```
  [boot]
  systemd=true
  ```
  Without it, setup says so and skips the service; run `kage serve` yourself instead.
- WSL starts only when you open it, not when Windows boots, so neither does Kage, linger or not.
- A user unit doesn't read `~/.bashrc`, where tools such as `claude` are often put on the `PATH`. Run `kage setup` from a shell where `claude` works, so it captures that `PATH`.

### On macOS

These notes follow Apple's and Node's documentation. Kage hasn't been run on a Mac yet.

- The agent starts when you log in, not at boot. For Kage to run after a reboot with nobody at the Mac, turn on automatic login.
- If `tailscale` isn't on your `PATH`, Kage uses the Tailscale app's own command line.
- Kage can't tell whether Claude Code is signed in on macOS, so doctor asks you to run `claude` once to check.
- The program is ad-hoc signed. `curl` doesn't mark downloads as quarantined, so the installer's copy runs. A copy downloaded in a browser needs `xattr -d com.apple.quarantine kage` first.

## Signing in

Live mode needs an access token. Setup sets one by default: it makes a long random token, prints it once, and saves it in the config file, where you can read it again. The board asks for it once in each browser.

- **Each sign-in is a login of its own.** It ends after 7 days without use, and 30 days after you signed in, however often you use it. Kage keeps at most 64 logins; a new one ends the one used least recently.
- **A login works only from the address that signed in.** A device on your tailnet keeps its Tailscale address across networks. The same cookie from another address gets the login screen.
- **Sign out** is in the command palette. It ends this browser's login. To sign out every device at once, run `kage restart`.
- **Logins are lost at every restart.** Kage keeps them in memory only, so a restart, `kage update`, a reboot or setup again signs every browser out. An open board shows the login screen once Kage is back: sign in again.
- **Five wrong tries** from one address lock that address out for a minute. Other addresses still get their tries.

**Without a token**, live mode refuses to start: anyone who can reach Kage could run commands as you. To run without one on purpose, answer no to setup's token question (it writes `"allowNoToken": true`), or pass `kage serve --allow-no-token`. Kage then warns at every start, and `kage doctor` shows it. A config from before this rule with `"token": ""` stops until you run `kage setup` again; `kage doctor` and `kage status` say so. The demo needs no token.

**Not behind a proxy.** Don't put Kage behind `tailscale serve` or another reverse proxy. Kage refuses every action from a page served over `https:`, and behind a proxy every device shares one address, so a login would work from all of them.

## Start Claude sessions

Start a task from the board with `N` (see Control), or start Claude yourself in the tmux session `kage` with Kage watching. In your project's folder:

```sh
tmux new-window -t kage -c ~/projects/my-app "exec claude --settings '$(kage hooks-path)' --permission-mode default"
```

Or attach (`tmux attach -t kage`), open a new window (`Ctrl-b c`) and run `claude --settings "$(kage hooks-path)" --permission-mode default` there.

`kage hooks-path` writes the settings that send Claude's hook events to Kage, and prints the file's path (`$XDG_STATE_HOME/kage/claude-settings.json`, or `~/.local/state/kage/claude-settings.json`). Kage never changes Claude's own settings. Pass `--permission-mode default` too: Claude Code 2.1.330 starts in auto mode, which never asks, so Kage would never see a prompt.

The session appears on the board with live status and output. It turns amber when Claude asks for permission or asks a question, and done when Claude finishes or waits for your next prompt. The first run in a new folder shows Claude's folder-trust screen, and Kage reads it from the pane and shows it as "needs you" too. Answer it from the board, or in the terminal.

The tmux session's first window only holds the session open, so the board hides it while it sits at a shell.

To run Kage without the service, start it yourself with `kage serve` (add `--host 127.0.0.1` to stay on loopback) and open the address it prints. Live mode needs an access token, or `allowNoToken` (see Signing in).

Hook events travel over a Unix socket, `$XDG_RUNTIME_DIR/kage.sock` by default; `kage serve` sets `KAGE_SOCKET` in the tmux session, so Claude in its windows finds the same socket. To move it, set `KAGE_SOCKET`; the directory it sits in must be owned by you, and Kage refuses a shared one such as `/tmp`. Set `KAGE_TMUX_SOCKET` to use a separate tmux server (`tmux -L <name>`).

## Try the demo

To look around first, run the board with sample sessions, from a checkout:

```sh
git clone https://github.com/eridian-io/kage.git
cd kage
corepack enable
pnpm install
pnpm demo
```

`pnpm demo` builds Kage and serves the demo on `127.0.0.1`, then prints the address to open. It needs Node 24.2 or newer, and no tmux, Tailscale or token. It uses the port in your config (8080 by default); `pnpm demo --port 4000` picks another. It reads your config but writes nothing.

The top bar shows a `demo` badge. Nothing in the demo is saved, so its actions answer with one note: "This is the demo, so nothing here is saved. Set up Kage to run your own sessions." An installed Kage shows the same with `kage serve --demo --host 127.0.0.1`.

## Control

Kage can start and steer tasks from the board. This needs `claude` on Kage's `PATH` (or `KAGE_CLAUDE_BIN` set to it) and a git project directly inside `projectsRoot`.

**Start a task.** Press `N` or click New task. Type the task, pick the project and the branch to start from, and press Start (or Enter). Kage makes a git worktree at `<project>/.worktrees/<name>` on a new branch `kage/<name>`, opens a tmux window there and runs `claude` on your task. Start waits until the window is up, then selects the new session. Tick "Accept edits automatically" to let Claude edit files without asking. Commands still ask.

**Answer.** When Claude asks for permission or asks a question, the card shows its options as buttons. Click one, or press its number (`1`–`9`). A number acts at once, with no second key. Kage checks that the same question is still on the screen before it sends the key. A few options stay disabled and say "Choose this one in the terminal": switching to auto mode, and questions that take several choices.

**Reply and follow-up.** Type in the box under the card and press Enter to answer a prompt in your own words. On a finished session the same box sends a follow-up task, and the session runs again. `R` jumps to the box. A reply can't start with `!`, `#`, `/` or a number: use the terminal for those.

**Stop.** Click Stop, or press `X` twice within two seconds. Kage closes that session's tmux window. The worktree and the branch stay. Kage only stops windows it started.

**Ports and files.** A port that a task opens appears on the right with a link. A port that listens only on the PC says "Only on this machine" and shows the `ssh -L` command to reach it. The files the task changed, including uncommitted ones, are listed with their line counts. Changes inside a git submodule aren't counted or shown, in the list or the diff.

## Finish and terminal

**Pin.** Press `S`, or click the ★ in the session's header. A pinned session sorts first among the done ones and is never archived automatically.

**Archive.** Press `E` on a done or ended session. Kage closes its `claude` window and hides it, and keeps the worktree and the branch. Archived sessions are listed under "archived N" at the bottom of the left column, and Restore brings one back. A running session can't be archived: stop it first.

**Auto-archive.** With `autoArchive.onMerge`, a done session is archived once its branch is merged into the base branch. With `autoArchive.afterDays`, it is archived that many days after it finished (`0` turns the age rule off). Pinned sessions are exempt, and so is a session with a terminal open. Restoring or unpinning a session starts its clock again. Kage asks tmux once more right before it archives, so a session whose window is still alive is never archived as gone.

**Resume.** When `claude` has exited (after a reboot, say), the session shows "ended". Press `U` and Kage opens a new window in the same worktree and runs `claude --resume` on the old conversation. Kage never resumes sessions by itself.

**Delete.** Click Delete…. The confirmation lists what would be lost: commits only this branch has, files with uncommitted changes, and ignored files such as `.env`. Press Delete session to confirm. A click within a moment of the counts changing is ignored, since it was meant for the old counts. Kage then removes the worktree and the branch. If the counts changed since you looked, nothing is removed and the new counts show. Kage deletes only worktrees and branches it made (a branch with the configured `branchPrefix`; with `branchPrefix` set to `""` that check is off), and it never runs `git worktree prune`.

**View diff.** "View diff →" in the right column opens a read-only diff of the same files as the list: everything since the branch left its base, uncommitted and untracked files included. Long diffs come a page at a time (Previous and Next). `J` and `K` jump between the files on a page, and `Esc` goes back.

**Git stays in its worktree.** Kage runs git in a session's worktree only against the repository it started the session in. If the worktree's `.git` file is changed to point elsewhere, Kage stops running git there and says so.

**Terminal.** Press `T`. The session's tmux window opens in the browser, and every key goes to Claude, including `Esc`. Press `Shift+Esc` (or `Ctrl+Shift+X`) to return to the board. Chrome's Task Manager may take `Shift+Esc` on Windows and Linux: use `Ctrl+Shift+X` there. A window Kage didn't start is view-only. The terminal code (about 90 KB) loads the first time you open one.

## Notifications

Kage tells you when a session needs you, in two ways.

**On your phone, through [ntfy](https://ntfy.sh).** It is off until you set a topic.

The easy way is `kage setup`. It asks "Send pings to your phone through ntfy?" (No by default; `--ntfy` answers yes). On yes it:

1. makes a long random topic and saves it with your other settings;
2. once Kage answers, shows the topic once, with how to subscribe to it in the ntfy app (install the app on your phone first);
3. sends a test ping and asks whether it arrived.

Keep the topic secret: anyone who knows it can read your pings, and each ping carries the task's text. Setup never shows it again; it stays in the config file. A config that already has a topic keeps it, and setup doesn't ask. `kage ping` sends another test ping any time. Your phone should show "Kage test ping". If it can't send, the command says why (for example `HTTP 401` or `ECONNREFUSED`) and exits with 1.

To set it up by hand instead, or to use your own ntfy server:

1. Install the ntfy app on your phone and subscribe to a topic name.
2. Put the same name in the config as `ntfyTopic` (and `ntfyServer` and `ntfyToken` for your own server), then run `kage restart`.
3. Run `kage ping`.

A topic on ntfy.sh is public: anyone who guesses the name can read your pings, and send their own. So pick a long random one. Kage refuses to start with a topic shorter than 16 characters on ntfy.sh unless you also set `ntfyToken`. For example, run `openssl rand -hex 12` and use the result.

| Key | Default | Meaning |
|---|---|---|
| `ntfyTopic` | `""` | The topic to publish to. Empty means no pings. 1 to 64 letters, digits, `-` or `_` |
| `ntfyServer` | `"https://ntfy.sh"` | The ntfy server. It must be `https:`. Plain `http:` is allowed only for this machine (`localhost`, `127.x.x.x` or `[::1]`) or your tailnet (an address in `100.64.0.0/10` or `fd7a:115c:a1e0::/48`, or a `*.ts.net` name). Use plain `http:` to a `*.ts.net` name only for a machine on your own tailnet: Tailscale Funnel names also end in `.ts.net` and resolve publicly, and Kage can't tell them apart |
| `ntfyToken` | `""` | An ntfy access token, for a server that needs one. 1 to 128 letters, digits, `-` or `_`. Kage sends it as a bearer token |
| `ntfyOnDone` | `false` | Also ping when a session that worked for a minute or more is done |

When you get a ping:
- A session that moves into "needs you" is pinged after 3 seconds, if it is still waiting. Answer it at the board within that time and nothing is sent.
- A session is pinged at most once every 2 minutes, and a question asked again inside that time is pinged when the 2 minutes are over.
- With `ntfyOnDone`, a session that worked for at least a minute and then finished is pinged "is done". A session you stopped is not, nor one whose prompt you answered No or Esc.
- At most 10 pings go out in any 10 minutes. Kage logs how many it skipped.
- Sessions already waiting when Kage starts are not pinged.
- A failed ping is tried again after 2, 8 and 30 seconds, then given up. A try the server took more than 5 seconds to answer is tried again too. Every try of one ping carries the same id (the `X-Sequence-ID` header), so on ntfy 2.16.0 or newer a ping that did arrive is replaced, not doubled. An older server may show it twice.
- Tapping a ping opens that session on the board.

**What the ntfy server sees.** The topic, a title such as "my-app needs you", the task text (cut to 100 characters), the board link (Kage's host name or address, the port and the session's id), and your PC's address and the time, plus a random id per ping that holds nothing of yours. It never gets the question, the output, a command, a branch or a path. A window Kage didn't start has no task to show: its ping says "Claude needs you" with the PC's name. Kage logs no topic, token or server address; a failure is named by a status or an error code only. If the task text itself is private, use your own ntfy server, or leave ntfy off.

**In the browser.** The tab's title shows how many sessions need you, as "(2) kage". Browser notifications need `https:` or this machine's own address: a browser doesn't offer them on a plain `http://my-pc.tail1234.ts.net:8080` over the tailnet. Over plain tailnet `http:`, you get the tab title and ntfy. On a Kage that listens on loopback (`http://127.0.0.1:<port>`, or `localhost`), open the command palette and choose "Turn on browser notifications". A notification shows only when a session starts to need you while the page has no focus, with the same text as a ping.

## Command palette

Press `⌘K` on a Mac, or `Ctrl+K` elsewhere (or click the hint at the top right). Type to jump to a session, or to run a command on the selected session: View diff, Open the terminal, Pin, Archive, Resume, Stop, Delete…. It also starts a New task, shows archived sessions, turns on browser notifications and, while a token is set, signs you out. Arrow keys move, `Enter` runs, and `Esc` closes. The palette loads the first time you open it.

## Configuration

Kage reads `~/.config/kage/config.json`, or `$XDG_CONFIG_HOME/kage/config.json` when `XDG_CONFIG_HOME` is set. The file is optional: every key has a default, and unknown keys are ignored. `kage setup` writes the keys it asks about, readable by you only, and keeps the rest. It lives outside the checkout, so hostnames and secrets never end up in the repo. After you edit it by hand, run `kage restart`.

```json
{
  "name": "my-pc",
  "host": null,
  "port": 8080,
  "projectsRoot": "~/projects",
  "tmuxSession": "kage",
  "worktreeDir": ".worktrees",
  "branchPrefix": "kage/",
  "autoArchive": { "onMerge": true, "afterDays": 14 },
  "ntfyTopic": "",
  "ntfyServer": "https://ntfy.sh",
  "ntfyToken": "",
  "ntfyOnDone": false,
  "token": "",
  "allowNoToken": false
}
```

| Key | Default | Meaning |
|---|---|---|
| `name` | The PC's hostname, before the first dot | The name in the dashboard's host pill. It is only a label: Kage doesn't answer to it |
| `host` | `null` | The address to listen on. `null` uses your Tailscale IP (from `tailscale ip -4`). Kage only accepts a Tailscale or loopback address, or a name that resolves to one. Kage answers to its Tailscale IP and full MagicDNS name (`box.tail1234.ts.net`), to `localhost` when it listens on loopback, and to the name you set here. To use the short name (`box`), set it by hand in the config file; `kage setup` won't write it. A `.local` name or a single word here means trusting everyone on your local network |
| `port` | `8080` | The port the dashboard listens on |
| `projectsRoot` | `"~/projects"` | The folder that holds your git projects |
| `tmuxSession` | `"kage"` | The tmux session Kage uses for agent windows |
| `worktreeDir` | `".worktrees"` | The folder, inside each project, for the agents' git worktrees |
| `branchPrefix` | `"kage/"` | The prefix for the branches Kage creates |
| `autoArchive` | `{ "onMerge": true, "afterDays": 14 }` | Archive a done session when its branch is merged, or this many days after it finished (`0` turns the age rule off) |
| `ntfyTopic` | `""` | Optional: your [ntfy](https://ntfy.sh) topic for phone pings. On ntfy.sh it must be a long random name (see Notifications) |
| `ntfyServer` | `"https://ntfy.sh"` | The ntfy server (see Notifications) |
| `ntfyToken` | `""` | Optional ntfy access token |
| `ntfyOnDone` | `false` | Also ping when a long-running session is done |
| `token` | `""` | The access token, at least 16 characters. When set, the board asks for it once in each browser (see Signing in); `""` means no sign-in, and then live mode starts only with `allowNoToken` |
| `allowNoToken` | `false` | `true` lets live mode run without a token, so anyone who can reach Kage can run commands as you. Without it (or `kage serve --allow-no-token`) Kage refuses to start with no token. `kage setup` sets it when you answer no to the token |

Live sessions use every key. Kage checks them all when it starts and stops with one line if a value is wrong. The pings need live mode: the demo sends none.

The environment variables `KAGE_NAME`, `KAGE_HOST` and `KAGE_PORT` override `name`, `host` and `port`, and `kage serve --host` overrides both for one run. `KAGE_CLAUDE_BIN` names the `claude` program for new tasks.

## Safety

- Kage listens on your Tailscale IP only (or on loopback, if you chose that), so only devices on your tailnet can reach it.
- It answers only to names nobody else on your network can claim: its Tailscale IP, its full MagicDNS name, the `host` you set, and `localhost` on loopback. Any other name gets 403, so a page that tricks your browser into calling your PC's name can't reach Kage.
- Live mode needs an access token unless you turn that off yourself, and each browser's login can be signed out.
- It never kills tmux windows it didn't create.
- Each task runs in its own git worktree, so agents don't trip over each other or over your own work.
- Claude Code can run commands on your PC. Only add devices you trust to your tailnet.
- Nothing installs or runs as root. A step that needs root is printed for you to run.
- The running Kage contacts nothing outside your machine except your ntfy server, and only when you set a topic. `kage update` and the installer download from GitHub, only when you run them, over HTTPS, and check the program against the release's `SHA256SUMS`. `kage update` also runs the new program and checks that it reports the release's version. `kage ping`, and `kage setup` when you say yes to pings, send one test ping to your ntfy server.
- The checksum catches a broken download, not a forged release. Releases aren't signed yet. To check that a release was built from this repository, verify it with the GitHub CLI: `gh attestation verify kage-linux-x64.gz --repo eridian-io/kage`.

## Roadmap

Phases 2 to 6 and hardening are built on their branches and not merged into `main` yet. No release exists.

- [x] **Phase 1, skeleton:** dashboard served over Tailscale
- [x] **Phase 2, sessions:** live tmux sessions with status from hooks and output from transcripts (built on its branch)
- [x] **Phase 3, control:** start, answer and stop tasks; preview links; token login (built on its branch)
- [x] **Phase 4, finish and terminal:** pin, archive, auto-archive, delete with a warning, resume, a diff view and a terminal in the browser (built on its branch)
- [x] **Phase 5, polish:** notifications through ntfy and the browser, a command palette, performance budgets (built on its branch)
- [ ] **Phase 6, install and release:** `kage setup`, services that start on boot, single-file releases (built on its branch; waiting for the first release)
- [ ] **Hardening:** a login for each browser with sign-out, only your tailnet names trusted, no live mode without a token, `kage restart` and `kage logs`, `pnpm demo`, pings set up by `kage setup`, a lighter and faster Kage (built on its branch)
- [ ] **Later:** a phone layout

## Contributing

Issues and pull requests are welcome. Before your first pull request is merged, you'll be asked to sign a short Contributor License Agreement. See [CONTRIBUTING.md](CONTRIBUTING.md), which also describes releasing.

## License

Kage is licensed under the [GNU Affero General Public License v3.0](https://github.com/eridian-io/kage/blob/main/LICENSE). You may use, change and share it freely. Any version you distribute or run as a network service must stay open source under the same license.

If you want to use Kage in a closed-source product, a commercial license is available. Open an issue to get in touch.

---

<sub>Kage is an independent project and is not affiliated with or endorsed by Anthropic. Claude and Claude Code are trademarks of Anthropic.</sub>
