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

/**
 * `tmux list-panes -s -F` format: one line per pane, fields separated by a real tab character
 * (F16: tmux does not expand a backslash-t). The window fields resolve for every pane.
 */
export const LIST_PANES_FORMAT = [
  '#{window_id}',
  '#{@kage_id}',
  '#{pane_id}',
  '#{pane_pid}',
  '#{pane_current_command}',
  '#{pane_current_path}',
  '#{window_name}',
  '#{window_activity}',
  '#{pane_active}',
  '#{pane_dead}',
  '#{@kage_placeholder}',
].join('\t');

const FIELDS = 11;

/** `claude`, or the version string Claude Code may set as its process title (e.g. `2.1.330`). */
export const isClaude = (command: string): boolean =>
  command === 'claude' || /^\d+\.\d+\.\d+$/.test(command);

/** Parses `list-panes` output; malformed lines are skipped. Empty fields stay empty. */
export function parsePanes(out: string): TmuxPane[] {
  const panes: TmuxPane[] = [];
  for (const line of out.split('\n')) {
    const f = line.replace(/\r$/, '').split('\t');
    if (f.length !== FIELDS) continue;
    const [windowId, kageId, paneId, pid, command, cwd, name, act, active, dead, placeholder] =
      f as [string, string, string, string, string, string, string, string, string, string, string];
    const panePid = Number(pid);
    const activity = Number(act);
    if (!/^@\d+$/.test(windowId) || !/^%\d+$/.test(paneId)) continue;
    if (!Number.isInteger(panePid) || pid === '' || !Number.isFinite(activity) || act === '')
      continue;
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
