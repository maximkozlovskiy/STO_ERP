import { describe, it, expect } from 'vitest';
import { validatePublicUrl, validatePublicUrlResolved, type HostLookup } from './url-guard';

/**
 * Bug #124: regression guard for `validatePublicUrl`.
 *
 * Cycle-1 shipped a regex that silently passed any IPv6 with brackets through
 * the ULA/link-local checks (`new URL('http://[fc00::1]/').hostname === '[fc00::1]'`
 * and `/^f[cd]/.test('[fc00::1]') === false`). Cycle-2 fixed it and added this
 * test file so the next regression never hits production silently.
 *
 * Each `expect(validatePublicUrl(x)).toBeNull()` is an explicit "this URL must
 * be ALLOWED". Each `.toContain(reason)` is an explicit "this URL must be BLOCKED".
 */
describe('validatePublicUrl', () => {
  describe('ALLOWED — public URLs', () => {
    it.each([
      'https://example.com',
      'https://example.com/path?q=1',
      'http://api.public.io:8080/path',
      'https://www.google.com',
      'https://1.1.1.1',
      'https://8.8.8.8/dns-query',
      'https://172.15.0.1', // edge: not in 172.16/12
      'https://172.32.0.1', // edge: not in 172.16/12
      'https://169.253.1.1', // edge: not in 169.254/16
      'https://100.63.0.1', // edge: not in 100.64/10
      'https://100.128.0.1', // edge: not in 100.64/10
      'https://11.0.0.1', // edge: not in 10/8
      'https://126.0.0.1', // edge: not in 127/8
      'https://128.0.0.1', // edge: not in 127/8
    ])('allows %s', url => {
      expect(validatePublicUrl(url)).toBeNull();
    });
  });

  describe('BLOCKED — scheme', () => {
    it.each([
      ['file:///etc/passwd', 'http://'],
      ['ftp://internal.local', 'http://'],
      ['gopher://x', 'http://'],
      ['javascript:alert(1)', 'http://'],
      ['data:text/html,<script>1</script>', 'http://'],
    ])('rejects %s', (url, hint) => {
      const result = validatePublicUrl(url);
      expect(result).not.toBeNull();
      expect(result).toContain(hint);
    });
  });

  describe('BLOCKED — malformed', () => {
    it('rejects non-URL string', () => {
      expect(validatePublicUrl('not a url')).toBe('Некоректний URL');
    });
    it('rejects empty string', () => {
      expect(validatePublicUrl('')).toBe('Некоректний URL');
    });
  });

  describe('BLOCKED — IPv4 loopback', () => {
    it.each([
      'http://127.0.0.1',
      'http://127.1.2.3',
      'http://127.255.255.254',
      'https://127.0.0.1:8080/admin',
    ])('rejects %s', url => {
      expect(validatePublicUrl(url)).toContain('loopback');
    });
  });

  describe('BLOCKED — IPv4 RFC1918', () => {
    it('rejects 10.0.0.0/8', () => {
      expect(validatePublicUrl('http://10.0.0.1')).toContain('10.0.0.0/8');
      expect(validatePublicUrl('http://10.255.255.254')).toContain('10.0.0.0/8');
    });
    it('rejects 172.16.0.0/12', () => {
      expect(validatePublicUrl('http://172.16.0.1')).toContain('172.16.0.0/12');
      expect(validatePublicUrl('http://172.20.5.10')).toContain('172.16.0.0/12');
      expect(validatePublicUrl('http://172.31.255.254')).toContain('172.16.0.0/12');
    });
    it('rejects 192.168.0.0/16', () => {
      expect(validatePublicUrl('http://192.168.1.1')).toContain('192.168.0.0/16');
      expect(validatePublicUrl('http://192.168.255.254')).toContain('192.168.0.0/16');
    });
  });

  describe('BLOCKED — IPv4 link-local / cloud metadata', () => {
    it('rejects 169.254.0.0/16', () => {
      expect(validatePublicUrl('http://169.254.169.254')).toContain('link-local');
      expect(validatePublicUrl('http://169.254.0.1')).toContain('link-local');
    });
  });

  describe('BLOCKED — IPv4 special-purpose', () => {
    it('rejects 0.0.0.0/8', () => {
      expect(validatePublicUrl('http://0.0.0.0')).not.toBeNull();
      expect(validatePublicUrl('http://0.1.2.3')).toContain('0.0.0.0/8');
    });
    it('rejects 100.64.0.0/10 CGNAT', () => {
      expect(validatePublicUrl('http://100.64.0.1')).toContain('CGNAT');
      expect(validatePublicUrl('http://100.127.255.254')).toContain('CGNAT');
    });
  });

  describe('BLOCKED — hostname-based', () => {
    it.each([
      'http://localhost',
      'http://localhost:8080',
      'https://web.localhost',
      'http://0.0.0.0',
    ])('rejects %s', url => {
      expect(validatePublicUrl(url)).toContain('localhost');
    });
  });

  describe('BLOCKED — IPv6 loopback', () => {
    it.each(['http://[::1]', 'http://[::1]:8080', 'http://[::]'])('rejects %s', url => {
      expect(validatePublicUrl(url)).toContain('localhost');
    });
  });

  describe('BLOCKED — IPv6 ULA (fc00::/7)', () => {
    it.each([
      'http://[fc00::1]',
      'http://[fcab::beef]',
      'http://[fd00::1]:9000',
      'http://[fdab:1234:5678::1]',
    ])('rejects %s', url => {
      expect(validatePublicUrl(url)).toContain('ULA');
    });
  });

  describe('BLOCKED — IPv6 link-local (fe80::/10)', () => {
    it.each([
      'http://[fe80::1]',
      'http://[fe80::abcd:1234]',
      'http://[febf::1]',
      'http://[fea0::beef]',
    ])('rejects %s', url => {
      expect(validatePublicUrl(url)).toContain('link-local');
    });
  });

  describe('BLOCKED — IPv4-mapped IPv6 (::ffff:a.b.c.d)', () => {
    it.each([
      ['http://[::ffff:127.0.0.1]', 'loopback'],
      ['http://[::ffff:10.0.0.1]', '10.0.0.0/8'],
      ['http://[::ffff:192.168.1.1]', '192.168.0.0/16'],
      ['http://[::ffff:169.254.169.254]', 'link-local'],
      ['http://[::ffff:172.16.0.1]', '172.16.0.0/12'],
    ])('rejects %s', (url, reason) => {
      const result = validatePublicUrl(url);
      expect(result).not.toBeNull();
      expect(result).toContain(reason);
    });
  });

  describe('BLOCKED — IPv4-compatible IPv6 (::a.b.c.d) — Bug #123 regression', () => {
    it.each([
      ['http://[::127.0.0.1]', 'loopback'],
      ['http://[::10.0.0.1]', '10.0.0.0/8'],
      ['http://[::192.168.1.1]', '192.168.0.0/16'],
      ['http://[::169.254.169.254]', 'link-local'],
      ['http://[::172.16.0.1]', '172.16.0.0/12'],
    ])('rejects %s', (url, reason) => {
      const result = validatePublicUrl(url);
      expect(result).not.toBeNull();
      expect(result).toContain(reason);
    });
  });

  describe('BLOCKED — hex-encoded IPv6 (after URL normalization)', () => {
    // Node URL normalizes `[::ffff:127.0.0.1]` to `::ffff:7f00:1`. Direct hex
    // literals must match the same blocklist.
    it('rejects ::7f00:1 (hex 127.0.0.1)', () => {
      expect(validatePublicUrl('http://[::7f00:1]')).toContain('loopback');
    });
    it('rejects ::a00:1 (hex 10.0.0.1)', () => {
      expect(validatePublicUrl('http://[::a00:1]')).toContain('10.0.0.0/8');
    });
    it('rejects ::c0a8:101 (hex 192.168.1.1)', () => {
      expect(validatePublicUrl('http://[::c0a8:101]')).toContain('192.168.0.0/16');
    });
    it('rejects ::a9fe:a9fe (hex 169.254.169.254)', () => {
      expect(validatePublicUrl('http://[::a9fe:a9fe]')).toContain('link-local');
    });
    it('rejects ::ac10:1 (hex 172.16.0.1)', () => {
      expect(validatePublicUrl('http://[::ac10:1]')).toContain('172.16.0.0/12');
    });
  });

  describe('IPv6 brackets handling — cycle-2 regression guard', () => {
    it('strips brackets before regex (otherwise ULA bypass)', () => {
      // The exact bug fixed in cycle-2: `parsed.hostname` returns `[fc00::1]`,
      // and the ULA regex `/^f[cd]/` is FALSE against `[fc00::1]` (starts
      // with `[`, not `f`). If the brackets are not stripped, this URL is
      // (incorrectly) marked safe.
      const result = validatePublicUrl('http://[fc00::1]/webhook');
      expect(result).toContain('ULA');
    });
  });
});

/**
 * Regression guard for `validatePublicUrlResolved` — the DNS-resolved layer that is the
 * actual SSRF defense for public hostnames (BR-SEC-SSRF). The literal layer above cannot
 * catch `attacker.example` whose A/AAAA record points at an internal address; only the
 * resolved layer can. These cases pin the behaviours a reviewer and implementer could
 * silently break:
 *
 *  - EVERY resolved address must be screened (mixed public+private → block). Mutating the
 *    loop to inspect only the first address, or to `return null` on the first PUBLIC one,
 *    re-opens the DNS-rebinding bypass and fails `mixed addresses` / `private is not first`.
 *  - A literal URL short-circuits DNS (no lookup call).
 *  - Lookup failure returns null (allow) — fetch itself then fails with ENOTFOUND; this is a
 *    deliberate design choice (documented in url-guard.ts), pinned so a change is intentional.
 */
describe('validatePublicUrlResolved — DNS-resolved SSRF layer (BR-SEC-SSRF)', () => {
  const ADDR = {
    public: { address: '93.184.216.34', family: 4 },
    loopback: { address: '127.0.0.1', family: 4 },
    metadata: { address: '169.254.169.254', family: 4 },
    ula6: { address: 'fc00::1', family: 6 },
    linklocal6: { address: 'fe80::1', family: 6 },
  } as const;
  const resolvesTo =
    (...addresses: Array<{ address: string; family: number }>): HostLookup =>
    () =>
      Promise.resolve(addresses);

  it('allows a public hostname that resolves to a public address', async () => {
    expect(
      await validatePublicUrlResolved('https://ok.example/', resolvesTo(ADDR.public)),
    ).toBeNull();
  });

  it('blocks a public hostname that resolves to loopback (DNS rebinding)', async () => {
    const r = await validatePublicUrlResolved('https://rebind.example/', resolvesTo(ADDR.loopback));
    expect(r).not.toBeNull();
    expect(r).toContain('loopback');
  });

  it('blocks when the hostname resolves to cloud-metadata (169.254.169.254)', async () => {
    const r = await validatePublicUrlResolved('http://meta.example/', resolvesTo(ADDR.metadata));
    expect(r).toContain('link-local');
  });

  it.each([
    ['ULA IPv6', ADDR.ula6, 'ULA'],
    ['link-local IPv6', ADDR.linklocal6, 'link-local'],
  ])('blocks when the hostname resolves to a private %s address', async (_label, addr, reason) => {
    const r = await validatePublicUrlResolved('http://v6.example/', resolvesTo(addr));
    expect(r).toContain(reason);
  });

  it('blocks mixed addresses — ONE public + ONE private (every address screened)', async () => {
    // The dangerous case: a hostname with both a public and a private A record. The guard
    // MUST reject because ANY private address lets the request reach an internal target.
    const r = await validatePublicUrlResolved(
      'http://mixed.example/',
      resolvesTo(ADDR.public, ADDR.loopback),
    );
    expect(r).not.toBeNull();
    expect(r).toContain('loopback');
  });

  it('blocks even when the private address is NOT first in the resolved list', async () => {
    // Guards against a mutation that returns on the first address or the first public one.
    const r = await validatePublicUrlResolved(
      'http://mixed2.example/',
      resolvesTo(ADDR.public, ADDR.public, ADDR.metadata),
    );
    expect(r).not.toBeNull();
    expect(r).toContain('link-local');
  });

  it('short-circuits an IP literal without ever calling DNS lookup', async () => {
    let called = false;
    const spy: HostLookup = () => {
      called = true;
      return Promise.resolve([ADDR.loopback]);
    };
    // Public literal → allowed; the literal path must not invoke the resolver.
    expect(await validatePublicUrlResolved('https://8.8.8.8/', spy)).toBeNull();
    expect(called).toBe(false);
    // Private literal → still blocked by the literal layer, also without a lookup.
    expect(await validatePublicUrlResolved('http://127.0.0.1/', spy)).toContain('loopback');
    expect(called).toBe(false);
  });

  it('returns null (allow) when DNS lookup fails — deliberate; fetch then fails with ENOTFOUND', async () => {
    const r = await validatePublicUrlResolved('http://nx.example/', () =>
      Promise.reject(new Error('ENOTFOUND')),
    );
    expect(r).toBeNull();
  });

  it('still rejects a bad scheme before any DNS lookup', async () => {
    let called = false;
    const spy: HostLookup = () => {
      called = true;
      return Promise.resolve([ADDR.public]);
    };
    const r = await validatePublicUrlResolved('file:///etc/passwd', spy);
    expect(r).toContain('http://');
    expect(called).toBe(false);
  });
});
