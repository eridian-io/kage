import { useEffect, useState } from 'preact/hooks';
import { notifyApi } from './notify.ts';
import { paletteHint } from './platform.ts';
import { paletteOpen, toast } from './store.ts';

type PaletteModule = typeof import('./components/Palette.tsx');

/**
 * The import of the palette chunk (build.ts LAZY, R95), swappable in tests. A retry asks under a
 * new URL (`<meta name="kage-palette">` plus `?r=<n>`): a browser keeps a failed module fetch.
 */
export const paletteImport = {
  load: (retry = 0): Promise<PaletteModule> => {
    const url =
      retry > 0
        ? document.querySelector<HTMLMetaElement>('meta[name="kage-palette"]')?.content
        : undefined;
    return url
      ? (import(/* @vite-ignore */ `${url}?r=${retry}`) as Promise<PaletteModule>)
      : import('./components/Palette.tsx');
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

/**
 * Renders the palette while `paletteOpen`, loading its chunk on the first open. If the chunk
 * won't load, the palette closes again and the toast says so; the next ⌘K tries again under a new
 * URL.
 */
export function PaletteHost() {
  const open = paletteOpen.value;
  const [m, setM] = useState(mod);
  useEffect(() => {
    if (!open || m) return;
    let gone = false;
    loadPalette().then(
      (x) => {
        if (gone) return;
        if (toast.value?.kind === 'note') toast.value = null;
        setM(x);
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
  return open && m ? <m.Palette notify={notifyApi} /> : null;
}
