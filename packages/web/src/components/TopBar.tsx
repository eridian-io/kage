import { loadPalette } from '../palette-loader.tsx';
import { authRequired, hadSnapshot, host, paletteOpen, sorted } from '../store.ts';

const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
/** Fetches the palette's chunk ahead of a click (ruling B1: on the hint's hover, never at load). */
const prefetch = () => {
  loadPalette().catch(() => {});
};

export function TopBar() {
  // Signed out: the logo and wordmark only.
  if (authRequired.value) {
    return (
      <div class="k-top">
        <span class="k-logo">
          <img class="klogo" alt="" src="/kage-logo-96.png" />
          kage
        </span>
      </div>
    );
  }
  const list = sorted.value;
  const waiting = list.filter((s) => s.status === 'needs-you').length;
  const running = list.filter((s) => s.status === 'running').length;
  return (
    <div class="k-top">
      <span class="k-logo">
        <img class="klogo" alt="" src="/kage-logo-96.png" />
        kage
      </span>
      {/* Before the first snapshot nothing is known: no host pill, no "0 sessions", no counts. */}
      {hadSnapshot.value && (
        <>
          <span class="k-host">
            <i class="dot d-run" />
            {host.value} · {list.length} {list.length === 1 ? 'session' : 'sessions'}
          </span>
          <span class="k-counts">
            <span>
              <i class="dot d-wait" />
              {waiting} needs you
            </span>
            <span>
              <i class="dot d-run" />
              {running} running
            </span>
          </span>
        </>
      )}
      <span class="sp" />
      {/* The target's hint, as a button: the same text and pixels (board.css resets it). */}
      <button
        type="button"
        class="k-k"
        aria-label="Command palette"
        title={MAC ? undefined : 'Ctrl+K'}
        onPointerEnter={prefetch}
        onFocus={prefetch}
        onClick={() => {
          paletteOpen.value = !paletteOpen.value;
        }}
      >
        ⌘K
      </button>
    </div>
  );
}
