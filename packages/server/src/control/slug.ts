/** The longest slug: it names the branch, the worktree folder and the tmux window. */
export const SLUG_MAX = 40;
const MAX_SUFFIX = 99;

/** Cuts `s` to `max` characters, at a "-" when one is in the last 10, without a trailing "-". */
function cut(s: string, max: number): string {
  if (s.length <= max) return s;
  let out = s.slice(0, max);
  if (s[max] !== '-') {
    const dash = out.lastIndexOf('-');
    if (dash >= max - 10) out = out.slice(0, dash);
  }
  return out.replace(/-+$/, '');
}

/**
 * A branch- and folder-safe name for a task: accents stripped, lowercase ASCII letters and
 * digits joined by single "-", never starting or ending with "-", at most 40 characters.
 */
export function slugify(task: string): string {
  const s = task
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cut(s, SLUG_MAX) || 'task';
}

/** `base`, else `base-2` … `base-99` (the base trimmed so the result stays ≤ 40); throws after. */
export async function uniqueSlug(
  base: string,
  taken: (slug: string) => Promise<boolean>,
): Promise<string> {
  if (!(await taken(base))) return base;
  for (let n = 2; n <= MAX_SUFFIX; n++) {
    const suffix = `-${n}`;
    const head = base.slice(0, SLUG_MAX - suffix.length).replace(/-+$/, '');
    const slug = `${head}${suffix}`;
    if (!(await taken(slug))) return slug;
  }
  throw new Error(`no free name for "${base}" (tried ${base}-2 … ${base}-${MAX_SUFFIX})`);
}
