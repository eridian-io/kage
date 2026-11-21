const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** Short age such as `now`, `4m`, `3h`, `2d`. */
export function formatAge(ms: number): string {
  if (ms < MINUTE) return 'now';
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h`;
  return `${Math.floor(ms / DAY)}d`;
}

/** Strips `~/projects/` (or the given projects root) from a worktree path. */
export function shortWorktree(path: string, projectsRoot?: string): string {
  const roots = [projectsRoot, '~/projects'].filter((r): r is string => !!r);
  for (const root of roots) {
    const prefix = root.endsWith('/') ? root : `${root}/`;
    if (path.startsWith(prefix)) return path.slice(prefix.length);
  }
  return path;
}
