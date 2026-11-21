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

describe('nextStatus (spec §5.3 with R6, R6b, R7)', () => {
  it.each([
    ['session-start.json'],
    ['user-prompt-submit.json'],
    ['pre-tool-use.json'],
    ['pre-tool-use-bash.json'],
    ['post-tool-use.json'],
    ['post-tool-use-bash.json'],
    ['post-tool-use-failure.json'],
  ])('%s → running, from any status (clears needs-you)', (file) => {
    const e = fixture(file);
    for (const prev of ALL) expect(nextStatus(prev, e)).toBe('running');
  });

  it('PermissionRequest → needs-you', () => {
    const e = fixture('permission-request.json');
    expect(e.event).toBe('PermissionRequest');
    for (const prev of ALL) expect(nextStatus(prev, e)).toBe('needs-you');
  });

  it('Notification permission_prompt → needs-you (the fallback)', () => {
    const e = fixture('notification-permission.json');
    expect(e.notification).toBe('permission');
    for (const prev of ALL) expect(nextStatus(prev, e)).toBe('needs-you');
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
    for (const prev of ALL) expect(nextStatus(prev, e)).toBe('needs-you');
  });

  it('Stop → done', () => {
    const e = fixture('stop.json');
    for (const prev of ALL) expect(nextStatus(prev, e)).toBe('done');
  });

  it('SessionEnd → ended', () => {
    const e = fixture('session-end.json');
    for (const prev of ALL) expect(nextStatus(prev, e)).toBe('ended');
  });
});
