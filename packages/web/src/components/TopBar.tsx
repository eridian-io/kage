import { authRequired, hadSnapshot, host, sorted } from '../store.ts';

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
      <span class="k-k">⌘K</span>
    </div>
  );
}
