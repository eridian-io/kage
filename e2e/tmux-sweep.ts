/**
 * Playwright global teardown: ends any test tmux server a killed worker left behind. The
 * harness kills its own server in tearDown; this catches a worker that died first. Only
 * `kage-test-<pid>-…` sockets whose process is gone (packages/server/src/tmux/test-sockets.ts).
 */
import { sweepTestTmuxServers } from '../packages/server/src/tmux/test-sockets.ts';

export default function sweep(): void {
  const killed = sweepTestTmuxServers();
  if (killed.length > 0) {
    console.warn(`Ended ${killed.length} leftover test tmux server(s): ${killed.join(', ')}`);
  }
}
