import { describe, expectTypeOf, it } from 'vitest';
import type { ServerEvent } from './types.ts';

type Snapshot = Extract<ServerEvent, { type: 'snapshot' }>;

describe('protocol v2 types', () => {
  it('a snapshot requires streamId and projectsRoot', () => {
    expectTypeOf<Snapshot>().toHaveProperty('streamId').toEqualTypeOf<string>();
    expectTypeOf<Snapshot>().toHaveProperty('projectsRoot').toEqualTypeOf<string>();
    // @ts-expect-error streamId and projectsRoot are required
    const bad: Snapshot = { type: 'snapshot', host: 'h', sessions: [] };
    expectTypeOf(bad).toEqualTypeOf<Snapshot>();
  });
  it('session.lines carries id, lines and reset', () => {
    const e: ServerEvent = { type: 'session.lines', id: 'a', lines: [], reset: true };
    expectTypeOf(e.reset).toEqualTypeOf<boolean>();
  });
});
