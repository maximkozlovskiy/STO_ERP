import { describe, expect, it } from 'vitest';
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

  it('кривий origin у змінній — зрозуміла помилка', () => {
    expect(() => parseDevAllowedOrigins('not a url', 'development')).toThrow(/not a url/);
  });
});
