/**
 * Setup's questions (phase 6, Task 5): a line of text with a default, or yes or no. Enter takes
 * the default. Ctrl+C or the end of input during a question stops setup: the question rejects
 * with an AbortError. Ctrl+C between questions (while setup looks something up) exits 130 at
 * once. After close(), the terminal is back to normal and Ctrl+C is the process's own SIGINT,
 * which ends it. A question after close() opens the terminal again (setup's "Did it arrive?",
 * asked once the service answers); close() it again after.
 */
import { createInterface, type Interface } from 'node:readline/promises';

export interface Prompter {
  /** Shows `<question> [<def>]: ` and returns the answer, trimmed, or `def` for an empty one. */
  ask(question: string, def: string): Promise<string>;
  /** Shows `<question> [Y/n] ` (or `[y/N]`) until the answer is empty, yes or no. */
  confirm(question: string, def: boolean): Promise<boolean>;
  /** Waits for Enter, showing nothing more; setup falls back to ask() without it. */
  pause?(): Promise<void>;
  /** Called after the last question; a scripted Prompter needn't have one. */
  close?(): void;
}

/** True when a prompter's question was cut short by Ctrl+C or the end of input. */
export function isStopped(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

/** A Prompter over a terminal with node:readline/promises; `exit` and `terminal` are test seams. */
export function ttyPrompter(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  opts: { exit?: (code: number) => void; terminal?: boolean } = {},
): Prompter & { close(): void } {
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  let rl: Interface | null = null;
  /** Interfaces closed by close(), not by the end of input: they don't stop later questions. */
  const closedByUs = new WeakSet<Interface>();
  let pending = 0;
  const stop = new AbortController();
  const open = (): Interface => {
    if (rl === null) {
      const r = createInterface({
        input,
        output,
        ...(opts.terminal !== undefined ? { terminal: opts.terminal } : {}),
      });
      rl = r;
      r.on('SIGINT', () => {
        output.write('\n');
        if (pending > 0) {
          stop.abort();
          return;
        }
        // No question to cut short, so nothing would see an abort: stop now.
        output.write('Setup stopped.\n');
        r.close();
        exit(130);
      });
      r.on('close', () => {
        if (!closedByUs.has(r)) stop.abort();
      });
    }
    return rl;
  };
  const line = async (text: string): Promise<string> => {
    if (stop.signal.aborted) throw new DOMException('Setup stopped.', 'AbortError');
    pending++;
    try {
      return (await open().question(text, { signal: stop.signal })).trim();
    } finally {
      pending--;
    }
  };
  return {
    async ask(question, def) {
      const answer = await line(def === '' ? `${question}: ` : `${question} [${def}]: `);
      return answer === '' ? def : answer;
    },
    async confirm(question, def) {
      for (;;) {
        const answer = (await line(`${question} ${def ? '[Y/n]' : '[y/N]'} `)).toLowerCase();
        if (answer === '') return def;
        if (answer === 'y' || answer === 'yes') return true;
        if (answer === 'n' || answer === 'no') return false;
        output.write('Please answer y or n.\n');
      }
    },
    async pause() {
      await line('');
    },
    close() {
      if (rl === null) return;
      closedByUs.add(rl);
      rl.close();
      rl = null;
    },
  };
}
