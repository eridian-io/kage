import { render } from 'preact';
import { useEffect } from 'preact/hooks';
import { Login } from './components/Login.tsx';
import { PreviewPane } from './components/PreviewPane.tsx';
import { SessionList } from './components/SessionList.tsx';
import { SessionPanel } from './components/SessionPanel.tsx';
import { Toast } from './components/Toast.tsx';
import { TopBar } from './components/TopBar.tsx';
import { installKeys } from './keys.ts';
import { connect } from './sse.ts';
import {
  authRequired,
  connection,
  hadSnapshot,
  host,
  newTaskOpen,
  now,
  selected,
} from './store.ts';
import { installView } from './view.ts';

const MINUTE = 60_000;

/**
 * Shown whenever the stream is down, except during the very first attempt: before any snapshot
 * it says "Connecting to Kage…", after one "Reconnecting to <host>…".
 */
/** The middle column with no sessions (spec §6.5): what Kage does, and the way to start. */
function Empty() {
  return (
    <div class="k-empty">
      <h2 class="k-empty-t">No sessions yet</h2>
      <p>Start a task: Kage makes a git worktree and branch for it and runs Claude there.</p>
      {!newTaskOpen.value && (
        <button
          class="k-new"
          type="button"
          onClick={() => {
            newTaskOpen.value = true;
          }}
        >
          ＋ New task
        </button>
      )}
    </div>
  );
}

function ReconnectBar() {
  const c = connection.value;
  if (c === 'live' || (c === 'connecting' && !hadSnapshot.value)) return null;
  return (
    <div class="k-reconnect" role="status">
      {hadSnapshot.value ? <>Reconnecting to {host.value}…</> : 'Connecting to Kage…'}
    </div>
  );
}

export function Board() {
  useEffect(() => {
    now.value = Date.now();
    const tick = setInterval(() => {
      now.value = Date.now();
    }, MINUTE);
    const uninstall = installKeys(document);
    return () => {
      clearInterval(tick);
      uninstall();
    };
  }, []);
  const s = selected.value;
  if (authRequired.value) {
    return (
      <div class="k-app">
        <div class="k-board">
          <TopBar />
          <div class="k-b">
            <Login />
          </div>
        </div>
      </div>
    );
  }
  return (
    <div class="k-app">
      <div class="k-board">
        <TopBar />
        <ReconnectBar />
        <div class="k-b">
          <SessionList />
          {s ? (
            <>
              <SessionPanel session={s} />
              <PreviewPane session={s} />
            </>
          ) : (
            <>
              <main class="k-main">
                <Toast />
                {/* Before the first snapshot the board knows nothing yet: neutral, not empty. */}
                {hadSnapshot.value && <Empty />}
              </main>
              <aside class="k-aside" />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

const root = typeof document !== 'undefined' ? document.getElementById('app') : null;
if (root) {
  render(<Board />, root);
  installView();
  connect();
}
