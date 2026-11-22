import type { TerminalModule } from './terminal/index.ts';

/** The import, swappable in tests (the chunk's URL exists only in a build). */
export const termImport = { load: (url: string) => import(url) as Promise<TerminalModule> };

let cached: Promise<TerminalModule> | null = null;

/**
 * The terminal chunk, loaded the first time a terminal opens (spec §5.6): the files named by
 * `<meta name="kage-term">`, the stylesheet first (xterm measures its cells on open), and Geist
 * Mono. Cached; a failure is forgotten, so the next open tries again.
 */
export function loadTerminal(): Promise<TerminalModule> {
  cached ??= (async () => {
    const [js, css] = (
      document.querySelector<HTMLMetaElement>('meta[name="kage-term"]')?.content ?? ''
    ).split(' ');
    if (!js || !css) throw new Error('no terminal');
    // Added once: a failed stylesheet is removed again; a loaded one stays for later opens.
    if (!document.querySelector(`link[href="${css}"]`)) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = css;
      await new Promise((ok, fail) => {
        link.onload = ok;
        link.onerror = fail;
        document.head.append(link);
      }).catch((e) => {
        link.remove();
        throw e;
      });
    }
    const [m] = await Promise.all([
      termImport.load(js),
      // A font that won't load leaves xterm on the fallback monospace; it doesn't stop it.
      document.fonts?.load('13px "Geist Mono"').catch(() => {}),
    ]);
    return m;
  })().catch((e) => {
    cached = null;
    throw e;
  });
  return cached;
}
