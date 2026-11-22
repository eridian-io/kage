/** The demo clock: Date.UTC(2026, 10, 21, 14, 32), the moment the design target shows. */
export const DEMO_NOW = 1795271520000;
export const PORT = 4391;
export const BASE = `http://127.0.0.1:${PORT}`;
/** The environment every demo server in the e2e specs runs with. */
export const SERVER_ENV = {
  KAGE_DEMO_NOW: String(DEMO_NOW),
  KAGE_HOST: '127.0.0.1',
  KAGE_NAME: 'my-pc',
};

/** Restores the six demo sessions on the server at `base` (controller ruling R3). */
export async function resetDemo(base = BASE): Promise<void> {
  const res = await fetch(`${base}/api/demo/reset`, {
    method: 'POST',
    headers: { 'X-Kage': '1', Origin: base },
  });
  if (res.status !== 204) throw new Error(`Demo reset failed: ${res.status} ${await res.text()}`);
}

/** The live e2e's `kage serve` (real tmux); KAGE_E2E_LIVE_PORT overrides it on a dev box. */
export const LIVE_PORT = Number(process.env.KAGE_E2E_LIVE_PORT) || 4393;
export const LIVE_BASE = `http://127.0.0.1:${LIVE_PORT}`;

/** The perf project's `kage serve` (e2e/perf.spec.ts); KAGE_E2E_PERF_PORT overrides it. */
export const PERF_PORT = Number(process.env.KAGE_E2E_PERF_PORT) || 4395;
export const PERF_BASE = `http://127.0.0.1:${PERF_PORT}`;
