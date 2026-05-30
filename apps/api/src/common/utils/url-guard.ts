/**
 * Bug #114: SSRF defense for outbound webhooks (and any future user-supplied URL).
 *
 * Blocks requests to:
 *  - loopback: 127.0.0.0/8, ::1
 *  - link-local: 169.254.0.0/16 (incl. AWS/GCP/Azure cloud metadata), fe80::/10
 *  - RFC1918 private: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
 *  - RFC4193 ULA IPv6: fc00::/7
 *  - hostname "localhost" (any port)
 *  - non-http(s) schemes (file://, ftp://, gopher://, etc.)
 *
 * Returns null when the URL is safe to call, or an error message describing why
 * it was rejected.
 */
export function validatePublicUrl(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return 'Некоректний URL';
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'Дозволені тільки http:// та https:// URL';
  }

  // Node URL parser keeps the surrounding brackets on IPv6 hostnames
  // (e.g. `new URL('http://[fc00::1]/').hostname === '[fc00::1]'`). Earlier
  // versions of this helper compared `host` directly against `[::1]`/`[::]`
  // AND ran the ULA/link-local regexes against the bracketed value — which
  // silently bypassed every IPv6 block because `[fc00::1]` does not start
  // with `f`. Strip brackets once up-front so all comparisons see the bare
  // address.
  const hostnameRaw = parsed.hostname.toLowerCase();
  const host =
    hostnameRaw.startsWith('[') && hostnameRaw.endsWith(']')
      ? hostnameRaw.slice(1, -1)
      : hostnameRaw;

  // Hostname-based blocklist (no DNS lookup — caller may also re-validate
  // after DNS resolution if defense-in-depth is required).
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '0.0.0.0' ||
    host === '::' ||
    host === '::1'
  ) {
    return 'Недозволений хост (localhost)';
  }

  // IPv4 literal: aaa.bbb.ccc.ddd
  const ipv4Match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4Match) {
    const parts = ipv4Match.slice(1, 5).map(Number);
    if (parts.some(p => p < 0 || p > 255)) return 'Некоректна IPv4 адреса';
    const [a, b] = parts;
    // 127.0.0.0/8 — loopback
    if (a === 127) return 'Недозволена приватна IPv4 (loopback)';
    // 10.0.0.0/8 — RFC1918
    if (a === 10) return 'Недозволена приватна IPv4 (10.0.0.0/8)';
    // 172.16.0.0/12 — RFC1918
    if (a === 172 && b >= 16 && b <= 31) return 'Недозволена приватна IPv4 (172.16.0.0/12)';
    // 192.168.0.0/16 — RFC1918
    if (a === 192 && b === 168) return 'Недозволена приватна IPv4 (192.168.0.0/16)';
    // 169.254.0.0/16 — link-local incl. cloud metadata 169.254.169.254
    if (a === 169 && b === 254) return 'Недозволена IPv4 (link-local / cloud metadata)';
    // 0.0.0.0/8
    if (a === 0) return 'Недозволена IPv4 (0.0.0.0/8)';
    // 100.64.0.0/10 — carrier-grade NAT
    if (a === 100 && b >= 64 && b <= 127) return 'Недозволена IPv4 (CGNAT)';
  }

  // IPv6 literal (brackets already stripped above).
  // Important: Node's URL parser NORMALIZES IPv6 to lowercase hex compressed
  // form (RFC 5952). So `[::ffff:127.0.0.1]` arrives here as `::ffff:7f00:1`
  // (no dotted-quad), `[::10.0.0.1]` arrives as `::a00:1` (leading zero
  // stripped). All checks below assume that normalized form.
  if (host.includes(':')) {
    // ::1, :: handled above by literal match.
    // fc00::/7 — ULA (any address with first byte fc-fd)
    if (/^f[cd][0-9a-f]{0,2}:/i.test(host)) return 'Недозволена IPv6 (ULA)';
    // fe80::/10 — link-local (fe80-febf in first hextet)
    if (/^fe[89ab][0-9a-f]?:/i.test(host)) return 'Недозволена IPv6 (link-local)';

    // Bug #123: IPv6 with embedded IPv4 has TWO legacy forms — IPv4-mapped
    // (`::ffff:a.b.c.d`, RFC 4291 §2.5.5.2) and IPv4-compatible (`::a.b.c.d`,
    // deprecated §2.5.5.1). After Node URL normalization both become the
    // pure-hex compressed form (e.g. `::ffff:7f00:1`, `::7f00:1`).
    //
    // The robust approach: any IPv6 that compresses to `::*:*` (i.e. only the
    // last two hextets carry data, with the leading bits all zero) is an
    // address whose lower 32 bits are interpreted as IPv4 by historical
    // routing stacks. Decode the last two hextets as an IPv4 address and
    // run it through the IPv4 blocklist.
    //
    // Pattern matches:
    //   `::XXXX:YYYY`            — IPv4-compatible (`::a.b.c.d`)
    //   `::ffff:XXXX:YYYY`       — IPv4-mapped (`::ffff:a.b.c.d`)
    //   `::ffff:0:XXXX:YYYY`     — IPv4-translated (RFC 2765, less common)
    const embedded = /^(?:::|::ffff:|::ffff:0:)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(host);
    if (embedded) {
      const high = parseInt(embedded[1], 16);
      const low = parseInt(embedded[2], 16);
      const a = (high >> 8) & 0xff;
      const b = high & 0xff;
      const c = (low >> 8) & 0xff;
      const d = low & 0xff;
      // 127.0.0.0/8 — loopback
      if (a === 127) return 'Недозволена IPv6 з вбудованим IPv4 (loopback)';
      // 10.0.0.0/8 — RFC1918
      if (a === 10) return 'Недозволена IPv6 з вбудованим IPv4 (10.0.0.0/8)';
      // 172.16.0.0/12 — RFC1918
      if (a === 172 && b >= 16 && b <= 31)
        return 'Недозволена IPv6 з вбудованим IPv4 (172.16.0.0/12)';
      // 192.168.0.0/16 — RFC1918
      if (a === 192 && b === 168) return 'Недозволена IPv6 з вбудованим IPv4 (192.168.0.0/16)';
      // 169.254.0.0/16 — link-local
      if (a === 169 && b === 254) return 'Недозволена IPv6 з вбудованим IPv4 (link-local)';
      // 0.0.0.0/8 — `::` itself was handled earlier; here cover `::0.x.y.z`.
      if (a === 0) return 'Недозволена IPv6 з вбудованим IPv4 (0.0.0.0/8)';
      // 100.64.0.0/10 — CGNAT
      if (a === 100 && b >= 64 && b <= 127) return 'Недозволена IPv6 з вбудованим IPv4 (CGNAT)';
      // Silence unused warning while keeping the parse explicit for future
      // sanity checks (e.g. logging the resolved IPv4 in dev diagnostics).
      void c;
      void d;
    }
  }

  return null;
}
