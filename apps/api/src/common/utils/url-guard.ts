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

  const host = parsed.hostname.toLowerCase();

  // Hostname-based blocklist (no DNS lookup — caller may also re-validate
  // after DNS resolution if defense-in-depth is required).
  if (
    host === 'localhost'
    || host.endsWith('.localhost')
    || host === '0.0.0.0'
    || host === '[::]'
    || host === '[::1]'
    || host === '::'
    || host === '::1'
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

  // IPv6 literal (URL strips brackets in .hostname)
  if (host.includes(':')) {
    // fc00::/7 — ULA
    if (/^f[cd][0-9a-f]{2}:/i.test(host)) return 'Недозволена IPv6 (ULA)';
    // fe80::/10 — link-local
    if (/^fe[89ab][0-9a-f]:/i.test(host)) return 'Недозволена IPv6 (link-local)';
  }

  return null;
}
