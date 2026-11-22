import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { isStopped, ttyPrompter } from './prompt.ts';

function streams() {
  const input = new PassThrough();
  const output = new PassThrough();
  let shown = '';
  output.on('data', (c: Buffer) => {
    shown += c.toString('utf8');
  });
  return { input, output, shown: () => shown };
}

describe('ttyPrompter', () => {
  it('ask: the default in brackets, Enter takes it, an answer is trimmed', async () => {
    const s = streams();
    const p = ttyPrompter(s.input, s.output);
    const first = p.ask('Port', '8080');
    s.input.write('\n');
    expect(await first).toBe('8080');
    const second = p.ask('Port', '8080');
    s.input.write('  9090 \n');
    expect(await second).toBe('9090');
    p.close();
    expect(s.shown()).toContain('Port [8080]: ');
  });

  it('confirm: Enter takes the default, y and no are read, anything else asks again', async () => {
    const s = streams();
    const p = ttyPrompter(s.input, s.output);
    const a = p.confirm('Create ~/code?', true);
    s.input.write('\n');
    expect(await a).toBe(true);
    const b = p.confirm('Create ~/code?', true);
    s.input.write('maybe\n');
    await new Promise((r) => setTimeout(r, 20));
    s.input.write('No\n');
    expect(await b).toBe(false);
    const c = p.confirm('Keep it?', false);
    s.input.write('y\n');
    expect(await c).toBe(true);
    p.close();
    expect(s.shown()).toContain('Create ~/code? [Y/n] ');
    expect(s.shown()).toContain('Please answer y or n.');
    expect(s.shown()).toContain('Keep it? [y/N] ');
  });

  it('the end of input stops the question with an AbortError', async () => {
    const s = streams();
    const p = ttyPrompter(s.input, s.output);
    const q = p.ask('Port', '8080');
    s.input.end();
    const err = await q.catch((e: unknown) => e);
    expect(isStopped(err)).toBe(true);
    // And every later question too.
    expect(isStopped(await p.ask('Again', '').catch((e: unknown) => e))).toBe(true);
  });
});
