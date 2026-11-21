import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionStatus } from '@kage/shared';
import { describe, expect, it } from 'vitest';
import { type HookEventName, parseHookEvent } from './event.ts';
import { nextStatus } from './status.ts';

const FIXTURES = join(import.meta.dirname, '../../test/fixtures/hooks');

function fixture(file: string) {
  const payload = JSON.parse(readFileSync(join(FIXTURES, file), 'utf8'));
  const e = parseHookEvent(
    { event: payload.hook_event_name as HookEventName, pane: '%3', payload },
    1000,
  );
  if (!e) throw new Error(`fixture ${file} did not parse`);
  return e;
}

const ALL: (SessionStatus | undefined)[] = [undefined, 'running', 'needs-you', 'done', 'ended'];
const LIVE: (SessionStatus | undefined)[] = [undefined, 'running', 'needs-you', 'done'];

describe('nextStatus (spec §5.3 with R6, R6b, R7, R12)', () => {
  it.each([
    ['user-prompt-submit.json'],
    ['pre-tool-use.json'],
    ['pre-tool-use-bash.json'],
    ['post-tool-use.json'],
    ['post-tool-use-bash.json'],
    ['post-tool-use-failure.json'],
  ])('%s → running from any live status (clears needs-you)', (file) => {
    const e = fixture(file);
    for (const prev of LIVE) expect(nextStatus(prev, e)).toBe('running');
  });

  it('SessionStart → running from any status, ended included (a resumed session)', () => {
    const e = fixture('session-start.json');
    for (const prev of ALL) expect(nextStatus(prev, e)).toBe('running');
  });

  it('PermissionRequest → needs-you', () => {
    const e = fixture('permission-request.json');
    expect(e.event).toBe('PermissionRequest');
    for (const prev of LIVE) expect(nextStatus(prev, e)).toBe('needs-you');
  });

  it('Notification permission_prompt → needs-you (the fallback) while unknown or running', () => {
    const e = fixture('notification-permission.json');
    expect(e.notification).toBe('permission');
    for (const prev of [undefined, 'running', 'needs-you'] as const) {
      expect(nextStatus(prev, e)).toBe('needs-you');
    }
  });

  it('a late Notification permission_prompt leaves done and ended alone (R12)', () => {
    const e = fixture('notification-permission.json');
    expect(nextStatus('done', e)).toBe('done');
    expect(nextStatus('ended', e)).toBe('ended');
  });

  it('Notification idle_prompt → unchanged (a done session stays done)', () => {
    const e = fixture('notification-idle.json');
    expect(e.notification).toBe('idle');
    for (const prev of ALL) expect(nextStatus(prev, e)).toBe(prev);
  });

  it('Notification of another kind → unchanged', () => {
    const e = { ...fixture('notification-idle.json'), notification: 'other' as const };
    for (const prev of ALL) expect(nextStatus(prev, e)).toBe(prev);
  });

  it('PreToolUse AskUserQuestion → needs-you', () => {
    const e = fixture('pre-tool-use-ask-question.json');
    expect(e.toolName).toBe('AskUserQuestion');
    for (const prev of LIVE) expect(nextStatus(prev, e)).toBe('needs-you');
  });

  it('Stop → done', () => {
    const e = fixture('stop.json');
    for (const prev of LIVE) expect(nextStatus(prev, e)).toBe('done');
  });

  it('SessionEnd → ended', () => {
    const e = fixture('session-end.json');
    for (const prev of ALL) expect(nextStatus(prev, e)).toBe('ended');
  });

  it.each([
    ['user-prompt-submit.json'],
    ['pre-tool-use.json'],
    ['pre-tool-use-ask-question.json'],
    ['permission-request.json'],
    ['post-tool-use.json'],
    ['post-tool-use-failure.json'],
    ['notification-permission.json'],
    ['notification-idle.json'],
    ['stop.json'],
    ['session-end.json'],
  ])('ended is terminal: %s keeps it ended', (file) => {
    expect(nextStatus('ended', fixture(file))).toBe('ended');
  });
});
