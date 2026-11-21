import { describe, expect, expectTypeOf, it } from 'vitest';
import { LIMITS, type Question, type ServerEvent, type Session } from './types.ts';

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

describe('protocol v3 types', () => {
  it('session.ports and session.files carry their payloads', () => {
    const p: ServerEvent = { type: 'session.ports', id: 'a', ports: [] };
    const f: ServerEvent = { type: 'session.files', id: 'a', files: [], filesTotal: 0 };
    expect([p.type, f.type]).toEqual(['session.ports', 'session.files']);
    expectTypeOf<Session>().toHaveProperty('filesTotal').toEqualTypeOf<number>();
    expectTypeOf<Question>().toHaveProperty('startup').toEqualTypeOf<boolean | undefined>();
  });
  it('LIMITS has the agreed values', () => {
    expect(LIMITS).toEqual({
      taskChars: 4000,
      replyChars: 4000,
      questionChars: 500,
      textBytes: 12_000,
      files: 100,
      projects: 200,
      branches: 200,
    });
  });
});
