#!/usr/bin/env node
/**
 * A stand-in for `claude` in a tmux pane, for the live e2e (no real Claude needed).
 *
 *   node e2e/fake-claude.mjs <scenario>      scenarios: edit-and-test, needs-permission
 *
 * It behaves the way docs/specs/claude-code-integration.md records Claude Code 2.1.330: every
 * hook goes through the real `kage hook <Event>` CLI (so TMUX_PANE and KAGE_SOCKET come from the
 * pane's environment), the transcript is a JSONL file in Claude's record format, and the
 * permission prompt is drawn like the recorded fixture panes/permission-bash.txt, with its footer
 * as the last non-blank line. All content is invented.
 *
 * After the turn's Stop it stays at an idle input box, as Claude does: `q`, Ctrl+C or Ctrl+D
 * fires SessionEnd and exits. For needs-permission it waits at the prompt for a digit: `1` runs
 * the command, `4` (No) or Esc writes the rejection records and fires no hook (ruling R11).
 *
 * Environment: FAKE_CLAUDE_DIR (where the transcript goes; default a new temp dir) and
 * FAKE_CLAUDE_STEP_MS (the pause between steps; default 600).
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const KAGE = join(dirname(fileURLToPath(import.meta.url)), '../packages/server/src/main.ts');
const STEP_MS = Number(process.env.FAKE_CLAUDE_STEP_MS) || 600;
const scenario = process.argv[2] ?? '';
if (scenario !== 'edit-and-test' && scenario !== 'needs-permission') {
  process.stderr.write('Usage: fake-claude.mjs edit-and-test|needs-permission\n');
  process.exit(2);
}

const cwd = process.cwd();
const sessionId = randomUUID();
const dir = process.env.FAKE_CLAUDE_DIR || mkdtempSync(join(tmpdir(), 'fake-claude-'));
mkdirSync(dir, { recursive: true });
const transcript = join(dir, `${sessionId}.jsonl`);
writeFileSync(transcript, '');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = () => sleep(STEP_MS);
const width = () => Math.max(40, Math.min(process.stdout.columns || 80, 120));
const out = (text = '') => process.stdout.write(`${text}\n`);

// ------------------------------------------------------------------ hooks

/** Runs `kage hook <event>` with Claude's JSON on stdin, and waits for it, as Claude does. */
function hook(event, extra = {}) {
  const body = {
    session_id: sessionId,
    transcript_path: transcript,
    cwd,
    hook_event_name: event,
    ...extra,
  };
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--no-warnings', KAGE, 'hook', event], {
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    child.once('error', () => resolve());
    child.once('exit', () => resolve());
    child.stdin.end(JSON.stringify(body));
  });
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

const say = (text, stop) => assistant([{ type: 'text', text }], stop);

function toolUse(id, name, input) {
  assistant([{ type: 'tool_use', id, name, input, caller: { type: 'direct' } }]);
}

function toolResult(id, content, toolUseResult, extra = {}) {
  append({
    type: 'user',
    message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content }] },
    toolUseResult,
    ...extra,
  });
}

const turnOver = (ms) =>
  append({ type: 'system', subtype: 'turn_duration', durationMs: ms, isMeta: false });

// ------------------------------------------------------------------ the pane

const rule = (ch = '─') => ch.repeat(width());

function banner() {
  out(' ▐▛███▜▌   Claude Code v2.1.330');
  out('▝▜█████▛▘  Opus 5.5 · Claude Pro');
  out(`  ▘▘ ▝▝    ${cwd}`);
  out();
}

function idleBox() {
  out();
  out(rule());
  out('❯ ');
  out(rule());
  out('  ? for shortcuts');
}

/** The Bash permission prompt, laid out like the recorded fixture; the footer comes last. */
function bashPrompt(command, description) {
  out(rule());
  out(' Bash command');
  out(` ${description}`);
  out(rule('╌'));
  out(` ${command}`);
  out(rule('╌'));
  out(' This command requires approval');
  out();
  out(' Do you want to proceed?');
  out(' ❯ 1. Yes');
  out(`   2. Yes, and don’t ask again for: ${command} *`);
  out('   3. Yes, and switch to auto mode · auto mode handles these prompts for you');
  out('   4. No');
  out();
  process.stdout.write(' Esc to cancel · Tab to amend\n');
}

const clear = () => process.stdout.write('\x1b[2J\x1b[3J\x1b[H');

// ------------------------------------------------------------------ keys

const keys = [];
let keyWaiter = null;
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.on('data', (chunk) => {
  for (const ch of chunk.toString('utf8')) keys.push(ch);
  if (keyWaiter) {
    const w = keyWaiter;
    keyWaiter = null;
    w();
  }
});
process.stdin.on('end', () => {
  keys.push('\x04');
  keyWaiter?.();
});

/** The next key that `accept` takes; other keys are ignored. */
async function nextKey(accept) {
  for (;;) {
    while (keys.length > 0) {
      const k = keys.shift();
      if (accept(k)) return k;
    }
    await new Promise((r) => {
      keyWaiter = r;
    });
  }
}

/** Idle at the input box until q, Ctrl+C or Ctrl+D; then SessionEnd and exit. */
async function idleThenExit() {
  idleBox();
  await nextKey((k) => k === 'q' || k === '\x03' || k === '\x04');
  clear();
  out('Resume this session with:');
  out(`claude --resume ${sessionId}`);
  await hook('SessionEnd', { reason: 'prompt_input_exit' });
  process.exit(0);
}

// ------------------------------------------------------------------ scenarios

async function editAndTest() {
  const prompt = 'Make greet() say hello in lowercase, then run the tests';
  out(`❯ ${prompt}`);
  out();
  userText(prompt);
  await hook('UserPromptSubmit', { prompt });
  await step();

  say("I'll update greet() and run the tests.");
  out("● I'll update greet() and run the tests.");
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
  out(`● Bash(${command})`);
  out('  ⎿  Running…');
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
  for (const line of output) out(`  ⎿  ${line}`);
  await step();
}

async function finish(text) {
  say(text, 'end_turn');
  out(`● ${text}`);
  await step();
  turnOver(STEP_MS * 6);
  out();
  out('✻ Baked for 4s');
  await hook('Stop', { stop_hook_active: false, last_assistant_message: text });
}

async function needsPermission() {
  const prompt = 'Clear the build cache';
  out(`❯ ${prompt}`);
  out();
  userText(prompt);
  await hook('UserPromptSubmit', { prompt });
  await step();

  say("I'll run the clean script.");
  out("● I'll run the clean script.");
  await step();

  const id = 'toolu_fake_clean';
  const input = { command: 'npm run clean', description: 'Remove the build output' };
  toolUse(id, 'Bash', input);
  await hook('PreToolUse', { tool_name: 'Bash', tool_input: input, tool_use_id: id });
  out(`● Bash(${input.command})`);
  out('  ⎿  Waiting…');
  bashPrompt(input.command, input.description);
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

  const key = await nextKey(
    (k) => k === '1' || k === '2' || k === '3' || k === '4' || k === '\x1b',
  );
  clear();
  banner();
  out(`❯ ${prompt}`);
  out();
  out("● I'll run the clean script.");
  out(`● Bash(${input.command})`);
  if (key === '4' || key === '\x1b') {
    // R11: no hook fires after No or Esc; only the transcript and the pane show it.
    toolResult(
      id,
      "The user doesn't want to proceed with this tool use. The tool use was rejected. STOP.",
      'User rejected tool use',
      { toolDenialKind: 'user-rejected', toolDenialBeforeRun: true },
    );
    append({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }],
      },
    });
    out('  ⎿  Interrupted · What should Claude do instead?');
    return;
  }
  out('  ⎿  Running…');
  await step();
  await commandDone(id, input, ['Removed .cache/build']);
  await finish('The build cache is cleared.');
}

banner();
await hook('SessionStart', { source: 'startup', model: 'claude-opus-5-5' });
if (scenario === 'edit-and-test') await editAndTest();
else await needsPermission();
await idleThenExit();
