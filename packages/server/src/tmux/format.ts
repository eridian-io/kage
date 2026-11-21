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
}

/** `tmux list-windows -F` format: tab separated, one line per window (first pane's data). */
export const LIST_WINDOWS_FORMAT = [
  '#{window_id}',
  '#{@kage_id}',
  '#{pane_id}',
  '#{pane_pid}',
  '#{pane_current_command}',
  '#{pane_current_path}',
  '#{window_name}',
  '#{window_activity}',
  '#{@kage_placeholder}',
].join('\t');

/** Parses `list-windows` output; malformed lines are skipped. */
export function parseWindows(out: string): TmuxWindow[] {
  const windows: TmuxWindow[] = [];
  for (const line of out.split('\n')) {
    const f = line.replace(/\r$/, '').split('\t');
    if (f.length !== 9) continue;
    const [windowId, kageId, paneId, pid, command, cwd, name, act, placeholder] = f as [
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
    const panePid = Number(pid);
    const activity = Number(act);
    if (!/^@\d+$/.test(windowId) || !/^%\d+$/.test(paneId)) continue;
    if (!Number.isInteger(panePid) || pid === '' || !Number.isFinite(activity) || act === '')
      continue;
    windows.push({
      windowId,
      kageId: kageId === '' ? null : kageId,
      paneId,
      panePid,
      command,
      cwd,
      name,
      activity,
      placeholder: placeholder !== '',
    });
  }
  return windows;
}
