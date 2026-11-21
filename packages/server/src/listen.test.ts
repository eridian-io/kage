import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from './config.ts';
import { ListenError, resolveListenAddress } from './listen.ts';

const base = (over: { unsafeListenAll?: boolean; ip?: string | null } = {}) => ({
  unsafeListenAll: over.unsafeListenAll ?? false,
  tailscaleIp: async () => (over.ip === undefined ? '100.64.0.9' : over.ip),
  hostname: () => 'my-pc',
});

describe('resolveListenAddress', () => {
  it('uses cfg.host when set', async () => {
    const r = await resolveListenAddress({ ...DEFAULT_CONFIG, host: '100.64.0.7' }, base());
    expect(r.address).toBe('100.64.0.7');
    expect(r.hostNames).toContain('100.64.0.7');
    expect(r.hostNames).toContain('my-pc');
  });
  it('uses tailscale ip when no host', async () => {
    const r = await resolveListenAddress({ ...DEFAULT_CONFIG, host: null }, base());
    expect(r.address).toBe('100.64.0.9');
    expect(r.hostNames).toEqual(expect.arrayContaining(['100.64.0.9', 'my-pc']));
  });
  it('throws when tailscale is not running', async () => {
    const p = resolveListenAddress({ ...DEFAULT_CONFIG, host: null }, base({ ip: null }));
    await expect(p).rejects.toBeInstanceOf(ListenError);
    await expect(p).rejects.toThrow(
      'Tailscale isn\'t running. Start it with "tailscale up", or set "host" in ~/.config/kage/config.json.',
    );
  });
  it('refuses 0.0.0.0 unless unsafeListenAll', async () => {
    const cfg = { ...DEFAULT_CONFIG, host: '0.0.0.0' };
    await expect(resolveListenAddress(cfg, base())).rejects.toBeInstanceOf(ListenError);
    const r = await resolveListenAddress(cfg, base({ unsafeListenAll: true }));
    expect(r.address).toBe('0.0.0.0');
  });
});
