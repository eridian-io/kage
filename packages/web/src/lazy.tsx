/**
 * The board's lazy chunks (performance P6; build.ts LAZY): New task, the archived list and notify
 * load on demand, outside the first load. The palette loader's pattern (palette-loader.tsx),
 * generalised: one import at a time, a failure forgotten, and a retry under a new URL (the
 * chunk's `<meta name="kage-<name>">` plus `?r=<n>`), since a browser keeps a failed module fetch.
 *
 * F2: a chunk that still fails after its retries reloads the page, once (a sessionStorage guard
 * per chunk against loops). That is the way out of a version skew: after `kage update` an open
 * board's old `<name>-<hash>.js` is gone from the server. The login screen stays in the first
 * load for the same reason, so it has no host here.
 */
import { effect } from '@preact/signals';
import { useEffect, useRef, useState } from 'preact/hooks';
import { hadSnapshot, newTaskOpen } from './store.ts';

/** Retries after the first attempt, each under a new `?r=`, before the page reloads. */
const RETRIES = 2;
/** The sessionStorage key that marks a reload this chunk asked for. */
const reloadKey = (name: string) => `kage-reloaded:${name}`;

/** The page reload and the storage its guard lives in, swappable in tests. */
export const lazyPage = {
  reload: (): void => location.reload(),
  storage: (): Storage | null => {
    try {
      return sessionStorage;
    } catch {
      return null;
    }
  },
};

/**
 * The chunk's URL with a cache-busting `?r=<retry>`, from `<meta name="kage-<name>">` (build.ts
 * writes one per LAZY entry), or null outside a build (vitest, where the plain import is used).
 */
export function chunkUrl(name: string, retry: number): string | null {
  const url = document.querySelector<HTMLMetaElement>(`meta[name="kage-${name}"]`)?.content;
  return url ? `${url}?r=${retry}` : null;
}

/**
 * The chunk's reload guard: `set` marks a reload and says whether this one may happen (not when
 * the chunk has reloaded the page already this session, nor without storage); else it clears it.
 */
function guard(name: string, set: boolean): boolean {
  try {
    const st = lazyPage.storage();
    if (!set) st?.removeItem(reloadKey(name));
    else if (st && st.getItem(reloadKey(name)) === null) {
      st.setItem(reloadKey(name), '1');
      return true;
    }
  } catch {
    // Storage refused: never reload, so a failing chunk can't loop.
  }
  return false;
}

/**
 * One lazy chunk: `load()` imports it once (two calls share one import), `loaded()` is the module
 * once it is in, else null, for a synchronous first render. `load(retry)` is the import: retry 0
 * is the plain one, a later one goes through `chunkUrl`.
 */
export function lazyChunk<M>(
  name: string,
  load: (retry: number) => Promise<M>,
): { load(): Promise<M>; loaded(): M | null } {
  let mod: M | null = null;
  let pending: Promise<M> | null = null;
  /** Failed imports so far: the next one asks under `?r=<failures>`, a URL never tried. */
  let failures = 0;
  const attempt = async (): Promise<M> => {
    for (let tries = 0; ; tries++) {
      try {
        const m = await load(failures);
        mod = m;
        guard(name, false);
        return m;
      } catch (e) {
        failures++;
        if (tries < RETRIES) continue;
        // The page goes away: the load never settles, so nothing shows an error first.
        if (!guard(name, true)) throw e;
        lazyPage.reload();
        return new Promise<M>(() => {});
      }
    }
  };
  return {
    load() {
      pending ??= attempt().catch((e: unknown) => {
        pending = null;
        throw e;
      });
      return pending;
    },
    loaded: () => mod,
  };
}

/** The import of a LAZY entry: the plain dynamic import, or its URL with `?r=` on a retry. */
function importer<M>(name: string, plain: () => Promise<M>): (retry: number) => Promise<M> {
  return (retry) => {
    const url = retry > 0 ? chunkUrl(name, retry) : null;
    return url === null ? plain() : (import(/* @vite-ignore */ url) as Promise<M>);
  };
}

export const newTaskChunk = lazyChunk(
  'newtask',
  importer('newtask', () => import('./components/NewTask.tsx')),
);
export const notifyChunk = lazyChunk(
  'notify',
  importer('notify', () => import('./notify.ts')),
);

const closeNewTask = () => {
  newTaskOpen.value = false;
};

/**
 * The New task form in the left column while `newTaskOpen` (SessionList). The chunk is prefetched
 * on idle after the first snapshot (installLazy), so N shows the form at once; before it is in, a
 * quiet "Loading…" holds the form's place and the focus, and Esc closes it as it closes the form.
 */
export function NewTaskHost() {
  const [m, setM] = useState(newTaskChunk.loaded);
  const [failed, setFailed] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (m !== null) return;
    box.current?.focus();
    let gone = false;
    newTaskChunk.load().then(
      (x) => {
        if (!gone) setM(x);
      },
      () => {
        if (!gone) setFailed(true);
      },
    );
    // The form's own Esc listener isn't there yet, and keys.ts leaves Esc alone while it's open.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing || e.defaultPrevented) return;
      e.preventDefault();
      closeNewTask();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      gone = true;
      document.removeEventListener('keydown', onKey);
    };
  }, []);
  if (m !== null) return <m.NewTask />;
  return (
    // Focusable so the focus the New task button had isn't dropped to the page while it loads.
    <div class="k-nt k-nt-loading" ref={box} tabIndex={-1}>
      {failed ? (
        <p class="k-nt-err" role="alert">
          Couldn't open New task. Reload the page to try again.
        </p>
      ) : (
        <p class="k-nt-none" role="status">
          Loading…
        </p>
      )}
    </div>
  );
}

const later = (w: Window, fn: () => void): (() => void) => {
  if (typeof w.requestIdleCallback === 'function') {
    const id = w.requestIdleCallback(fn, { timeout: 2000 });
    return () => w.cancelIdleCallback?.(id);
  }
  const id = setTimeout(fn, 200);
  return () => clearTimeout(id);
};

/**
 * Once the first snapshot is in: loads notify and installs it (the title count, browser
 * notifications), and prefetches New task on idle. Returns the stopper.
 */
export function installLazy(w: Window = window): () => void {
  let started = false;
  let stopped = false;
  let stopNotify: (() => void) | null = null;
  let cancelIdle: (() => void) | null = null;
  const stopWatch = effect(() => {
    if (started || !hadSnapshot.value) return;
    started = true;
    notifyChunk.load().then(
      (m) => {
        if (!stopped) stopNotify = m.installNotify(w);
      },
      () => {}, // ntfy still pings; the title just keeps its plain name
    );
    cancelIdle = later(w, () => {
      cancelIdle = null;
      newTaskChunk.load().catch(() => {}); // N tries again, and says so if it can't
    });
  });
  return () => {
    stopped = true;
    stopWatch();
    cancelIdle?.();
    stopNotify?.();
  };
}
