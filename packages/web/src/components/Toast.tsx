import { toast } from '../store.ts';

export function Toast() {
  const name = toast.value;
  if (name === null) return null;
  return (
    <div class="k-toast" role="status">
      Deleted <b>{name}</b> · worktree and branch removed
    </div>
  );
}
