import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type SessionRecord, StateStore } from './store.ts';

const rec = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  kageId: 'k-1',
  windowId: '@3',
  project: 'shop',
  task: 'Fix the cart total',
  branch: 'kage/fix-the-cart-total',
  worktree: '/home/dev/src/shop/.worktrees/fix-the-cart-total',
  createdAt: 1_700_000_000_000,
  pinned: false,
  archived: false,
  sessionId: null,
  transcriptPath: null,
  base: 'main',
  permissionMode: 'default',
  ...over,
});

describe('StateStore', () => {
  let dir: string;
  let path: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kage-store-'));
    path = join(dir, 'kage', 'state.json');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('loads [] when the file is missing', async () => {
    expect(await new StateStore(path).load()).toEqual([]);
  });

  it('round-trips records through save and load', async () => {
    const records = [
      rec(),
      rec({ kageId: 'k-2', windowId: null, sessionId: 's', transcriptPath: '/t.jsonl' }),
    ];
    await new StateStore(path).save(records);
    expect(await new StateStore(path).load()).toEqual(records);
  });

  it('a crash between the temp write and the rename leaves the old file intact', async () => {
    const store = new StateStore(path);
    await store.save([rec()]);
    // Simulate the crash: only the temp file of a later save was written.
    await writeFile(`${path}.tmp`, '{"version":1,"records":[{"half":');
    expect(await store.load()).toEqual([rec()]);
    // The next save still works and replaces the leftover.
    await store.save([rec({ task: 'Later' })]);
    expect((await store.load())[0]?.task).toBe('Later');
  });

  it('a corrupt file loads [] and is renamed state.json.corrupt-<time>', async () => {
    const store = new StateStore(path);
    await store.save([rec()]);
    await writeFile(path, '{ not json');
    expect(await store.load()).toEqual([]);
    const files = await readdir(join(dir, 'kage'));
    const corrupt = files.filter((f) => /^state\.json\.corrupt-\d+$/.test(f));
    expect(corrupt).toHaveLength(1);
    expect(files).not.toContain('state.json');
    expect(await readFile(join(dir, 'kage', corrupt[0] as string), 'utf8')).toBe('{ not json');
  });

  it('a file of the wrong shape counts as corrupt', async () => {
    const store = new StateStore(path);
    await store.save([]);
    await writeFile(path, '[1,2,3]');
    expect(await store.load()).toEqual([]);
    expect(
      (await readdir(join(dir, 'kage'))).some((f) => f.startsWith('state.json.corrupt-')),
    ).toBe(true);
  });

  it('skips single malformed records and keeps the rest', async () => {
    const store = new StateStore(path);
    await store.save([rec()]);
    const good = JSON.parse(await readFile(path, 'utf8'));
    good.records.push({ kageId: 7 }, null);
    await writeFile(path, JSON.stringify(good));
    expect(await store.load()).toEqual([rec()]);
  });

  it('loads a phase 2 record (no base or permissionMode) with null and "default"', async () => {
    const { base: _b, permissionMode: _p, ...phase2 } = rec();
    const store = new StateStore(path);
    await store.save([]);
    await writeFile(path, JSON.stringify({ version: 1, records: [phase2] }));
    expect(await store.load()).toEqual([rec({ base: null, permissionMode: 'default' })]);
  });

  it('round-trips base and permissionMode, and skips a record with an unknown mode', async () => {
    const store = new StateStore(path);
    await store.save([rec({ kageId: 'k-2', base: 'develop', permissionMode: 'acceptEdits' })]);
    expect(await store.load()).toEqual([
      rec({ kageId: 'k-2', base: 'develop', permissionMode: 'acceptEdits' }),
    ]);
    const data = JSON.parse(await readFile(path, 'utf8'));
    data.records.push({ ...data.records[0], kageId: 'k-3', permissionMode: 'bypassPermissions' });
    await writeFile(path, JSON.stringify(data));
    expect((await store.load()).map((r) => r.kageId)).toEqual(['k-2']);
  });

  it('serialises concurrent saves: the last one wins', async () => {
    const store = new StateStore(path);
    await Promise.all([
      store.save([rec({ task: 'a' })]),
      store.save([rec({ task: 'b' })]),
      store.save([rec({ task: 'c' })]),
    ]);
    expect((await store.load())[0]?.task).toBe('c');
  });
});
