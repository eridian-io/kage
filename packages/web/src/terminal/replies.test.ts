import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountTerminal } from './index.ts';

/**
 * The real xterm (it runs in happy-dom for this): tmux, the pane's real terminal, already answers
 * the program's queries, so xterm must not answer the copies that arrive in forwarded output and
 * send its replies as input (they would land in the pane as typed text).
 */
class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static all: FakeSocket[] = [];
  readyState = 0;
  binaryType = 'blob';
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  constructor() {
    FakeSocket.all.push(this);
  }
  send(s: string) {
    this.sent.push(s);
  }
  close() {
    this.readyState = 3;
  }
}
class FakeObserver {
  observe() {}
  disconnect() {}
}

const handles: { dispose(): void }[] = [];
const enc = new TextEncoder();
/** Attached read-write, then `out` arrives as pane output; resolves once xterm has parsed it. */
async function outputThenInput(out: string): Promise<string[]> {
  const el = document.createElement('div');
  document.body.append(el);
  handles.push(mountTerminal(el, { id: 'web', onEnd: () => {} }));
  const s = FakeSocket.all.at(-1) as FakeSocket;
  s.readyState = 1;
  s.onopen?.();
  s.onmessage?.({ data: JSON.stringify({ t: 'reset', cols: 80, rows: 24, mode: 'rw' }) });
  s.onmessage?.({ data: enc.encode(out).buffer });
  await new Promise((r) => setTimeout(r, 50));
  return s.sent.filter((f) => f.startsWith('{"t":"in"'));
}

beforeEach(() => {
  FakeSocket.all = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('ResizeObserver', FakeObserver);
});
afterEach(() => {
  for (const h of handles.splice(0)) h.dispose();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('terminal queries in forwarded output', () => {
  it('a DA query (primary and secondary) gets no reply from xterm', async () => {
    expect(await outputThenInput('hello\x1b[c\x1b[0c\x1b[>c')).toEqual([]);
  });

  it('DSR (status and cursor position) and DECRQM get no reply', async () => {
    expect(await outputThenInput('\x1b[5n\x1b[6n\x1b[?6n\x1b[?2004$p\x1b[4$p')).toEqual([]);
  });

  it('OSC 10, 11, 12 and 4 colour queries get no reply; XTVERSION and DECRQSS neither', async () => {
    const ST = '\x1b\\';
    const q = `\x1b]10;?\x07\x1b]11;?${ST}\x1b]12;?\x07\x1b]4;1;?\x07\x1b[>q\x1bP$qm${ST}`;
    expect(await outputThenInput(q)).toEqual([]);
  });

  it('output that sets colours still applies, and plain text is no input', async () => {
    expect(await outputThenInput('\x1b]11;#101010\x07plain text')).toEqual([]);
  });
});
