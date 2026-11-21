import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasTmux, TmuxClient } from '../tmux/client.ts';
import { type ControlTarget, SessionControls } from './actions.ts';

/**
 * SessionControls against real tmux (private socket) and a tiny scripted TUI drawn like the
 * recorded panes: a permission prompt, the trust screen and Claude's idle input box. The TUI logs
 * what it receives, so the tests see exactly which keys arrived. Never real Claude.
 */

const sock = `kage-test-${randomBytes(4).toString('hex')}`;
const tmp = mkdtempSync(join(tmpdir(), 'kage-actions-'));
const TUI = join(tmp, 'tui.mjs');

writeFileSync(
  TUI,
  `
import { appendFileSync } from 'node:fs';
const [mode, log] = process.argv.slice(2);
const W = 80;
const rule = '─'.repeat(W);
const out = (s) => process.stdout.write(s);
let screen = mode;
let typed = '';
let trustAt = 0;
const TRUST = ['No, exit', 'Yes, I trust this folder'];
const note = (s) => appendFileSync(log, s + '\\n');
function draw() {
  out('\\x1b[2J\\x1b[H');
  if (screen === 'prompt') {
    out(['● Bash(npm test)', rule, ' Bash command', '', '   npm test', '', ' Do you want to proceed?',
      ' ❯ 1. Yes', '   2. Yes, and don’t ask again for: npm test *', '   3. No', '',
      ' Esc to cancel · Tab to amend'].join('\\r\\n'));
  } else if (screen === 'trust') {
    out([rule, ' Accessing workspace:', '', ' /home/dev/projects/notes', '',
      ' Quick safety check: Is this a project you created or one you trust?', '',
      ...TRUST.map((t, i) => (i === trustAt ? ' ❯ ' : '   ') + t), '',
      ' Enter to confirm · Esc to cancel'].join('\\r\\n'));
  } else {
    out(['● Done.', '', rule, '❯\\u00a0' + typed, rule, '  ⏸ manual mode on · ? for shortcuts'].join('\\r\\n'));
  }
}
process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  if (screen === 'prompt') {
    if (d === '\\x1b') { note('escape'); screen = 'idle'; }
    else note('prompt-key:' + JSON.stringify(d));
    if (/^[1-3]$/.test(d)) screen = 'idle';
  } else if (screen === 'trust') {
    if (d === '\\x1b[B') trustAt = (trustAt + 1) % 2;
    else if (d === '\\x1b[A') trustAt = (trustAt + 1) % 2;
    else if (d === '\\r') { note('trust:' + TRUST[trustAt]); screen = 'idle'; }
    else note('trust-key:' + JSON.stringify(d));
  } else {
    if (d === '\\r') { note('submit:' + typed); typed = ''; }
    else if (d.startsWith('\\x1b')) note('idle-key:' + JSON.stringify(d));
    else typed += d;
  }
  draw();
});
draw();
`,
);

afterAll(() => {
  try {
    execFileSync('tmux', ['-L', sock, 'kill-server'], { stdio: 'ignore' });
  } catch {
    // no server, or no tmux: nothing to clean up
  }
  rmSync(tmp, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.runIf(hasTmux)('SessionControls (real tmux, scripted TUI)', () => {
  const client = new TmuxClient({
    session: 'kage',
    socket: sock,
    configFile: '/dev/null',
    launchCheckMs: 100,
  });

  beforeAll(async () => {
    await client.ensureSession();
  });

  /** Opens the TUI in a tagged window and waits until its first screen is drawn. */
  async function open(mode: 'prompt' | 'trust' | 'idle') {
    const kageId = randomUUID();
    const log = join(tmp, `${kageId}.log`);
    writeFileSync(log, '');
    const { windowId, paneId } = await client.newWindow({
      name: mode,
      cwd: tmp,
      env: {},
      argv: [process.execPath, TUI, mode, log],
      kageId,
    });
    execFileSync('tmux', [
      '-f',
      '/dev/null',
      '-L',
      sock,
      'resize-window',
      '-t',
      windowId,
      '-x',
      '80',
      '-y',
      '30',
    ]);
    // The screen's last line, so the first capture never sees a half-drawn screen.
    const last = { prompt: 'Esc to cancel', trust: 'Enter to confirm', idle: 'for shortcuts' }[
      mode
    ];
    for (let i = 0; i < 50 && !(await client.capturePane(paneId, 50)).includes(last); i++) {
      await sleep(100);
    }
    const marks: string[] = [];
    const t: ControlTarget = {
      id: kageId,
      kageId,
      windowId,
      paneId,
      status: mode === 'idle' ? 'done' : 'needs-you',
      question:
        mode === 'prompt'
          ? {
              text: 'Do you want to proceed?',
              options: ['Yes', 'Yes, and don’t ask again for: npm test *', 'No'],
            }
          : mode === 'trust'
            ? {
                text: 'Trust this folder?',
                options: ['No, exit', 'Yes, I trust this folder'],
                startup: true,
              }
            : null,
      promptKind: mode === 'prompt' ? 'permission' : mode === 'trust' ? 'trust' : null,
      multiSelect: false,
      external: false,
    };
    const controls = new SessionControls({
      tmux: client,
      source: {
        target: (id) => (id === kageId ? { ...t } : null),
        markAnswered: (id) => marks.push(`answered ${id}`),
        markReplying: () => {},
        markReplied: (id) => marks.push(`replied ${id}`),
        markStopped: (id) => marks.push(`stopped ${id}`),
      },
    });
    const received = async (n: number) => {
      for (let i = 0; i < 50; i++) {
        const lines = readFileSync(log, 'utf8').split('\n').filter(Boolean);
        if (lines.length >= n) return lines;
        await sleep(100);
      }
      return readFileSync(log, 'utf8').split('\n').filter(Boolean);
    };
    return { kageId, windowId, paneId, controls, marks, received, t };
  }

  it('answer 1 at a permission prompt: the TUI receives exactly "1", no Enter', async () => {
    const s = await open('prompt');
    await s.controls.answer(s.kageId, 1, s.t.question?.text ?? '');
    expect(await s.received(1)).toEqual(['prompt-key:"1"']);
    await sleep(300);
    expect(await s.received(1)).toEqual(['prompt-key:"1"']);
    expect(s.marks).toEqual([`answered ${s.kageId}`]);
  });

  it('trust option 2: Down, verified, then Enter picks "Yes, I trust this folder"', async () => {
    const s = await open('trust');
    await s.controls.answer(s.kageId, 2, s.t.question?.text ?? '');
    expect(await s.received(1)).toEqual(['trust:Yes, I trust this folder']);
  });

  it('reply at a prompt: Escape, the box returns, the text, then Enter submits it verbatim', async () => {
    const s = await open('prompt');
    const text = 'use the other script; not $(rm -rf ~) or `id`';
    await s.controls.reply(s.kageId, text);
    expect(await s.received(2)).toEqual(['escape', `submit:${text}`]);
    expect(s.marks).toEqual([`replied ${s.kageId}`]);
  });

  it('reply at done: a long reply arrives whole in one burst', async () => {
    const s = await open('idle');
    const text = `${'word '.repeat(150)}end`;
    await s.controls.reply(s.kageId, text);
    expect(await s.received(1)).toEqual([`submit:${text}`]);
  });

  it('stop kills the owned window; another tag is refused and the window stays', async () => {
    const s = await open('idle');
    await s.controls.stop(s.kageId);
    expect(s.marks).toEqual([`stopped ${s.kageId}`]);
    const ids = execFileSync(
      'tmux',
      ['-f', '/dev/null', '-L', sock, 'list-windows', '-a', '-F', '#{window_id}'],
      {
        encoding: 'utf8',
      },
    );
    expect(ids.split('\n')).not.toContain(s.windowId);

    const other = await open('idle');
    await client.setKageId(other.windowId as string, randomUUID());
    await expect(other.controls.stop(other.kageId)).rejects.toMatchObject({ status: 403 });
    expect(await client.windowKageId(other.windowId as string)).not.toBeNull();
    expect(existsSync(TUI)).toBe(true);
  });
});
