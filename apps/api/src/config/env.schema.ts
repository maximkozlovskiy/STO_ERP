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
    // Порожнє → шифрування вимкнено (dev). У prod обовʼязкове + ≥32 (superRefine нижче).
    // Довжину НЕ валідуємо тут (лише presence-формат): EncryptionService.onModuleInit
    // нормалізує БУДЬ-ЯКУ непорожню довжину через SHA-256 → 32 байти, тож короткий dev-ключ
    // працює у рантаймі. Жорсткий мінімум ≥32 — це prod-hardening проти слабкої ентропії,
    // а не формат; тримаємо його у prod-gated superRefine, щоб не блокувати dev-старт.
    NOTIFICATION_ENC_KEY: z.string().optional(),

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
  .passthrough();

export type Env = z.infer<typeof envSchema>;

/**
 * prod-strict presence/entropy-перевірка — виконується НЕЗАЛЕЖНО від base-parse.
 *
 * ЧОМУ не `.superRefine` на схемі: Zod пропускає object-level refinement, якщо base-parse
 * дав issues (напр. кривий PORT). Це короткозамикало агрегацію — оператор бачив лише
 * «PORT: Expected number», а перелік відсутніх prod-секретів зникав, і виправляти доводилось
 * ітеративно (по одному рестарту на змінну). Тут перевіряємо RAW-config завжди, тож
 * повідомлення про кривий формат І про відсутні prod-секрети агрегуються в ОДИН перелік.
 *
 * Працює по сирих значеннях `process.env` (усе — рядки або undefined), тому перевіряємо
 * presence як «undefined або порожній рядок» — coerce ще не застосований, це навмисно.
 */
interface Issue {
  path: string;
  message: string;
}
function checkProdStrict(config: Record<string, unknown>): Issue[] {
  if (!isProd(config.NODE_ENV)) return [];
  const issues: Issue[] = [];
  const isBlank = (v: unknown) => v === undefined || v === null || v === '';
  const requireInProd = (key: string, message: string) => {
    if (isBlank(config[key])) issues.push({ path: key, message });
  };
  requireInProd('DATABASE_URL', 'DATABASE_URL обовʼязковий у production');
  requireInProd('JWT_ACCESS_SECRET', 'JWT_ACCESS_SECRET обовʼязковий у production');
  requireInProd('JWT_REFRESH_SECRET', 'JWT_REFRESH_SECRET обовʼязковий у production');
  requireInProd('MINIO_ENDPOINT', 'MINIO_ENDPOINT обовʼязковий у production');
  // MINIO_PORT — hard-dep: files.service.ts робить getOrThrow('MINIO_PORT') у конструкторі,
  // тож без нього FilesService падає при старті модуля. Централізуємо fail-fast сюди,
  // щоб оператор бачив причину у переліку, а не у стектрейсі DI при піднятті.
  requireInProd('MINIO_PORT', 'MINIO_PORT обовʼязковий у production');
  requireInProd('MINIO_ACCESS_KEY', 'MINIO_ACCESS_KEY обовʼязковий у production');
  requireInProd('MINIO_SECRET_KEY', 'MINIO_SECRET_KEY обовʼязковий у production');
  requireInProd('MINIO_BUCKET', 'MINIO_BUCKET обовʼязковий у production');
  // NOTIFICATION_ENC_KEY у prod: обовʼязковий І ≥32 символів (hardening проти слабкої
  // ентропії ключа шифрування секретів at-rest). У dev короткий ключ дозволено —
  // EncryptionService нормалізує його через SHA-256 (див. коментар до поля вище).
  // WEB_ORIGIN: без нього CORS мовчки падає на dev-fallback `DEV_WEB_ORIGINS`
  // (`http://localhost:3001` і `:3002`, див. common/cors.options.ts).
  // У поточному розгортанні web і API за одним Caddy (same-origin), тож CORS не задіяний
  // і шкоди немає — але конфіг, що ТИХО деградує у проді, рано чи пізно вистрілить на
  // окремому домені API чи мобільному web-клієнті. Краще не стартувати, ніж стартувати
  // з origin, якого в проді не існує.
  requireInProd(
    'WEB_ORIGIN',
    'WEB_ORIGIN обовʼязковий у production (інакше CORS бере dev-fallback)',
  );
  const encKey = config.NOTIFICATION_ENC_KEY;
  if (isBlank(encKey)) {
    issues.push({
      path: 'NOTIFICATION_ENC_KEY',
      message: 'NOTIFICATION_ENC_KEY обовʼязковий у production (шифрування секретів at-rest)',
    });
  } else if (typeof encKey === 'string' && encKey.length < 32) {
    issues.push({
      path: 'NOTIFICATION_ENC_KEY',
      message: 'NOTIFICATION_ENC_KEY має бути ≥ 32 символів у production',
    });
  }
  return issues;
}

/**
 * `validate`-функція для `ConfigModule.forRoot({ validate })`. Nest викликає її ОДИН раз при
 * старті з повним `process.env`. Кидаємо з агрегованим списком УСІХ проблем (формат +
 * prod-strict presence) — контейнер не підніметься, оператор бачить повний перелік кривих/
 * відсутніх змінних за один рестарт.
 */
export function validateEnv(config: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(config);
  const formatIssues: Issue[] = parsed.success
    ? []
    : parsed.error.issues.map(i => ({ path: i.path.join('.') || '(root)', message: i.message }));
  // prod-strict завжди виконується — навіть коли base-parse дав format-issues (див. коментар
  // до checkProdStrict): без цього перелік відсутніх prod-секретів короткозамикався.
  const prodIssues = checkProdStrict(config);
  const allIssues = [...formatIssues, ...prodIssues];

  if (allIssues.length > 0) {
    const details = allIssues.map(i => `  • ${i.path}: ${i.message}`).join('\n');
    throw new Error(
      `❌ Помилка конфігурації середовища (.env) — застосунок не запущено:\n${details}\n` +
        `Перевірте .env / .env.dev (приклад — .env.example).`,
    );
  }
  return parsed.data as Env;
}
