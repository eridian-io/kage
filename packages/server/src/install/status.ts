/**
 * The client half of `GET /status` (phase 6, Task 4): asks the running `kage serve` over its hook
 * socket, so `kage status`, setup's final check and `kage doctor` need neither the token nor the
 * network.
 */
import { request } from 'node:http';
import type { ServerStatus } from '../hooks/server.ts';

const MAX_ANSWER = 64 * 1024;

function isStatus(v: unknown): v is ServerStatus {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Record<string, unknown>;
  const count = (n: unknown) => typeof n === 'number' && Number.isInteger(n) && n >= 0;
  return (
    typeof s.version === 'string' &&
    typeof s.url === 'string' &&
    count(s.sessions) &&
    count(s.needsYou) &&
    count(s.pid)
  );
}

/** The server's status over the socket; null when nothing answers in time, or not with a status. */
export function fetchStatus(socket: string, timeoutMs = 1000): Promise<ServerStatus | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: ServerStatus | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    const req = request({ socketPath: socket, path: '/status', method: 'GET' }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        done(null);
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_ANSWER) done(null);
        else chunks.push(c);
      });
      res.on('end', () => {
        try {
          const v: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          done(
            isStatus(v)
              ? {
                  version: v.version,
                  url: v.url,
                  sessions: v.sessions,
                  needsYou: v.needsYou,
                  pid: v.pid,
                }
              : null,
          );
        } catch {
          done(null);
        }
      });
      res.on('error', () => done(null));
    });
    req.on('error', () => done(null));
    req.end();
  });
}
