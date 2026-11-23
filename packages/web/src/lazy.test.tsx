import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chunkUrl, lazyChunk, lazyPage } from './lazy.tsx';

/** A load that fails `fails` times, then gives `{ ok: true }`; records each retry number. */
function flaky(fails: number) {
  const tries: number[] = [];
  const load = vi.fn(async (retry: number) => {
    tries.push(retry);
    if (tries.length <= fails) throw new Error('chunk 404');
    return { ok: true };
  });
  return { load, tries };
}

let reloads: number;
beforeEach(() => {
  reloads = 0;
  sessionStorage.clear();
  vi.spyOn(lazyPage, 'reload').mockImplementation(() => {
    reloads++;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const m of document.head.querySelectorAll('meta[name^="kage-"]')) m.remove();
});

describe('lazyChunk', () => {
  it('loads once: loaded() is null until the module is in, then the module, and a second load reuses it', async () => {
    const { load } = flaky(0);
    const c = lazyChunk('t1', load);
    expect(c.loaded()).toBeNull();
    const m = await c.load();
    expect(m).toEqual({ ok: true });
    expect(c.loaded()).toBe(m);
    expect(await c.load()).toBe(m);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('two loads at once share one import', async () => {
    const { load } = flaky(0);
    const c = lazyChunk('t2', load);
    const [a, b] = await Promise.all([c.load(), c.load()]);
    expect(a).toBe(b);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('retries a failed import under a new number, and no reload when a retry gets it', async () => {
    const { load, tries } = flaky(2);
    const c = lazyChunk('t3', load);
    expect(await c.load()).toEqual({ ok: true });
    expect(tries).toEqual([0, 1, 2]);
    expect(reloads).toBe(0);
  });

  it('after its retries fail, it reloads the page once (F2); the load never settles', async () => {
    const { load, tries } = flaky(99);
    const c = lazyChunk('t4', load);
    let settled = false;
    c.load().then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.waitFor(() => expect(reloads).toBe(1));
    expect(tries).toEqual([0, 1, 2]);
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false);
  });

  it('after the reload, the same failure rejects instead of reloading again (no loop)', async () => {
    sessionStorage.setItem('kage-reloaded:t5', '1');
    const { load } = flaky(99);
    const c = lazyChunk('t5', load);
    await expect(c.load()).rejects.toThrow('chunk 404');
    expect(reloads).toBe(0);
    // A failure is forgotten: the next load tries again, under new numbers.
    const before = load.mock.calls.length;
    await expect(c.load()).rejects.toThrow('chunk 404');
    expect(load.mock.calls.length).toBe(before + 3);
    expect(load.mock.calls.at(-1)?.[0]).toBe(5);
  });

  it('a load that works clears its reload guard, so a later version skew may reload once more', async () => {
    sessionStorage.setItem('kage-reloaded:t6', '1');
    const c = lazyChunk('t6', flaky(0).load);
    await c.load();
    expect(sessionStorage.getItem('kage-reloaded:t6')).toBeNull();
  });

  it('without sessionStorage it never reloads: the failure rejects', async () => {
    vi.spyOn(lazyPage, 'storage').mockReturnValue(null);
    const c = lazyChunk('t7', flaky(99).load);
    await expect(c.load()).rejects.toThrow('chunk 404');
    expect(reloads).toBe(0);
  });
});

describe('background loads (R143)', () => {
  it('a background load that fails never reloads: it rejects quietly, and the next user open retries and reloads', async () => {
    const { load, tries } = flaky(99);
    const c = lazyChunk('b1', load);
    await expect(c.load({ reload: false })).rejects.toThrow('chunk 404');
    expect(tries).toEqual([0, 1, 2]);
    expect(reloads).toBe(0);
    expect(sessionStorage.getItem('kage-reloaded:b1')).toBeNull();
    // The user opens it: a fresh import under new numbers, then the one reload.
    void c.load();
    await vi.waitFor(() => expect(reloads).toBe(1));
    expect(tries).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('a background load that gets it serves the next user open at once', async () => {
    const c = lazyChunk('b2', flaky(1).load);
    const m = await c.load({ reload: false });
    expect(c.loaded()).toBe(m);
    expect(await c.load()).toBe(m);
    expect(reloads).toBe(0);
  });

  it('a user open that joins a pending background load still reloads if it fails, once', async () => {
    const { load, tries } = flaky(99);
    const c = lazyChunk('b3', load);
    const bg = c.load({ reload: false });
    bg.catch(() => {});
    void c.load();
    void c.load();
    await expect(bg).rejects.toThrow('chunk 404');
    await vi.waitFor(() => expect(reloads).toBe(1));
    expect(tries).toEqual([0, 1, 2]);
    await new Promise((r) => setTimeout(r, 10));
    expect(reloads).toBe(1);
  });
});

describe('chunkUrl', () => {
  it('is the kage-<name> meta plus ?r=<retry>, or null outside a build', () => {
    expect(chunkUrl('newtask', 1)).toBeNull();
    const m = document.createElement('meta');
    m.name = 'kage-newtask';
    m.content = '/newtask-ABC.js';
    document.head.append(m);
    expect(chunkUrl('newtask', 2)).toBe('/newtask-ABC.js?r=2');
  });
});
