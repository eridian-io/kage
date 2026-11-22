import { toast } from '../store.ts';

/** What happened to the worktree and branch: delete removes them, archive keeps them. */
const COPY = {
  deleted: ['Deleted ', ' · worktree and branch removed'],
  archived: ['Archived ', ' · worktree and branch kept'],
} as const;

export function Toast() {
  const t = toast.value;
  if (t === null) return null;
  const [before, after] = COPY[t.kind];
  return (
    <div class="k-toast" role="status">
      {before}
      <b>{t.name}</b>
      {after}
    </div>
  );
}
