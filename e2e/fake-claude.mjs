#!/usr/bin/env node
/**
 * A stand-in for `claude` in a tmux pane, for the live e2e (no real Claude needed).
 *
 *   fake-claude.mjs --settings <file> --permission-mode <mode> [--] <task>   as Kage starts claude
 *   fake-claude.mjs <scenario>                                              the phase 2 form
 *
 * Scenarios: edit-and-test, needs-permission and trust-first. In Claude's form the scenario is
 * the task's first word when it names one, else edit-and-test, and the task is the first prompt.
 * The argv is written as JSON to $FAKE_CLAUDE_DIR/argv-<sessionId>.json, and every key received
 * to keys-<sessionId>.json (typed runs joined as "text:…"), so a test can check both.
 *
 * It behaves the way docs/specs/claude-code-integration.md records Claude Code 2.1.330:
 * - Hooks run the commands of the `--settings` file through `sh -c` with Claude's JSON on stdin,
 *   as Claude does (the phase 2 form runs `kage hook <Event>` directly). TMUX_PANE and
 *   KAGE_SOCKET come from the pane's environment.
 * - The transcript is a JSONL file in Claude's record format.
 * - The conversation is appended, and only the live region at the bottom is redrawn in place:
 *   the permission prompt (panes/permission-bash.txt, its footer the last line), the folder-trust
 *   screen (panes/trust.txt, `❯ No, exit` first) or the input box (`❯` and a no-break space, its
 *   footer reading `esc to interrupt` while a turn runs).
 *
 * Keys:
 * - At the input box, printable keys go into the box; Enter on a non-empty box runs a follow-up
 *   turn (a user record, UserPromptSubmit, the line `You said: <text>`, Stop). `/exit` then Enter,
 *   Ctrl+C or Ctrl+D fires SessionEnd and exits.
 * - At the permission prompt, `1` or `2` runs the command; `4` (No) or Escape writes the denial
 *   records and the interrupt line, fires no hook (ruling R11) and returns to the input box.
 * - On the trust screen, Down and Up move `❯` (wrapping); Enter on `Yes, I trust this folder`
 *   goes on as edit-and-test, Enter on `No, exit` or Escape exits with no hook.
 *
 * All content is invented. Environment: FAKE_CLAUDE_DIR (where the transcript and the argv and
 * keys files go; default a new temp dir) and FAKE_CLAUDE_STEP_MS (the pause between steps;
 * default 600).
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const KAGE = join(dirname(fileURLToPath(import.meta.url)), '../packages/server/src/main.ts');
const STEP_MS = Number(process.env.FAKE_CLAUDE_STEP_MS) || 600;
const SCENARIOS = new Set(['edit-and-test', 'needs-permission', 'trust-first']);
const DEFAULT_PROMPT = {
  'edit-and-test': 'Make greet() say hello in lowercase, then run the tests',
  'needs-permission': 'Clear the build cache',
};

// ------------------------------------------------------------------ arguments

const argv = process.argv.slice(2);
let settingsPath = null;
let task = null;
let scenario;
if (argv.length === 1 && !argv[0].startsWith('-')) {
  scenario = argv[0];
  if (!SCENARIOS.has(scenario)) {
    process.stderr.write('Usage: fake-claude.mjs edit-and-test|needs-permission|trust-first\n');
    process.exit(2);
  }
} else {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--settings') settingsPath = argv[++i] ?? null;
    else if (a === '--permission-mode') i++;
    else if (a === '--') {
      task = argv.slice(i + 1).join(' ');
      break;
    } else if (a.startsWith('-')) {
      process.stderr.write(`fake-claude: unknown option ${a}\n`);
      process.exit(2);
    } else {
      task = argv.slice(i).join(' ');
      break;
    }
  }
  if (!task) {
    process.stderr.write('Usage: fake-claude.mjs --settings <f> --permission-mode <m> -- <task>\n');
    process.exit(2);
  }
  const first = task.trim().split(/\s+/)[0];
  scenario = SCENARIOS.has(first) ? first : 'edit-and-test';
}
const turnScenario = scenario === 'trust-first' ? 'edit-and-test' : scenario;
const firstPrompt = task ?? DEFAULT_PROMPT[turnScenario];

const cwd = process.cwd();
const sessionId = randomUUID();
const dir = process.env.FAKE_CLAUDE_DIR || mkdtempSync(join(tmpdir(), 'fake-claude-'));
mkdirSync(dir, { recursive: true });
const transcript = join(dir, `${sessionId}.jsonl`);
writeFileSync(transcript, '');
writeFileSync(join(dir, `argv-${sessionId}.json`), JSON.stringify(argv));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = () => sleep(STEP_MS);

// ------------------------------------------------------------------ hooks

/** The hook commands the settings file registers for `event`; null without a settings file. */
function hookCommands(event) {
  if (!settingsPath) return null;
  try {
    const groups = JSON.parse(readFileSync(settingsPath, 'utf8')).hooks?.[event] ?? [];
    return groups.flatMap((g) => (g.hooks ?? []).map((h) => h.command));
  } catch {
    return [];
  }
}

function runHook(file, args, body) {
  return new Promise((resolve) => {
    const child = spawn(file, args, { stdio: ['pipe', 'ignore', 'ignore'] });
    child.once('error', () => resolve());
    child.once('exit', () => resolve());
    child.stdin.on('error', () => {});
    child.stdin.end(body);
  });
}

/** Runs the event's hooks with Claude's JSON on stdin, one after another, and waits for them. */
async function hook(event, extra = {}) {
  const body = JSON.stringify({
    session_id: sessionId,
    transcript_path: transcript,
    cwd,
    hook_event_name: event,
    ...extra,
  });
  const commands = hookCommands(event);
  if (commands === null) {
    await runHook(process.execPath, ['--no-warnings', KAGE, 'hook', event], body);
    return;
  }
  for (const command of commands) await runHook('/bin/sh', ['-c', command], body);
}

// ------------------------------------------------------------------ transcript

let parent = null;
let msg = 0;

function append(record) {
  const uuid = randomUUID();
  const full = {
    parentUuid: parent,
    isSidechain: false,
    ...record,
    uuid,
    timestamp: new Date().toISOString(),
    userType: 'external',
    entrypoint: 'cli',
    cwd,
    sessionId,
    version: '2.1.330',
  };
  parent = uuid;
  appendFileSync(transcript, `${JSON.stringify(full)}\n`);
}

const userText = (text) => append({ type: 'user', message: { role: 'user', content: text } });

function assistant(content, stop = 'tool_use') {
  msg++;
  append({
    type: 'assistant',
    message: {
      model: 'claude-opus-5-5',
      id: `msg_fake_${String(msg).padStart(4, '0')}`,
      type: 'message',
      role: 'assistant',
      content,
      stop_reason: stop,
      stop_sequence: null,
      usage: { input_tokens: 2, output_tokens: 40 },
    },
  });
}

const sayRecord = (text, stop) => assistant([{ type: 'text', text }], stop);

function toolUse(id, name, input) {
  assistant([{ type: 'tool_use', id, name, input, caller: { type: 'direct' } }]);
}

function toolResult(id, content, toolUseResult, extra = {}, isError = false) {
  const result = { tool_use_id: id, type: 'tool_result', content };
  if (isError) result.is_error = true;
  append({
    type: 'user',
    message: { role: 'user', content: [result] },
    toolUseResult,
    ...extra,
  });
}

const turnOver = (ms) =>
  append({ type: 'system', subtype: 'turn_duration', durationMs: ms, isMeta: false });

// ------------------------------------------------------------------ the pane

const columns = () => Math.max(40, Math.min(process.stdout.columns || 80, 200));
const rule = (ch = '─') => ch.repeat(columns());
/** Screen rows a line takes (a line of exactly the pane's width takes one). */
const rowsOf = (line) => Math.max(1, Math.ceil([...line].length / columns()));

/** The live region's lines and how many screen rows they take now. */
let live = [];
let liveRows = 0;

/**
 * Erases the live region, appends `lines` to the conversation above it and draws `next` as the
 * new live region, in one write (the cursor rests at the end of its last line).
 */
function draw(next, lines = []) {
  let s = '';
  if (liveRows > 0) s += `\r${liveRows > 1 ? `\x1b[${liveRows - 1}A` : ''}\x1b[J`;
  for (const l of lines) s += `${l}\r\n`;
  s += next.join('\r\n');
  live = next;
  liveRows = next.reduce((n, l) => n + rowsOf(l), 0);
  process.stdout.write(s);
}

/** Appends conversation lines; the live region stays under them. */
const out = (...lines) => draw(live, lines);

const banner = () => [
  ' ▐▛███▜▌   Claude Code v2.1.330',
  '▝▜█████▛▘  Opus 5.5 · Claude Pro',
  `  ▘▘ ▝▝    ${cwd}`,
  '',
];

/** The input box (integration §7): `❯` and a no-break space, its footer under the bottom rule. */
function box(text, busy, status = []) {
  return [
    ...status,
    '',
    rule(),
    `❯ ${text}`,
    rule(),
    busy ? '  ⏸ manual mode on · esc to interrupt' : '  ⏸ manual mode on · ? for shortcuts',
  ];
}
const working = (status = []) => box('', true, status);

/** The Bash permission prompt, laid out like the recorded fixture; the footer comes last. */
function bashPrompt(command, description) {
  return [
    '  ⎿  Waiting…',
    '',
    rule(),
    ' Bash command',
    ` ${description}`,
    rule('╌'),
    ` ${command}`,
    rule('╌'),
    ' This command requires approval',
    '',
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    `   2. Yes, and don’t ask again for: ${command} *`,
    '   3. Yes, and switch to auto mode · auto mode handles these prompts for you',
    '   4. No',
    '',
    ' Esc to cancel · Tab to amend',
  ];
}

const TRUST = ['No, exit', 'Yes, I trust this folder'];

/** The folder-trust screen as panes/trust.txt recorded it, with `❯` on option `at`. */
function trustScreen(at) {
  return [
    '',
    rule(),
    ' Accessing workspace:',
    '',
    ` ${cwd}`,
    '',
    ' Quick safety check: Is this a project you created or one you trust? (Like your',
    ' own code, a well-known open source project, or work from your team). If not,',
    " take a moment to review what's in this folder first.",
    '',
    " Claude Code'll be able to read, edit, and execute files here.",
    '',
    ' Security guide',
    '',
    ...TRUST.map((t, i) => (i === at ? ` ❯ ${t}` : `   ${t}`)),
    '',
    ' Enter to confirm · Esc to cancel',
  ];
}

// ------------------------------------------------------------------ keys

const ARROWS = { A: 'Up', B: 'Down', C: 'Right', D: 'Left' };
const NAMED = { '\r': 'Enter', '\n': 'Enter', '\x7f': 'Backspace', '\x03': 'C-c', '\x04': 'C-d' };

/** A chunk of input as keys: named keys, arrows (CSI or SS3), a lone Escape, or characters. */
function tokens(s) {
  const keys = [];
  for (let i = 0; i < s.length; ) {
    if (s[i] === '\x1b') {
      // CSI (ESC [ B) or SS3 (ESC O B); a lone ESC is the Escape key.
      const arrow = (s[i + 1] === '[' || s[i + 1] === 'O') && ARROWS[s[i + 2]];
      if (arrow) {
        keys.push(arrow);
        i += 3;
      } else {
        keys.push('Escape');
        i++;
      }
      continue;
    }
    const ch = String.fromCodePoint(s.codePointAt(i));
    keys.push(NAMED[ch] ?? ch);
    i += ch.length;
  }
  return keys;
}

const isNamed = (k) => k.length > 1 && /^[A-Z]/.test(k);

/** Every key received, typed runs joined, written out after each chunk. */
const received = [];
const keysFile = join(dir, `keys-${sessionId}.json`);
function logKeys(keys) {
  for (const k of keys) {
    const last = received.at(-1);
    if (!isNamed(k) && last?.startsWith('text:')) received[received.length - 1] = last + k;
    else received.push(isNamed(k) ? k : `text:${k}`);
  }
  writeFileSync(keysFile, JSON.stringify(received));
}

const queue = [];
let keyWaiter = null;
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.on('data', (chunk) => {
  const keys = tokens(chunk.toString('utf8'));
  logKeys(keys);
  queue.push(...keys);
  if (keyWaiter) {
    const w = keyWaiter;
    keyWaiter = null;
    w();
  }
});
process.stdin.on('end', () => {
  queue.push('C-d');
  keyWaiter?.();
});

/** The next key that `accept` takes; other keys are dropped. */
async function nextKey(accept) {
  for (;;) {
    while (queue.length > 0) {
      const k = queue.shift();
      if (accept(k)) return k;
    }
    await new Promise((r) => {
      keyWaiter = r;
    });
  }
}

// ------------------------------------------------------------------ turns

async function exitSession() {
  draw([], ['', 'Resume this session with:', `claude --resume ${sessionId}`]);
  await hook('SessionEnd', { reason: 'prompt_input_exit' });
  process.exit(0);
}

/** At the input box: type, follow up, or exit. Never returns. */
async function idle() {
  let text = '';
  draw(box('', false));
  for (;;) {
    const k = await nextKey(() => true);
    if (k === 'C-c' || k === 'C-d') await exitSession();
    if (k === 'Enter') {
      const sent = text.trim();
      if (sent === '') continue;
      text = '';
      if (sent === '/exit') await exitSession();
      await followUp(sent);
      draw(box('', false));
    } else if (k === 'Backspace') {
      text = [...text].slice(0, -1).join('');
      draw(box(text, false));
    } else if (!isNamed(k) && k >= ' ') {
      text += k;
      draw(box(text, false));
    }
  }
}

/** A turn starts: the prompt joins the conversation and Claude works on it. */
async function begin(prompt) {
  draw(working(), [`❯ ${prompt}`, '']);
  userText(prompt);
  await hook('UserPromptSubmit', { prompt });
  await step();
}

function say(text) {
  sayRecord(text);
  out(`● ${text}`);
}

/** The turn's last words; the box is idle again before the Stop hook, as in Claude. */
async function finish(text) {
  sayRecord(text, 'end_turn');
  out(`● ${text}`);
  await step();
  turnOver(STEP_MS * 6);
  draw(box('', false), ['', '✻ Baked for 4s']);
  await hook('Stop', { stop_hook_active: false, last_assistant_message: text });
}

async function followUp(text) {
  await begin(text);
  await finish(`You said: ${text}`);
}

async function editAndTest(prompt) {
  await begin(prompt);
  say("I'll update greet() and run the tests.");
  await step();

  const file = join(cwd, 'src/greet.js');
  const edit = {
    file_path: file,
    old_string: "  return 'Hello, ' + name;",
    new_string: "  return 'hello, ' + name;",
    replace_all: false,
  };
  toolUse('toolu_fake_edit', 'Edit', edit);
  await hook('PreToolUse', { tool_name: 'Edit', tool_input: edit, tool_use_id: 'toolu_fake_edit' });
  out('● Update(src/greet.js)');
  await step();
  toolResult('toolu_fake_edit', `The file ${file} has been updated successfully.`, {
    filePath: file,
    oldString: edit.old_string,
    newString: edit.new_string,
    structuredPatch: [
      {
        oldStart: 1,
        oldLines: 3,
        newStart: 1,
        newLines: 3,
        lines: [
          ' export function greet(name) {',
          "-  return 'Hello, ' + name;",
          "+  return 'hello, ' + name;",
          ' }',
        ],
      },
    ],
  });
  await hook('PostToolUse', {
    tool_name: 'Edit',
    tool_input: edit,
    tool_use_id: 'toolu_fake_edit',
  });
  out('  ⎿  Added 1 line, removed 1 line');
  await step();

  await runCommand('toolu_fake_test', 'npm test', 'Run the tests', [
    'PASS test/greet.test.js',
    'Tests: 2 passed, 2 total',
  ]);

  await finish('greet() now says hello in lowercase, and both tests pass.');
}

async function runCommand(id, command, description, output) {
  const input = { command, description };
  toolUse(id, 'Bash', input);
  await hook('PreToolUse', { tool_name: 'Bash', tool_input: input, tool_use_id: id });
  draw(working(['  ⎿  Running…']), [`● Bash(${command})`]);
  await step();
  await commandDone(id, input, output);
}

async function commandDone(id, input, output) {
  toolResult(id, output.join('\n'), {
    stdout: output.join('\n'),
    stderr: '',
    interrupted: false,
    isImage: false,
    noOutputExpected: false,
  });
  await hook('PostToolUse', {
    tool_name: 'Bash',
    tool_input: input,
    tool_use_id: id,
    tool_response: { stdout: output.join('\n'), stderr: '', interrupted: false },
  });
  draw(
    working(),
    output.map((line) => `  ⎿  ${line}`),
  );
  await step();
}

async function needsPermission(prompt) {
  await begin(prompt);
  say("I'll run the clean script.");
  await step();

  const id = 'toolu_fake_clean';
  const input = { command: 'npm run clean', description: 'Remove the build output' };
  toolUse(id, 'Bash', input);
  await hook('PreToolUse', { tool_name: 'Bash', tool_input: input, tool_use_id: id });
  draw(bashPrompt(input.command, input.description), [`● Bash(${input.command})`]);
  await hook('PermissionRequest', {
    tool_name: 'Bash',
    tool_input: input,
    permission_mode: 'default',
    permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
  });
  await hook('Notification', {
    message: 'Claude needs your permission',
    notification_type: 'permission_prompt',
  });

  const key = await nextKey((k) => ['1', '2', '3', '4', 'Escape'].includes(k));
  if (key === '4' || key === 'Escape') {
    // R11: no hook fires after No or Esc; only the transcript and the pane show it.
    toolResult(
      id,
      "The user doesn't want to proceed with this tool use. The tool use was rejected. STOP.",
      'User rejected tool use',
      { toolDenialKind: 'user-rejected', toolDenialBeforeRun: true },
      true,
    );
    append({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }],
      },
    });
    draw(box('', false), ['  ⎿  Interrupted · What should Claude do instead?']);
    return;
  }
  draw(working(['  ⎿  Running…']));
  await step();
  await commandDone(id, input, ['Removed .cache/build']);
  await finish('The build cache is cleared.');
}

/** The folder-trust screen, before SessionStart; returns once trusted, exits on No or Escape. */
async function trust() {
  let at = 0;
  draw(trustScreen(at));
  for (;;) {
    const k = await nextKey((key) => ['Up', 'Down', 'Enter', 'Escape'].includes(key));
    if (k === 'Up' || k === 'Down') {
      at = (at + 1) % TRUST.length;
      draw(trustScreen(at));
    } else if (k === 'Escape' || at === 0) {
      draw([]);
      process.exit(0);
    } else {
      draw([]);
      return;
    }
  }
}

if (scenario === 'trust-first') await trust();
draw(box('', false), banner());
await hook('SessionStart', { source: 'startup', model: 'claude-opus-5-5' });
if (turnScenario === 'needs-permission') await needsPermission(firstPrompt);
else await editAndTest(firstPrompt);
await idle();
