import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from './config.ts';
import {
  displayHost,
  hostNamesFor,
  ListenError,
  linkHost,
  resolveListenAddress,
  tailscaleDnsName,
} from './listen.ts';
import { csrfGuard, hostGuard } from './security.ts';

// This machine's name as macOS gives it: a .local name anyone on the LAN can answer for (mDNS).
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  hostname: () => 'Owners-MacBook.local',
}));

const base = (over: { unsafeListenAll?: boolean; ip?: string | null } = {}) => ({
  unsafeListenAll: over.unsafeListenAll ?? false,
  tailscaleIp: async () => (over.ip === undefined ? '100.64.0.9' : over.ip),
});

describe('resolveListenAddress', () => {
  it('uses cfg.host when set', async () => {
    const r = await resolveListenAddress({ ...DEFAULT_CONFIG, host: '100.64.0.7' }, base());
    expect(r.address).toBe('100.64.0.7');
    expect(r.hostNames).toEqual(['100.64.0.7']);
  });
  it('uses tailscale ip when no host', async () => {
    const r = await resolveListenAddress({ ...DEFAULT_CONFIG, host: null }, base());
    expect(r.address).toBe('100.64.0.9');
    expect(r.hostNames).toEqual(['100.64.0.9']);
  });
  it('throws when tailscale is not running', async () => {
    const p = resolveListenAddress({ ...DEFAULT_CONFIG, host: null }, base({ ip: null }));
    await expect(p).rejects.toBeInstanceOf(ListenError);
    await expect(p).rejects.toThrow(
      'Tailscale isn\'t running. Start it with "tailscale up", or set "host" in config.json.',
    );
  });
  it('names the config file it is given when tailscale is not running (B52)', async () => {
    const p = resolveListenAddress(
      { ...DEFAULT_CONFIG, host: null },
      { ...base({ ip: null }), configFile: '/srv/conf/kage/config.json' },
    );
    await expect(p).rejects.toThrow(
      'Tailscale isn\'t running. Start it with "tailscale up", or set "host" in /srv/conf/kage/config.json.',
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
    expect(r.hostNames).toEqual(['box.tail.ts.net', '100.101.102.103']);
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

/** A guarded app with this allow-list on port 8080: Host and Origin both checked. */
function guarded(hostNames: string[]) {
  const allowed = { hostNames, port: 8080 };
  const app = new Hono().use(hostGuard(allowed)).use(csrfGuard(allowed));
  app.all('/', (c) => c.text('ok'));
  const host = async (h: string) => (await app.request('/', { headers: { Host: h } })).status;
  // The Origin alone is under test: the Host is one the list holds.
  const origin = async (name: string) =>
    (
      await app.request('/', {
        method: 'POST',
        headers: {
          Host: `${hostNames[0]?.includes(':') ? `[${hostNames[0]}]` : hostNames[0]}:8080`,
          'X-Kage': '1',
          Origin: `http://${name}:8080`,
        },
      })
    ).status;
  return { host, origin };
}

describe('the Host and Origin allow-list (security I2)', () => {
  it('trusts the bound IP, the MagicDNS name and an explicit host only (not its first label, R130)', async () => {
    // os.hostname() is "Owners-MacBook.local" here (the mock above); cfg.name is the pill only.
    const r = await resolveListenAddress(
      { ...DEFAULT_CONFIG, host: null, name: 'box' },
      { ...base(), tailscaleDnsName: async () => 'studio.tail1234.ts.net' },
    );
    expect(r.hostNames).toEqual(['studio.tail1234.ts.net', '100.64.0.9']);
    for (const name of ['owners-macbook.local', 'owners-macbook', 'box', 'studio']) {
      expect(r.hostNames).not.toContain(name);
    }
    const g = guarded(r.hostNames);
    // A rebinding attempt: an mDNS (.local), LLMNR (single label, the MagicDNS first label and
    // a trailing-dot label too) or os.hostname() name.
    for (const name of [
      'owners-macbook.local',
      'owners-macbook',
      'box',
      'box.',
      'studio',
      'studio.',
      'localhost',
    ]) {
      expect(await g.host(`${name}:8080`), name).toBe(403);
      expect(await g.origin(name), name).toBe(403);
    }
    for (const name of ['studio.tail1234.ts.net', 'STUDIO.Tail1234.TS.NET', '100.64.0.9']) {
      expect(await g.host(`${name}:8080`), name).toBe(200);
      expect(await g.origin(name), name).toBe(200);
    }
    // A trailing dot on a multi-label name is the same name, and the port is still checked.
    expect(await g.host('studio.tail1234.ts.net.:8080')).toBe(200);
    expect(await g.origin('Studio.Tail1234.ts.net.')).toBe(200);
    expect(await g.host('studio.tail1234.ts.net:9999')).toBe(403);
  });

  it('a loopback bind also trusts localhost; a Tailscale bind does not', async () => {
    const v4 = await resolveListenAddress({ ...DEFAULT_CONFIG, host: '127.0.0.1' }, base());
    expect(v4.hostNames).toEqual(['127.0.0.1', 'localhost']);
    const g4 = guarded(v4.hostNames);
    expect(await g4.host('localhost:8080')).toBe(200);
    expect(await g4.origin('localhost')).toBe(200);
    const v6 = await resolveListenAddress({ ...DEFAULT_CONFIG, host: '::1' }, base());
    expect(v6.hostNames).toEqual(['::1', 'localhost']);
    const g6 = guarded(v6.hostNames);
    expect(await g6.host('[::1]:8080')).toBe(200);
    expect(await g6.host('localhost:8080')).toBe(200);
    expect(await g6.origin('[::1]')).toBe(200);
    expect(await g6.origin('localhost')).toBe(200);
    // localhost. is a DNS lookup, not the browser's own localhost (R130).
    expect(await g4.host('localhost.:8080')).toBe(403);
    expect(await g4.origin('localhost.')).toBe(403);
    expect(await g6.host('localhost.:8080')).toBe(403);
    const ts = await resolveListenAddress({ ...DEFAULT_CONFIG, host: null }, base());
    expect(ts.hostNames).not.toContain('localhost');
    expect(await guarded(ts.hostNames).host('localhost:8080')).toBe(403);
    expect(await guarded(ts.hostNames).origin('localhost')).toBe(403);
  });

  it('an IPv6 bind trusts its address however it is written, bracketed', async () => {
    const r = await resolveListenAddress({ ...DEFAULT_CONFIG, host: 'fd7a:115c:a1e0::1' }, base());
    expect(r.hostNames).toEqual(['fd7a:115c:a1e0::1']);
    const g = guarded(r.hostNames);
    expect(await g.host('[FD7A:115C:A1E0:0:0:0:0:1]:8080')).toBe(200);
    expect(await g.host('[fd7a:115c:a1e0::1]:9999')).toBe(403);
    expect(await g.host('localhost:8080')).toBe(403);
    expect(await g.origin('[fd7a:115c:a1e0::1]')).toBe(200);
    expect(await g.origin('localhost')).toBe(403);
  });

  it('a configured host name, even .local, is trusted', async () => {
    const lookup = async () => [{ address: '100.64.0.9', family: 4 }];
    for (const host of ['studio.local', 'box', 'Box.Tail1234.ts.net.']) {
      const r = await resolveListenAddress({ ...DEFAULT_CONFIG, host }, { ...base(), lookup });
      expect(r.hostNames).toEqual([host, '100.64.0.9']);
      const g = guarded(r.hostNames);
      const typed = host.replace(/\.$/, '').toLowerCase();
      expect(await g.host(`${typed}:8080`), host).toBe(200);
      expect(await g.origin(typed), host).toBe(200);
    }
    // A configured single label still refuses its trailing-dot form (R130).
    const r = await resolveListenAddress({ ...DEFAULT_CONFIG, host: 'box' }, { ...base(), lookup });
    expect(await guarded(r.hostNames).host('box.:8080')).toBe(403);
    expect(await guarded(r.hostNames).origin('box.')).toBe(403);
  });

  it('hostNamesFor: an all-interfaces bind trusts the configured host and the MagicDNS names', () => {
    const cfg = { ...DEFAULT_CONFIG, host: '0.0.0.0', name: 'box' };
    expect(hostNamesFor(cfg, '0.0.0.0', 'studio.tail1.ts.net')).toEqual(['studio.tail1.ts.net']);
    expect(hostNamesFor({ ...cfg, host: '' }, '', null)).toEqual([]);
  });

  it('--unsafe-listen-all also trusts the Tailscale IP when known (F11)', async () => {
    const r = await resolveListenAddress(
      { ...DEFAULT_CONFIG, host: '0.0.0.0' },
      { ...base({ unsafeListenAll: true }), tailscaleDnsName: async () => 'studio.tail1.ts.net' },
    );
    expect(r.hostNames).toEqual(['studio.tail1.ts.net', '100.64.0.9']);
    expect(displayHost({ ...DEFAULT_CONFIG, host: '0.0.0.0' }, r)).toBe('studio.tail1.ts.net');
    const noDns = await resolveListenAddress(
      { ...DEFAULT_CONFIG, host: '0.0.0.0' },
      base({ unsafeListenAll: true }),
    );
    expect(noDns.hostNames).toEqual(['100.64.0.9']);
    expect(displayHost({ ...DEFAULT_CONFIG, host: '0.0.0.0' }, noDns)).toBe('100.64.0.9');
    const noTs = await resolveListenAddress(
      { ...DEFAULT_CONFIG, host: '0.0.0.0' },
      base({ unsafeListenAll: true, ip: null }),
    );
    expect(noTs.hostNames).toEqual([]);
  });
});

describe('displayHost', () => {
  const cfg = (over: Partial<typeof DEFAULT_CONFIG>) => ({ ...DEFAULT_CONFIG, ...over });
  const at = (address: string, dnsName: string | null = null) => ({ address, dnsName });
  it('prints the configured host name', () => {
    expect(displayHost(cfg({ host: 'box.tail.ts.net', name: 'box' }), at('100.64.0.7'))).toBe(
      'box.tail.ts.net',
    );
  });
  it('displayHost prints the MagicDNS name in full, else the IP (R130)', () => {
    expect(displayHost(cfg({ host: null, name: 'box' }), at('100.64.0.9', 'studio.t.ts.net'))).toBe(
      'studio.t.ts.net',
    );
    expect(
      displayHost(cfg({ host: '100.64.0.7', name: 'box' }), at('100.64.0.7', 'studio.t.ts.net')),
    ).toBe('studio.t.ts.net');
    expect(displayHost(cfg({ host: null, name: 'box' }), at('100.64.0.9'))).toBe('100.64.0.9');
    expect(
      displayHost(cfg({ host: 'fd7a:115c:a1e0::1', name: 'box' }), at('fd7a:115c:a1e0::1')),
    ).toBe('[fd7a:115c:a1e0::1]');
  });
  it('never prints cfg.name', () => {
    expect(displayHost(cfg({ host: null, name: 'studio' }), at('100.64.0.9'))).toBe('100.64.0.9');
  });
  it('prints the IP for a loopback bind', () => {
    expect(displayHost(cfg({ host: '127.0.0.1', name: 'studio' }), at('127.0.0.1'))).toBe(
      '127.0.0.1',
    );
    expect(displayHost(cfg({ host: '::1', name: 'studio' }), at('::1'))).toBe('[::1]');
  });
  it('what it prints always passes its own guard', async () => {
    const cases: [Partial<typeof DEFAULT_CONFIG>, (() => Promise<string | null>) | undefined][] = [
      [{ host: null, name: 'box' }, async () => 'studio.tail1.ts.net'],
      [{ host: null, name: 'box' }, async () => null],
      [{ host: '127.0.0.1', name: 'box' }, undefined],
      [{ host: '::1', name: 'box' }, undefined],
      [{ host: 'fd7a:115c:a1e0::1', name: 'box' }, async () => null],
      [{ host: 'studio.local', name: 'box' }, undefined],
    ];
    const lookup = async () => [{ address: '100.64.0.9', family: 4 }];
    for (const [over, dns] of cases) {
      const c = cfg(over);
      const r = await resolveListenAddress(c, { ...base(), lookup, tailscaleDnsName: dns });
      const shown = displayHost(c, r);
      expect(await guarded(r.hostNames).host(`${shown}:8080`), shown).toBe(200);
    }
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
    expect(r.hostNames).toEqual(['100.64.0.9']);
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

describe('linkHost (ntfy click links)', () => {
  const listen = (dnsName: string | null) => ({ address: '100.64.0.9', dnsName });
  it('an explicitly configured host wins over the MagicDNS name', () => {
    const cfg = { ...DEFAULT_CONFIG, name: 'my-pc' };
    expect(linkHost({ ...cfg, host: 'kage.example.ts.net' }, listen('box.tail1.ts.net'))).toBe(
      'kage.example.ts.net',
    );
    expect(linkHost({ ...cfg, host: '100.64.0.9' }, listen('box.tail1.ts.net'))).toBe('100.64.0.9');
  });
  it('without a configured host: the MagicDNS name, else displayHost', () => {
    const cfg = { ...DEFAULT_CONFIG, name: 'my-pc', host: null };
    expect(linkHost(cfg, listen('box.tail1.ts.net'))).toBe('box.tail1.ts.net');
    expect(linkHost(cfg, listen(null))).toBe('100.64.0.9');
    expect(linkHost({ ...cfg, host: '  ' }, listen('box.tail1.ts.net'))).toBe('box.tail1.ts.net');
  });
});

describe('linkHost: literals', () => {
  const listen = { address: '100.64.0.9', dnsName: 'box.tail1.ts.net' };
  it('brackets a configured IPv6 literal; an all-interfaces host falls back to the MagicDNS name', () => {
    expect(linkHost({ ...DEFAULT_CONFIG, host: 'fd7a:115c:a1e0::5' }, listen)).toBe(
      '[fd7a:115c:a1e0::5]',
    );
    expect(linkHost({ ...DEFAULT_CONFIG, host: '0.0.0.0' }, listen)).toBe('box.tail1.ts.net');
  });
});
