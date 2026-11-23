import { loadPalette } from '../palette-loader.tsx';
import { isMac, paletteHint } from '../platform.ts';
import { authRequired, demo, hadSnapshot, host, paletteOpen, sorted } from '../store.ts';

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
  const hint = paletteHint();
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
          {/* The demo says so (U6): a quiet grey outline like the ended chip, beside the pill. */}
          {demo.value && <span class="k-demo">demo</span>}
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
      {/* The target's hint, as a button with its look (board.css resets it); the key per platform (R97). */}
      <button
        type="button"
        class="k-k"
        aria-label="Command palette"
        aria-keyshortcuts={isMac() ? 'Meta+K' : 'Control+K'}
        title={`Command palette (${hint})`}
        onPointerEnter={prefetch}
        onFocus={prefetch}
        onClick={() => {
          paletteOpen.value = !paletteOpen.value;
        }}
      >
        {hint}
      </button>
    </div>
  );
}
