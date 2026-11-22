import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from './config.ts';
import {
  displayHost,
  ListenError,
  resolveListenAddress,
  shortHostname,
  tailscaleDnsName,
} from './listen.ts';
import { hostGuard } from './security.ts';

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

describe('host names people type', () => {
  it('accepts the short hostname and cfg.name next to the full os.hostname()', async () => {
    const r = await resolveListenAddress(
      { ...DEFAULT_CONFIG, host: null, name: 'studio' },
      { ...base(), hostname: () => 'Box.local' },
    );
    expect(r.hostNames).toEqual(
      expect.arrayContaining(['100.64.0.9', 'Box.local', 'box', 'studio']),
    );
  });
  it('lets the short name through the host guard', async () => {
    const r = await resolveListenAddress(
      { ...DEFAULT_CONFIG, host: null },
      { ...base(), hostname: () => 'Box.local' },
    );
    const app = new Hono();
    app.use('*', hostGuard({ hostNames: r.hostNames, port: 8080 }));
    app.get('/', (c) => c.text('ok'));
    const res = await app.request('/', { headers: { Host: 'box:8080' } });
    expect(res.status).toBe(200);
  });
});

describe('shortHostname', () => {
  it.each([
    ['Box.local', 'box'],
    ['my-pc', 'my-pc'],
    ['WORK.corp.example', 'work'],
  ])('%s → %s', (full, short) => {
    expect(shortHostname(full)).toBe(short);
  });
});

describe('displayHost', () => {
  const cfg = (over: Partial<typeof DEFAULT_CONFIG>) => ({ ...DEFAULT_CONFIG, ...over });
  it('prints the configured host name', () => {
    expect(
      displayHost(cfg({ host: 'box.tail.ts.net', name: 'box' }), '100.64.0.7', 'Box.local'),
    ).toBe('box.tail.ts.net');
  });
  it('prints cfg.name for a Tailscale bind, never the .local name', () => {
    expect(displayHost(cfg({ host: null, name: 'studio' }), '100.64.0.9', 'Box.local')).toBe(
      'studio',
    );
    expect(
      displayHost(cfg({ host: '100.64.0.7', name: 'studio' }), '100.64.0.7', 'Box.local'),
    ).toBe('studio');
    expect(
      displayHost(cfg({ host: 'fd7a:115c:a1e0::1', name: 'studio' }), 'fd7a:115c:a1e0::1', 'x'),
    ).toBe('studio');
  });
  it('falls back to the short hostname when cfg.name is not a host name', () => {
    expect(displayHost(cfg({ host: null, name: 'My Box' }), '100.64.0.9', 'Box.local')).toBe('box');
  });
  it('prints the IP for a loopback bind', () => {
    expect(displayHost(cfg({ host: '127.0.0.1', name: 'studio' }), '127.0.0.1', 'Box.local')).toBe(
      '127.0.0.1',
    );
    expect(displayHost(cfg({ host: '::1', name: 'studio' }), '::1', 'Box.local')).toBe('[::1]');
  });
});

describe('tailscaleDnsName (B1)', () => {
  const status = (self: unknown) => async () => JSON.stringify({ Version: '1.90.0', Self: self });
  it('reads Self.DNSName and drops the trailing dot', async () => {
    const exec = vi.fn(status({ DNSName: 'box.tail1234.ts.net.', HostName: 'box' }));
    expect(await tailscaleDnsName(exec)).toBe('box.tail1234.ts.net');
    expect(exec).toHaveBeenCalledWith('tailscale', ['status', '--json']);
  });
  it.each([
    ['a failing command', async () => Promise.reject(new Error('not running'))],
    ['invalid JSON', async () => 'Tailscale is stopped.'],
    ['no Self', async () => '{}'],
    ['a non-string DNSName', status({ DNSName: 7 })],
    ['an empty DNSName', status({ DNSName: '' })],
    ['a DNSName that is not a host name', status({ DNSName: 'bad name.ts.net.' })],
  ])('is null on %s', async (_label, exec) => {
    expect(await tailscaleDnsName(exec as () => Promise<string>)).toBeNull();
  });
});

describe('MagicDNS name in hostNames (B1)', () => {
  const dns = async () => 'box.tail1234.ts.net';
  it('is added for a Tailscale bind, auto-detected or configured', async () => {
    const auto = await resolveListenAddress(
      { ...DEFAULT_CONFIG, host: null },
      { ...base(), tailscaleDnsName: dns },
    );
    expect(auto.hostNames).toContain('box.tail1234.ts.net');
    const set = await resolveListenAddress(
      { ...DEFAULT_CONFIG, host: '100.64.0.7' },
      { ...base(), tailscaleDnsName: dns },
    );
    expect(set.hostNames).toContain('box.tail1234.ts.net');
  });
  it('is not asked for or added for a loopback bind', async () => {
    const ask = vi.fn(dns);
    const r = await resolveListenAddress(
      { ...DEFAULT_CONFIG, host: '127.0.0.1' },
      { ...base(), tailscaleDnsName: ask },
    );
    expect(r.hostNames).not.toContain('box.tail1234.ts.net');
    expect(ask).not.toHaveBeenCalled();
  });
  it('a null answer adds nothing', async () => {
    const r = await resolveListenAddress(
      { ...DEFAULT_CONFIG, host: null, name: 'my-pc' },
      { ...base(), tailscaleDnsName: async () => null },
    );
    expect(r.hostNames).toEqual(['100.64.0.9', 'my-pc']);
  });
  it('dnsName is the tailscale status name when found, else null (ntfy links)', async () => {
    const found = await resolveListenAddress(
      { ...DEFAULT_CONFIG, host: null },
      { ...base(), tailscaleDnsName: dns },
    );
    expect(found.dnsName).toBe('box.tail1234.ts.net');
    const none = await resolveListenAddress(
      { ...DEFAULT_CONFIG, host: null },
      { ...base(), tailscaleDnsName: async () => null },
    );
    expect(none.dnsName).toBeNull();
    const notAsked = await resolveListenAddress({ ...DEFAULT_CONFIG, host: null }, base());
    expect(notAsked.dnsName).toBeNull();
    const loopback = await resolveListenAddress(
      { ...DEFAULT_CONFIG, host: '127.0.0.1' },
      { ...base(), tailscaleDnsName: dns },
    );
    expect(loopback.dnsName).toBeNull();
  });
  it('passes the host guard', async () => {
    const r = await resolveListenAddress(
      { ...DEFAULT_CONFIG, host: null },
      { ...base(), tailscaleDnsName: dns },
    );
    const app = new Hono();
    app.use('*', hostGuard({ hostNames: r.hostNames, port: 8080 }));
    app.get('/', (c) => c.text('ok'));
    const res = await app.request('/', { headers: { Host: 'box.tail1234.ts.net:8080' } });
    expect(res.status).toBe(200);
  });
});

describe('cfg.name as a Host (B12)', () => {
  const names = async (name: string) =>
    (await resolveListenAddress({ ...DEFAULT_CONFIG, host: null, name }, base())).hostNames;
  it.each(['studio', 'my-box', 'box.tail1234.ts.net', 'Box.local', 'studio.local'])(
    'accepts %s',
    async (name) => {
      expect(await names(name)).toContain(name);
    },
  );
  it.each(['example.com', 'kage.example.ts.net.evil.com', 'my box', 'x.local.example', '.local'])(
    'leaves out %s',
    async (name) => {
      expect(await names(name)).not.toContain(name);
    },
  );
  it('"example.com" is not accepted as a Host', async () => {
    const r = await resolveListenAddress(
      { ...DEFAULT_CONFIG, host: null, name: 'example.com' },
      base(),
    );
    const app = new Hono();
    app.use('*', hostGuard({ hostNames: r.hostNames, port: 8080 }));
    app.get('/', (c) => c.text('ok'));
    const res = await app.request('/', { headers: { Host: 'example.com:8080' } });
    expect(res.status).toBe(403);
  });
});
