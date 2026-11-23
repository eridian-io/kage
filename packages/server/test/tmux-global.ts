/**
 * vitest global setup: ends the private tmux servers a test run left behind (a worker killed
 * before its teardown), before this run and after it. Only `kage-test-<pid>-…` sockets whose
 * process is gone, or this run's own (src/tmux/test-sockets.ts); never any other tmux server.
 */
import { sweepTestTmuxServers } from '../src/tmux/test-sockets.ts';

function report(killed: string[]): void {
  if (killed.length > 0) {
    console.warn(`Ended ${killed.length} leftover test tmux server(s): ${killed.join(', ')}`);
  }
}

export function setup(): void {
  report(sweepTestTmuxServers());
}

export function teardown(): void {
  report(sweepTestTmuxServers({ also: process.pid }));
}
