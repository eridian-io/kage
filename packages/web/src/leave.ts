/**
 * The keys that leave the terminal (T2, R56, R64): Shift+Esc, or Ctrl+Shift+X where the browser
 * takes Shift+Esc for itself. Plain Esc belongs to Claude. Shared by the board's keys and the
 * terminal chunk (a few bytes in each), so both agree on what never reaches the pane.
 */
export function isLeave(e: KeyboardEvent): boolean {
  if (e.altKey || e.metaKey || !e.shiftKey) return false;
  return e.ctrlKey ? e.key.toLowerCase() === 'x' : e.key === 'Escape';
}
