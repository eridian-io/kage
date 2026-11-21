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
  it.each(['', '::0', '0:0:0:0:0:0:0:0', '::ffff:0.0.0.0', '0.0.0.0', '::', '[::]'])(
    'refuses unspecified spelling %j',
    async (host) => {
      const cfg = { ...DEFAULT_CONFIG, host };
      await expect(resolveListenAddress(cfg, base())).rejects.toBeInstanceOf(ListenError);
      await expect(
        resolveListenAddress(cfg, base({ unsafeListenAll: true })),
      ).resolves.toBeDefined();
    },
  );
  it.each(['100.64.0.7', '127.0.0.1', '::1', 'fd7a:115c:a1e0::1'])('allows %s', async (host) => {
    const r = await resolveListenAddress({ ...DEFAULT_CONFIG, host }, base());
    expect(r.address).toBe(host);
  });
  it.each(['192.168.1.10', '8.8.8.8', '100.128.0.1', 'fe80::1'])(
    'refuses non-Tailscale %s unless unsafe',
    async (host) => {
      const cfg = { ...DEFAULT_CONFIG, host };
      await expect(resolveListenAddress(cfg, base())).rejects.toThrow(
        `${host} isn't a Tailscale address. Kage only listens on Tailscale or loopback; pass --unsafe-listen-all to override.`,
      );
      expect((await resolveListenAddress(cfg, base({ unsafeListenAll: true }))).address).toBe(host);
    },
  );
  it('resolves a name once and binds the Tailscale IP', async () => {
    const lookup = async () => [
      { address: 'fd7a:115c:a1e0::5', family: 6 },
      { address: '100.101.102.103', family: 4 },
    ];
    const r = await resolveListenAddress(
      { ...DEFAULT_CONFIG, host: 'box.tail.ts.net' },
      { ...base(), lookup },
    );
    expect(r.address).toBe('100.101.102.103');
    expect(r.hostNames).toEqual(
      expect.arrayContaining(['box.tail.ts.net', '100.101.102.103', 'my-pc']),
    );
  });
  it('refuses a name resolving outside Tailscale', async () => {
    const lookup = async () => [{ address: '10.0.0.5', family: 4 }];
    const cfg = { ...DEFAULT_CONFIG, host: 'lan.example' };
    await expect(resolveListenAddress(cfg, { ...base(), lookup })).rejects.toBeInstanceOf(
      ListenError,
    );
    const r = await resolveListenAddress(cfg, { ...base({ unsafeListenAll: true }), lookup });
    expect(r.address).toBe('10.0.0.5');
  });
});
