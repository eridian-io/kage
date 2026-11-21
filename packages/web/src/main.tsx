import { render } from 'preact';
import { useEffect } from 'preact/hooks';
import { PreviewPane } from './components/PreviewPane.tsx';
import { SessionList } from './components/SessionList.tsx';
import { SessionPanel } from './components/SessionPanel.tsx';
import { Toast } from './components/Toast.tsx';
import { TopBar } from './components/TopBar.tsx';
import { installKeys } from './keys.ts';
import { now, selected } from './store.ts';

const MINUTE = 60_000;

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
  return (
    <div class="k-app">
      <div class="k-board">
        <TopBar />
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
                <div class="k-empty">No sessions yet</div>
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
if (root) render(<Board />, root);
