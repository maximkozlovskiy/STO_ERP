import { describe, expect, it, vi } from 'vitest';
import { parseDevAllowedOrigins, SupplierUrlPolicy } from './supplier-url-policy';

describe('SupplierUrlPolicy — куди дозволено ходити клієнту постачальників (BR-SCON-005)', () => {
  // guards: BR-SCON-005
  it('без allowlist: публічна адреса — так, localhost і приватні мережі — ні', () => {
    const p = SupplierUrlPolicy.fromEnv({ NODE_ENV: 'development' });
    expect(p.check('https://api.avdtrade.com.ua/api/v1/items')).toBeNull();
    expect(p.check('http://localhost:4100/avd')).not.toBeNull();
    expect(p.check('http://127.0.0.1:4100/avd')).not.toBeNull();
    expect(p.check('http://192.168.1.10/api')).not.toBeNull();
    expect(p.check('http://169.254.169.254/latest')).not.toBeNull();
    expect(p.devAllowlistActive).toBe(false);
  });

  // guards: BR-SCON-005
  it('allowlist поза production відкриває лише перелічені origin-и', () => {
    const p = SupplierUrlPolicy.fromEnv({
      NODE_ENV: 'development',
      SUPPLIER_API_DEV_ALLOWED_ORIGINS: 'http://127.0.0.1:4100, http://localhost:4100/',
    });
    expect(p.check('http://127.0.0.1:4100/avd/api/v1/items')).toBeNull();
    expect(p.check('http://localhost:4100/bm/search')).toBeNull();
    expect(p.check('http://127.0.0.1:4101/avd')).not.toBeNull();
    expect(p.devAllowlistActive).toBe(true);
  });

  // guards: BR-SCON-005
  it('у production непорожній allowlist — відмова старту', () => {
    expect(() =>
      SupplierUrlPolicy.fromEnv({
        NODE_ENV: 'production',
        SUPPLIER_API_DEV_ALLOWED_ORIGINS: 'http://127.0.0.1:4100',
      }),
    ).toThrow(/production/);
    expect(() => parseDevAllowedOrigins('   ', 'production')).not.toThrow();
  });

  // guards: BR-SCON-005
  it('перед запитом ім’я резолвиться: публічне ім’я з приватною адресою — відмова; allowlist і літерали — без DNS', async () => {
    const lookup = vi.fn((host: string) =>
      Promise.resolve(
        host === 'evil.example.com'
          ? [
              { address: '93.184.216.34', family: 4 },
              { address: '10.0.0.5', family: 4 },
            ]
          : host === 'v6.example.com'
            ? [{ address: '::ffff:127.0.0.1', family: 6 }]
            : [{ address: '93.184.216.34', family: 4 }],
      ),
    );
    const p = SupplierUrlPolicy.fromEnv(
      { NODE_ENV: 'development', SUPPLIER_API_DEV_ALLOWED_ORIGINS: 'http://127.0.0.1:4100' },
      lookup,
    );
    await expect(p.checkResolved('https://evil.example.com/api')).resolves.toMatch(/10\.0\.0\.5/);
    await expect(p.checkResolved('https://v6.example.com/api')).resolves.not.toBeNull();
    await expect(p.checkResolved('https://api.avdtrade.com.ua/api/v1')).resolves.toBeNull();
    await expect(p.checkResolved('http://192.168.1.1/x')).resolves.not.toBeNull();
    await expect(p.checkResolved('http://127.0.0.1:4100/avd')).resolves.toBeNull();
    expect(lookup.mock.calls.map(c => c[0])).toEqual([
      'evil.example.com',
      'v6.example.com',
      'api.avdtrade.com.ua',
    ]);
  });

  // guards: BR-SCON-005
  it('apiUrl підключення: поза allowlist лише https', () => {
    const p = SupplierUrlPolicy.fromEnv({
      NODE_ENV: 'development',
      SUPPLIER_API_DEV_ALLOWED_ORIGINS: 'http://127.0.0.1:4100',
    });
    expect(p.checkApiUrl('https://api.example.com/v1')).toBeNull();
    expect(p.checkApiUrl('http://api.example.com/v1')).toMatch(/https/);
    expect(p.checkApiUrl('http://127.0.0.1:4100/avd')).toBeNull();
  });

  it('кривий origin у змінній — зрозуміла помилка', () => {
    expect(() => parseDevAllowedOrigins('not a url', 'development')).toThrow(/not a url/);
  });
});
