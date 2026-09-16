import { z } from 'zod';

/**
 * Валідація змінних середовища при СТАРТІ застосунку (fail-fast).
 *
 * Мета (аудит стеку, backend #1): контейнер із кривим `.env` падає на старті з чітким
 * повідомленням, а не на першому запиті, що зачепить відповідну змінну. Критично для
 * installer-моделі деплою на ПК СТО, де `.env` заповнює НЕ розробник, а інсталятор/оператор.
 *
 * Раніше fail-fast був розсіяний: `getOrThrow('JWT_ACCESS_SECRET')` спрацьовував при першому
 * логіні, `getOrThrow('MINIO_*')` — при першому аплоаді файлу, а криві PORT/URL могли тихо
 * деградувати. Тепер одна схема — одне джерело правди для конфігурації.
 *
 * ФІЛОСОФІЯ prod-strict / dev-lenient (дзеркалить EncryptionService.onModuleInit):
 * формат наявних змінних валідуємо ЗАВЖДИ (кривий PORT/DATABASE_URL падає скрізь), але
 * ОБОВʼЯЗКОВІСТЬ prod-критичних секретів (JWT, DATABASE_URL, MinIO, ENC_KEY) вимагаємо лише
 * коли NODE_ENV=production. У dev/test відсутність не валить (offline-first, локальні дефолти).
 */

const isProd = (v: unknown) => v === 'production';

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    TZ: z.string().optional(),

    // ── Бази даних / черги ──────────────────────────────────────────────────
    // DATABASE_URL — Prisma читає його напряму з process.env; тут валідуємо формат + presence.
    DATABASE_URL: z.string().url('DATABASE_URL має бути валідним URL').optional(),
    // REDIS_URL — має дефолт у app.module (redis://localhost:6379); валідуємо формат якщо задано.
    REDIS_URL: z
      .string()
      .refine(v => v.startsWith('redis://') || v.startsWith('rediss://'), {
        message: 'REDIS_URL має починатися з redis:// або rediss://',
      })
      .optional(),

    // ── JWT ─────────────────────────────────────────────────────────────────
    // min 32 символи (дзеркалить .env.example + §2.1 SECURITY: без fallback-секретів).
    JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET має бути ≥ 32 символів').optional(),
    JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET має бути ≥ 32 символів').optional(),
    JWT_ACCESS_EXPIRES_IN: z.string().optional(),
    JWT_REFRESH_EXPIRES_IN: z.string().optional(),

    // ── MinIO (файли) ────────────────────────────────────────────────────────
    MINIO_ENDPOINT: z.string().optional(),
    MINIO_PORT: z.coerce.number().int().min(1).max(65535).optional(),
    MINIO_ACCESS_KEY: z.string().optional(),
    MINIO_SECRET_KEY: z.string().optional(),
    MINIO_BUCKET: z.string().optional(),
    MINIO_USE_SSL: z.string().optional(),
    MINIO_PUBLIC_URL: z.string().url('MINIO_PUBLIC_URL має бути валідним URL').optional(),

    // ── Шифрування секретів at-rest ───────────────────────────────────────────
    // Порожнє → шифрування вимкнено (dev). У prod обовʼязкове (superRefine нижче).
    NOTIFICATION_ENC_KEY: z
      .string()
      .min(32, 'NOTIFICATION_ENC_KEY має бути ≥ 32 символів')
      .optional()
      .or(z.literal('')),

    // ── Web ───────────────────────────────────────────────────────────────────
    WEB_ORIGIN: z.string().url('WEB_ORIGIN має бути валідним URL').optional(),
    WEB_PUBLIC_URL: z.string().url('WEB_PUBLIC_URL має бути валідним URL').optional(),

    // ── Sentry (опційне; вимкнене у dev) ──────────────────────────────────────
    SENTRY_DSN: z.string().optional(),
    SENTRY_AUTH_TOKEN: z.string().optional(),
  })
  // passthrough: невідомі змінні (POSTGRES_*, NEXT_PUBLIC_*, TZ тощо, які споживаються поза
  // ConfigService — Prisma читає DATABASE_URL напряму, docker-compose читає POSTGRES_*) проходять
  // без валідації, щоб validate-повернення лишалось повним конфігом і ConfigService їх бачив.
  .passthrough()
  // prod-strict: ці змінні мусять бути присутні (не-порожні) у production.
  .superRefine((env, ctx) => {
    if (!isProd(env.NODE_ENV)) return;
    const requireInProd = (key: keyof typeof env, value: unknown, message: string) => {
      if (value === undefined || value === '') {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message });
      }
    };
    requireInProd('DATABASE_URL', env.DATABASE_URL, 'DATABASE_URL обовʼязковий у production');
    requireInProd(
      'JWT_ACCESS_SECRET',
      env.JWT_ACCESS_SECRET,
      'JWT_ACCESS_SECRET обовʼязковий у production',
    );
    requireInProd(
      'JWT_REFRESH_SECRET',
      env.JWT_REFRESH_SECRET,
      'JWT_REFRESH_SECRET обовʼязковий у production',
    );
    requireInProd('MINIO_ENDPOINT', env.MINIO_ENDPOINT, 'MINIO_ENDPOINT обовʼязковий у production');
    requireInProd(
      'MINIO_ACCESS_KEY',
      env.MINIO_ACCESS_KEY,
      'MINIO_ACCESS_KEY обовʼязковий у production',
    );
    requireInProd(
      'MINIO_SECRET_KEY',
      env.MINIO_SECRET_KEY,
      'MINIO_SECRET_KEY обовʼязковий у production',
    );
    requireInProd('MINIO_BUCKET', env.MINIO_BUCKET, 'MINIO_BUCKET обовʼязковий у production');
    requireInProd(
      'NOTIFICATION_ENC_KEY',
      env.NOTIFICATION_ENC_KEY,
      'NOTIFICATION_ENC_KEY обовʼязковий у production (шифрування секретів at-rest)',
    );
  });

export type Env = z.infer<typeof envSchema>;

/**
 * `validate`-функція для `ConfigModule.forRoot({ validate })`. Nest викликає її ОДИН раз при
 * старті з повним `process.env`. Кидаємо на першій же помилці з агрегованим списком —
 * контейнер не підніметься, оператор бачить точний перелік кривих/відсутніх змінних.
 */
export function validateEnv(config: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(config);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map(i => `  • ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(
      `❌ Помилка конфігурації середовища (.env) — застосунок не запущено:\n${details}\n` +
        `Перевірте .env / .env.dev (приклад — .env.example).`,
    );
  }
  return parsed.data;
}
