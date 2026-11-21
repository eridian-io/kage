import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  LIMITS,
  type Question,
  type ServerEvent,
  type Session,
  TERM_CLOSE,
  TERM_PROTOCOL,
  type TermClientMsg,
  type TermServerMsg,
} from './types.ts';

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
      archived: 200,
      diffLines: 1000,
      diffBytes: 524_288,
      diffLineChars: 2000,
      termInputBytes: 65_536,
      termMinCols: 20,
      termMaxCols: 500,
      termMinRows: 5,
      termMaxRows: 200,
      terminals: 8,
      terminalsPerPane: 3,
    });
  });
});

describe('protocol v4 types', () => {
  it('a snapshot carries the archive count and archive events the new count', () => {
    expectTypeOf<Snapshot>().toHaveProperty('archived').toEqualTypeOf<number>();
    const e: ServerEvent = { type: 'archive', count: 2 };
    expect(e.type).toBe('archive');
    expectTypeOf<Session>().toHaveProperty('uncommitted').toEqualTypeOf<number>();
  });
  it('the terminal protocol names and close codes are fixed', () => {
    expect(TERM_PROTOCOL).toBe('kage.term.v1');
    expect(TERM_CLOSE).toEqual({
      gone: 4404,
      ended: 4409,
      forbidden: 4403,
      tooMany: 4429,
      demo: 4501,
    });
    const s: TermServerMsg = { t: 'reset', cols: 80, rows: 24, mode: 'ro' };
    const c: TermClientMsg = { t: 'in', d: 'x' };
    expect([s.t, c.t]).toEqual(['reset', 'in']);
  });
  it('LIMITS gained the phase 4 values', () => {
    expect(LIMITS).toMatchObject({
      archived: 200,
      diffLines: 1000,
      diffBytes: 524_288,
      diffLineChars: 2000,
      termInputBytes: 65_536,
      termMinCols: 20,
      termMaxCols: 500,
      termMinRows: 5,
      termMaxRows: 200,
      terminals: 8,
      terminalsPerPane: 3,
    });
  });
});
