import path from 'node:path';
import { defineConfig } from 'prisma/config';

// Prisma 6+ з конфіг-файлом НЕ читає .env сама («Prisma config detected, skipping
// environment variable loading») — DATABASE_URL треба підвантажити явно, інакше
// `migrate status`/`deploy` падають на валідації datasource.
//
// try/catch ОБОВ'ЯЗКОВИЙ: у CI файлу .env немає (змінні приходять із env job-а), а
// loadEnvFile кидає ENOENT на відсутньому файлі — і тоді падає завантаження всього
// конфігу, тобто `prisma generate` у quality-job. Перевірено: без .env помилка
// «Failed to load config file … ENOENT».
try {
  process.loadEnvFile?.(path.join(__dirname, '.env'));
} catch {
  // .env немає — читаємо DATABASE_URL із середовища (CI, Docker, прод).
}

/**
 * Конфіг Prisma. Замінює блок `prisma` у package.json — той deprecated і зникає у Prisma 7.
 *
 * `migrations.path` ОБОВ'ЯЗКОВИЙ: при `schema: prisma/schema` (multi-file схема,
 * prismaSchemaFolder) Prisma 6+ шукає міграції відносно теки схеми, тобто у
 * `prisma/schema/migrations`. Наші 145 міграцій лежать у `prisma/migrations` — без цього
 * шляху `migrate status` казав «No migration found», а `migrate deploy` у CI не застосував
 * би НІЧОГО, тихо й успішно.
 */
export default defineConfig({
  schema: path.join('prisma', 'schema'),
  // Prisma 7: `url` зі схеми прибрано, рядок підключення для Migrate/CLI живе тут.
  datasource: { url: process.env.DATABASE_URL },
  // Той самий патерн, що з міграціями: typedSql шукає теку `sql/` відносно схеми
  // (prisma/schema/sql), а вона в prisma/sql → ENOENT при `generate --sql`.
  typedSql: { path: path.join('prisma', 'sql') },
  migrations: {
    path: path.join('prisma', 'migrations'),
    seed: 'ts-node prisma/seed-catalog.ts && ts-node prisma/seed.ts',
  },
});
