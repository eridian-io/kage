import { demoSessions } from '@kage/shared';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * New task as a lazy chunk (performance P6). Each test takes fresh modules, so the chunk starts
 * unloaded; the NewTask module answers only once the test opens `gate`.
 */
const g = vi.hoisted(() => ({ gate: Promise.resolve(), open: () => {} }));
vi.mock('./NewTask.tsx', async (importOriginal) => {
  await g.gate;
  return importOriginal();
});

const NOW = Date.UTC(2026, 10, 21, 12, 0, 0);
const PROJECTS = { projects: [{ name: 'api', defaultBranch: 'main', branches: ['main'] }] };

async function fresh() {
  vi.resetModules();
  const { Board } = await import('../main.tsx');
  const store = await import('../store.ts');
  const lazy = await import('../lazy.tsx');
  store.applyEvent({
    type: 'snapshot',
    auth: false,
    host: 'my-pc',
    streamId: 's',
    projectsRoot: '/p',
    archived: 0,
    sessions: demoSessions(NOW),
  });
  return { Board, store, lazy };
}

const press = (key: string) => fireEvent.keyDown(document.body, { key });

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(PROJECTS), { status: 200 })),
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  g.gate = Promise.resolve();
});

describe('New task, loaded on demand', () => {
  it('N after the idle prefetch shows the form at once; before the chunk loads, Loading…', async () => {
    g.gate = new Promise((r) => {
      g.open = r;
    });
    const { Board, store } = await fresh();
    const { container } = render(<Board />);
    press('n');
    // The first press opens it: a quiet "Loading…" in the form's place, holding the focus.
    const box = container.querySelector<HTMLElement>('.k-side .k-nt-loading');
    expect(box?.textContent).toBe('Loading…');
    expect(box?.querySelector('[role="status"]')).not.toBeNull();
    expect(document.activeElement).toBe(box);
    expect(container.querySelector('.k-side > .k-new')).toBeNull();
    // Esc closes it while it loads, and focus goes back to the button.
    press('Escape');
    expect(store.newTaskOpen.value).toBe(false);
    expect(document.activeElement).toBe(container.querySelector('.k-side > .k-new'));
    press('n');
    expect(container.querySelector('.k-nt-loading')).not.toBeNull();
    g.open();
    await waitFor(() => expect(container.querySelector('form.k-nt')).not.toBeNull());
    expect(container.querySelector('.k-nt-loading')).toBeNull();
    // The form takes the focus from the loading box (its effect runs after the paint).
    await waitFor(() =>
      expect(document.activeElement).toBe(container.querySelector('.k-nt textarea')),
    );
  });

  it('the chunk is prefetched on idle after the first snapshot, so N never shows Loading…', async () => {
    vi.resetModules();
    const lazy = await import('../lazy.tsx');
    const store = await import('../store.ts');
    const { Board } = await import('../main.tsx');
    const idle: (() => void)[] = [];
    const w = Object.assign(Object.create(window) as Window, {
      requestIdleCallback: (cb: () => void) => idle.push(cb),
      cancelIdleCallback: () => {},
    });
    const stop = lazy.installLazy(w);
    try {
      expect(idle).toHaveLength(0);
      store.applyEvent({
        type: 'snapshot',
        auth: false,
        host: 'my-pc',
        streamId: 's',
        projectsRoot: '/p',
        archived: 0,
        sessions: demoSessions(NOW),
      });
      expect(idle).toHaveLength(1);
      expect(lazy.newTaskChunk.loaded()).toBeNull();
      idle[0]?.();
      await lazy.newTaskChunk.load();
      const { container } = render(<Board />);
      press('n');
      expect(container.querySelector('.k-nt-loading')).toBeNull();
      expect(container.querySelector('form.k-nt')).not.toBeNull();
      // A second snapshot (a reconnect) asks for nothing again.
      store.applyEvent({
        type: 'snapshot',
        auth: false,
        host: 'my-pc',
        streamId: 's2',
        projectsRoot: '/p',
        archived: 0,
        sessions: demoSessions(NOW),
      });
      expect(idle).toHaveLength(1);
    } finally {
      stop();
    }
  });

  it('a chunk that still fails after the reload says so in place, and Esc closes it', async () => {
    vi.doMock('./NewTask.tsx', () => {
      throw new Error('404');
    });
    sessionStorage.setItem('kage-reloaded:newtask', '1');
    const { Board, store } = await fresh();
    const { container } = render(<Board />);
    press('n');
    await waitFor(() =>
      expect(container.querySelector('.k-nt-loading [role="alert"]')?.textContent).toBe(
        "Couldn't open New task. Reload the page to try again.",
      ),
    );
    press('Escape');
    expect(store.newTaskOpen.value).toBe(false);
    sessionStorage.clear();
    vi.doUnmock('./NewTask.tsx');
  });
});
