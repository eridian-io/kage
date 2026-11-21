export interface TmuxWindow {
  windowId: string;
  kageId: string | null;
  paneId: string;
  panePid: number;
  command: string;
  cwd: string;
  name: string;
  /** Epoch seconds of the window's last activity. */
  activity: number;
  /** R22: the window ensureSession made to hold the session (`@kage_placeholder` set). */
  placeholder: boolean;
  /** The chosen pane's `#{pane_dead}`: its process exited and `remain-on-exit` keeps it shown. */
  dead: boolean;
}

/** One pane of `list-panes -s`, with the pane's `#{pane_active}`. */
export type TmuxPane = TmuxWindow & { active: boolean };

/** A format field with every tab replaced by a space (tmux's `s/` modifier, a real tab as pattern). */
const noTab = (field: string): string => `#{s/\t/ /:${field}}`;

/**
 * `tmux list-panes -s -F` format: one line per pane, fields separated by a real tab character
 * (F16: tmux does not expand a backslash-t). The window fields resolve for every pane. Free text
 * that anyone can set has its tabs replaced, and the pane path, which must stay exact, comes last
 * so that a tab inside it stays part of it.
 */
export const LIST_PANES_FORMAT = [
  '#{window_id}',
  noTab('@kage_id'),
  '#{pane_id}',
  '#{pane_pid}',
  '#{window_activity}',
  '#{pane_active}',
  '#{pane_dead}',
  noTab('@kage_placeholder'),
  noTab('pane_current_command'),
  noTab('window_name'),
  '#{pane_current_path}',
].join('\t');

/** Fields before the pane path. */
const FIXED = 10;

/** `claude`, or the version string Claude Code may set as its process title (e.g. `2.1.330`). */
export const isClaude = (command: string): boolean =>
  command === 'claude' || /^\d+\.\d+\.\d+$/.test(command);

/** Parses `list-panes` output; malformed lines are skipped. Empty fields stay empty. */
export function parsePanes(out: string): TmuxPane[] {
  const panes: TmuxPane[] = [];
  for (const line of out.split('\n')) {
    const all = line.replace(/\r$/, '').split('\t');
    if (all.length < FIXED + 1) continue;
    const [windowId, kageId, paneId, pid, act, active, dead, placeholder, command, name] = all as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    const cwd = all.slice(FIXED).join('\t');
    const panePid = Number(pid);
    const activity = Number(act);
    if (!/^@\d+$/.test(windowId) || !/^%\d+$/.test(paneId)) continue;
    if (!Number.isInteger(panePid) || pid === '' || !Number.isFinite(activity) || act === '')
      continue;
    if (!/^[01]$/.test(active) || !/^[01]$/.test(dead)) continue;
    panes.push({
      windowId,
      kageId: kageId === '' ? null : kageId,
      paneId,
      panePid,
      command,
      cwd,
      name,
      activity,
      placeholder: placeholder !== '',
      active: active === '1',
      dead: dead === '1',
    });
  }
  return panes;
}

/**
 * B14: one pane per window, in window order. A pane that has sent a hook, else one running
 * `claude`, else the active pane (else the first).
 */
export function pickPanes(panes: TmuxPane[], hookPanes: ReadonlySet<string>): TmuxWindow[] {
  const byWindow = new Map<string, TmuxPane[]>();
  for (const p of panes) {
    const list = byWindow.get(p.windowId);
    if (list) list.push(p);
    else byWindow.set(p.windowId, [p]);
  }
  const picked: TmuxWindow[] = [];
  for (const list of byWindow.values()) {
    const p =
      list.find((x) => hookPanes.has(x.paneId)) ??
      list.find((x) => isClaude(x.command)) ??
      list.find((x) => x.active) ??
      (list[0] as TmuxPane);
    const { active: _active, ...w } = p;
    picked.push(w);
  }
  return picked;
}
