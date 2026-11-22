/**
 * Setup's questions (phase 6, Task 5): a line of text with a default, or yes or no. Enter takes
 * the default. Ctrl+C or the end of input stops setup (the pending question rejects with an
 * AbortError).
 */
import { createInterface, type Interface } from 'node:readline/promises';

export interface Prompter {
  /** Shows `<question> [<def>]: ` and returns the answer, trimmed, or `def` for an empty one. */
  ask(question: string, def: string): Promise<string>;
  /** Shows `<question> [Y/n] ` (or `[y/N]`) until the answer is empty, yes or no. */
  confirm(question: string, def: boolean): Promise<boolean>;
}

/** True when a prompter's question was cut short by Ctrl+C or the end of input. */
export function isStopped(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

/** A Prompter over a terminal with node:readline/promises; close() when done. */
export function ttyPrompter(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): Prompter & { close(): void } {
  let rl: Interface | null = null;
  const stop = new AbortController();
  const open = (): Interface => {
    if (rl === null) {
      rl = createInterface({ input, output });
      rl.on('SIGINT', () => {
        output.write('\n');
        stop.abort();
      });
      rl.on('close', () => stop.abort());
    }
    return rl;
  };
  const line = async (text: string): Promise<string> => {
    if (stop.signal.aborted) throw new DOMException('Setup stopped.', 'AbortError');
    return (await open().question(text, { signal: stop.signal })).trim();
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
    close() {
      rl?.close();
    },
  };
}
