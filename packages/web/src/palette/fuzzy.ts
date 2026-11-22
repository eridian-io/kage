/**
 * The palette's fuzzy match (Task 8): a case-insensitive subsequence, scored so that word starts
 * and runs win. No dependency; one pass to reject, then a small dynamic programme over
 * query × text that finds the best-scoring hits, so `wn` takes the W of Write and the n of notes.
 */
export interface Match {
  score: number;
  /** The matched indices in the text, ascending, for highlighting. */
  hits: number[];
}

/** A character after one of these starts a word. */
const BOUNDARY = ' /-_.';
const NONE = Number.NEGATIVE_INFINITY;

// Reused between calls: ranking a thousand items allocates no tables.
let scores = new Float64Array(0);
let from = new Int32Array(0);

/** Case-insensitive subsequence match; null when not all query characters appear in order. */
export function fuzzy(query: string, text: string): Match | null {
  const m = query.length;
  const n = text.length;
  const base = -0.01 * n;
  if (m === 0) return { score: base, hits: [] };
  if (m > n) return null;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let p = 0;
  for (let j = 0; j < n && p < m; j++) if (t[j] === q[p]) p++;
  if (p < m) return null;
  if (scores.length < m * n) {
    scores = new Float64Array(m * n);
    from = new Int32Array(m * n);
  }
  // scores[i·n + j]: the best score with query[0..i] matched and query[i] at text[j].
  for (let i = 0; i < m; i++) {
    const row = i * n;
    const prev = row - n;
    // The best of the previous row at k ≤ j − 2 (a hit that isn't adjacent).
    let best = NONE;
    let bestAt = -1;
    for (let j = 0; j < n; j++) {
      if (i > 0 && j >= 2) {
        const v = scores[prev + j - 2] as number;
        if (v > best) {
          best = v;
          bestAt = j - 2;
        }
      }
      let v = NONE;
      let at = -1;
      if (t[j] === q[i]) {
        const bonus = j === 0 || BOUNDARY.includes(t[j - 1] as string) ? 6 : 1;
        if (i === 0) v = bonus;
        else {
          if (best > NONE) {
            v = best + bonus;
            at = bestAt;
          }
          const run = j >= 1 ? (scores[prev + j - 1] as number) : NONE;
          if (run > NONE && run + bonus + 3 > v) {
            v = run + bonus + 3;
            at = j - 1;
          }
        }
      }
      scores[row + j] = v;
      from[row + j] = at;
    }
  }
  const last = (m - 1) * n;
  let end = -1;
  let top = NONE;
  for (let j = 0; j < n; j++) {
    const v = scores[last + j] as number;
    if (v > top) {
      top = v;
      end = j;
    }
  }
  const hits = new Array<number>(m);
  for (let i = m - 1, j = end; i >= 0; i--) {
    hits[i] = j;
    j = from[i * n + j] as number;
  }
  return { score: top + base, hits };
}

/** The items that match, best first (ties keep the input order), at most `limit`. */
export function rank<T>(
  query: string,
  items: readonly T[],
  text: (t: T) => string,
  limit = 50,
): { item: T; match: Match }[] {
  const out: { item: T; match: Match }[] = [];
  for (const item of items) {
    const match = fuzzy(query, text(item));
    if (match) out.push({ item, match });
    // With no query every item matches in order: nothing to sort, so stop at the limit.
    if (query === '' && out.length === limit) return out;
  }
  // Array.prototype.sort is stable.
  if (query !== '') out.sort((a, b) => b.match.score - a.match.score);
  return out.length > limit ? out.slice(0, limit) : out;
}
