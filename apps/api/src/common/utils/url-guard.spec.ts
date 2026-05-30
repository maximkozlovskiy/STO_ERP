import { describe, it, expect } from 'vitest';
import { validatePublicUrl } from './url-guard';

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
