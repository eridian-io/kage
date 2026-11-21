import type { SessionStatus } from '@kage/shared';
import type { HookEvent } from './event.ts';

/**
 * The status after a hook event (spec §5.3, rulings R6, R6b, R7 and R12).
 * PermissionRequest is the primary needs-you trigger, Notification(permission) the fallback,
 * and AskUserQuestion is seen on its PreToolUse. Any other in-turn event means running,
 * which also clears needs-you. Idle and other notifications leave the status as it is, and
 * so does a late permission Notification once the turn is done. Ended is terminal; only a
 * SessionStart (a resumed session) brings it back to running.
 */
export function nextStatus(
  prev: SessionStatus | undefined,
  e: HookEvent,
): SessionStatus | undefined {
  if (prev === 'ended') return e.event === 'SessionStart' ? 'running' : 'ended';
  switch (e.event) {
    case 'PermissionRequest':
      return 'needs-you';
    case 'Notification':
      return e.notification === 'permission' && prev !== 'done' ? 'needs-you' : prev;
    case 'PreToolUse':
      return e.toolName === 'AskUserQuestion' ? 'needs-you' : 'running';
    case 'SessionStart':
    case 'UserPromptSubmit':
    case 'PostToolUse':
    case 'PostToolUseFailure':
      return 'running';
    case 'Stop':
      return 'done';
    case 'SessionEnd':
      return 'ended';
  }
}
