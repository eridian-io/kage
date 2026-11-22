/**
 * A browser notification's text and the notification itself (W1). Its own lazy chunk: notify.ts
 * imports it on the first move into needs-you that may show one, so a board that never shows a
 * notification (the usual `http://` board over the tailnet) never loads it.
 */
import type { Session } from '@kage/shared';

/** Control characters other than tab, and bidi and format characters (as the server's stripAnsi). */
const HIDDEN =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
  /[\0-\x08\x0a-\x1f\x7f-\x9f\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\u2028\u2029\ufeff]/g;

/** Ping text (N2): one line, no control or bidi characters, at most `max` characters. */
function plain(text: string, max: number): string {
  const t = text.replace(/\n/g, ' ').replace(HIDDEN, '');
  if (t.length <= max) return t;
  let cut = t.slice(0, max - 1);
  if (/[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/**
 * Shows the notification for a move into needs-you, with the ping's title and body (N2); an
 * external window gets fixed text (F3b, as the server's notifier). Null when the browser refuses:
 * Android Chrome allows notifications only from a service worker. `max` is LIMITS.pingChars,
 * passed in: importing LIMITS here would split it out of the first load's chunk into its own.
 */
export function show(
  N: typeof Notification,
  s: Session,
  host: string,
  max: number,
  onClick: () => void,
): Notification | null {
  const title = s.external ? 'Claude needs you' : plain(`${s.project} needs you`, max);
  const body = plain(s.external ? `A Claude session needs you on ${host}` : s.task, max);
  try {
    const n = new N(title, { body: body === '' ? title : body, tag: `kage-${s.id}` });
    n.onclick = onClick;
    return n;
  } catch {
    return null;
  }
}
