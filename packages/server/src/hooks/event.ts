/** The hook events Kage registers (spec §5.3 with rulings R6 and R6b). */
export const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'Stop',
  'SessionEnd',
] as const;

export type HookEventName = (typeof HOOK_EVENTS)[number];

export interface HookEvent {
  event: HookEventName;
  /** The tmux pane of the `claude` process (`TMUX_PANE`), e.g. `%3`. */
  pane: string | null;
  sessionId: string;
  transcriptPath: string | null;
  cwd: string | null;
  /** Notification events only: `notification_type` mapped; null for other events. */
  notification: 'permission' | 'idle' | 'other' | null;
  message: string | null;
  toolName: string | null;
  /** `tool_input` as Claude sent it (an object), e.g. AskUserQuestion's questions. */
  toolInput: unknown | null;
  /**
   * SessionStart only: why the session started (`startup`, `resume`, `clear`, `compact`);
   * null for other events.
   */
  source: string | null;
  /** Epoch ms when Kage received it. */
  at: number;
}

/** What `kage hook` posts: the event name from argv, `TMUX_PANE`, and Claude's stdin JSON. */
export interface HookEnvelope {
  event: string;
  pane: string | null;
  payload: Record<string, unknown>;
}

const PANE = /^%\d+$/;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isEventName = (v: unknown): v is HookEventName =>
  typeof v === 'string' && (HOOK_EVENTS as readonly string[]).includes(v);

class Invalid extends Error {}

/** A string field: absent or null → null; any other non-string → invalid. */
function str(o: Record<string, unknown>, key: string): string | null {
  const v = o[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw new Invalid(key);
  return v;
}

function mapNotification(type: string | null): 'permission' | 'idle' | 'other' {
  if (type === 'permission_prompt') return 'permission';
  if (type === 'idle_prompt') return 'idle';
  return 'other';
}

/** Validates a posted envelope; null when it is not a well-formed hook event. */
export function parseHookEvent(body: unknown, at: number): HookEvent | null {
  try {
    if (!isRecord(body) || !isEventName(body.event)) return null;
    const pane = str(body, 'pane');
    if (pane !== null && !PANE.test(pane)) return null;
    const p = body.payload;
    if (!isRecord(p)) return null;
    const sessionId = str(p, 'session_id');
    if (!sessionId) return null;
    const toolInput = p.tool_input ?? null;
    if (toolInput !== null && !isRecord(toolInput)) return null;
    const type = str(p, 'notification_type');
    const source = body.event === 'SessionStart' ? str(p, 'source') : null;
    return {
      event: body.event,
      pane,
      sessionId,
      transcriptPath: str(p, 'transcript_path'),
      cwd: str(p, 'cwd'),
      notification: body.event === 'Notification' ? mapNotification(type) : null,
      message: str(p, 'message'),
      toolName: str(p, 'tool_name'),
      toolInput,
      source,
      at,
    };
  } catch (err) {
    if (err instanceof Invalid) return null;
    throw err;
  }
}
