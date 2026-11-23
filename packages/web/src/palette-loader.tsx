import { useEffect, useState } from 'preact/hooks';
import { chunkUrl, notifyChunk } from './lazy.tsx';
import type { NotifyApi } from './notify.ts';
import { paletteHint } from './platform.ts';
import { paletteOpen, toast } from './store.ts';

type PaletteModule = typeof import('./components/Palette.tsx');

/**
 * The import of the palette chunk (build.ts LAZY, R95), swappable in tests. A retry asks under a
 * new URL (`<meta name="kage-palette">` plus `?r=<n>`): a browser keeps a failed module fetch.
 */
export const paletteImport = {
  load: (retry = 0): Promise<PaletteModule> => {
    const url = retry > 0 ? chunkUrl('palette', retry) : null;
    return url === null
      ? import('./components/Palette.tsx')
      : (import(/* @vite-ignore */ url) as Promise<PaletteModule>);
  },
};

let mod: PaletteModule | null = null;
let pending: Promise<PaletteModule> | null = null;
let failures = 0;

/** Loads the chunk once (the first open, or a hover on the ⌘K hint); a failure is forgotten. */
export function loadPalette(): Promise<PaletteModule> {
  pending ??= paletteImport.load(failures).then(
    (m) => {
      mod = m;
      return m;
    },
    (e) => {
      failures++;
      pending = null;
      throw e;
    },
  );
  return pending;
}

/** The palette and notify's API (notify is a lazy chunk too, lazy.tsx), once both are in. */
type Loaded = { palette: PaletteModule; notify: NotifyApi };
const both = (): Loaded | null => {
  const n = notifyChunk.loaded();
  return mod && n ? { palette: mod, notify: n.notifyApi } : null;
};

/**
 * Renders the palette while `paletteOpen`, loading its chunk (and notify's, usually in already
 * after the first snapshot) on the first open. If the chunk won't load, the palette closes again
 * and the toast says so; the next ⌘K tries again under a new URL.
 */
export function PaletteHost() {
  const open = paletteOpen.value;
  const [m, setM] = useState(both);
  useEffect(() => {
    if (!open || m) return;
    let gone = false;
    Promise.all([loadPalette(), notifyChunk.load()]).then(
      ([palette, n]) => {
        if (gone) return;
        if (toast.value?.kind === 'note') toast.value = null;
        setM({ palette, notify: n.notifyApi });
      },
      () => {
        if (gone) return;
        paletteOpen.value = false;
        toast.value = {
          kind: 'note',
          text: `Couldn't open the palette. Press ${paletteHint()} to try again.`,
        };
      },
    );
    return () => {
      gone = true;
    };
  }, [open]);
  return open && m ? <m.palette.Palette notify={m.notify} /> : null;
}
