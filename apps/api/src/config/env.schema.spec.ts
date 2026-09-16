import { describe, it, expect } from 'vitest';
import { validateEnv, envSchema } from './env.schema';

const STRONG = 'x'.repeat(32);

const prodBase = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://sto:pw@db:5432/sto_erp',
  JWT_ACCESS_SECRET: STRONG,
  JWT_REFRESH_SECRET: STRONG,
  MINIO_ENDPOINT: 'minio',
  MINIO_PORT: '9000',
  MINIO_ACCESS_KEY: 'ak',
  MINIO_SECRET_KEY: 'sk',
  MINIO_BUCKET: 'sto-files',
  NOTIFICATION_ENC_KEY: STRONG,
};

describe('validateEnv — fail-fast env валідація', () => {
  it('dev/test: порожній env валідний (dev-lenient, локальні дефолти)', () => {
    const r = validateEnv({});
    expect(r.NODE_ENV).toBe('development');
    expect(r.PORT).toBe(3000);
  });

  it('dev: відсутні JWT/MinIO/DATABASE_URL НЕ валять (lenient)', () => {
    expect(() => validateEnv({ NODE_ENV: 'development' })).not.toThrow();
  });

  it('production: повний набір секретів — валідний', () => {
    expect(() => validateEnv(prodBase)).not.toThrow();
  });

  it('production: відсутній DATABASE_URL → кидає з переліком', () => {
    const { DATABASE_URL, ...rest } = prodBase;
    expect(() => validateEnv(rest)).toThrow(/DATABASE_URL обовʼязковий у production/);
  });

  it('production: відсутній NOTIFICATION_ENC_KEY → кидає (шифрування at-rest)', () => {
    const { NOTIFICATION_ENC_KEY, ...rest } = prodBase;
    expect(() => validateEnv(rest)).toThrow(/NOTIFICATION_ENC_KEY обовʼязковий у production/);
  });

  it('production: відсутній MINIO_PORT → кидає (files.service getOrThrow hard-dep)', () => {
    const { MINIO_PORT, ...rest } = prodBase;
    expect(() => validateEnv(rest)).toThrow(/MINIO_PORT обовʼязковий у production/);
  });

  it('production: короткий JWT_ACCESS_SECRET (<32) → кидає (формат)', () => {
    expect(() => validateEnv({ ...prodBase, JWT_ACCESS_SECRET: 'short' })).toThrow(
      /JWT_ACCESS_SECRET має бути ≥ 32/,
    );
  });

  it('формат валідується ЗАВЖДИ: кривий PORT → кидає навіть у dev', () => {
    expect(() => validateEnv({ NODE_ENV: 'development', PORT: 'not-a-number' })).toThrow();
  });

  it('формат: кривий DATABASE_URL (не URL) → кидає навіть у dev', () => {
    expect(() => validateEnv({ NODE_ENV: 'development', DATABASE_URL: 'not a url' })).toThrow();
  });

  it('формат: REDIS_URL має починатися з redis:// (кривий → кидає)', () => {
    expect(() => validateEnv({ NODE_ENV: 'development', REDIS_URL: 'http://x' })).toThrow(
      /redis:\/\//,
    );
    expect(() =>
      validateEnv({ NODE_ENV: 'development', REDIS_URL: 'redis://localhost:6379' }),
    ).not.toThrow();
  });

  it('PORT коерситься у number; NODE_ENV enum поза набором → кидає', () => {
    const r = validateEnv({ PORT: '8080' });
    expect(r.PORT).toBe(8080);
    expect(() => validateEnv({ NODE_ENV: 'staging' })).toThrow();
  });

  it('повідомлення агрегує кілька проблем (prod, кілька відсутніх)', () => {
    try {
      validateEnv({ NODE_ENV: 'production' });
      expect.unreachable('мало кинути');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('DATABASE_URL');
      expect(msg).toContain('JWT_ACCESS_SECRET');
      expect(msg).toContain('MINIO_ENDPOINT');
    }
  });

  it('NOTIFICATION_ENC_KEY: порожній рядок дозволений у dev (шифрування off)', () => {
    expect(() => validateEnv({ NODE_ENV: 'development', NOTIFICATION_ENC_KEY: '' })).not.toThrow();
  });

  it('envSchema експортується для повторного використання', () => {
    expect(envSchema.safeParse({}).success).toBe(true);
  });

  it('passthrough: невідомі змінні (POSTGRES_*/NEXT_PUBLIC_*) зберігаються у результаті', () => {
    const r = validateEnv({
      NODE_ENV: 'development',
      POSTGRES_USER: 'sto',
      NEXT_PUBLIC_API_URL: 'http://localhost:3000',
    });
    expect((r as Record<string, unknown>).POSTGRES_USER).toBe('sto');
    expect((r as Record<string, unknown>).NEXT_PUBLIC_API_URL).toBe('http://localhost:3000');
  });
});
