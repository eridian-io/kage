import type { Session } from './types.ts';

type Group = 'needs you' | 'running' | 'done';
const RANK: Record<Group, number> = { 'needs you': 0, running: 1, done: 2 };

export function groupOf(s: Session): Group {
  if (s.status === 'needs-you') return 'needs you';
  if (s.status === 'running') return 'running';
  return 'done';
}

/** Groups needs-you, running, done; pinned first within done; then oldest status first. */
export function sortSessions(list: Session[]): Session[] {
  return [...list].sort((a, b) => {
    const ga = groupOf(a);
    const gb = groupOf(b);
    if (ga !== gb) return RANK[ga] - RANK[gb];
    if (ga === 'done' && a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return a.statusSince - b.statusSince;
  });
}
