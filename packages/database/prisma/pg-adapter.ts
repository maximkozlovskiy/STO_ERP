import path from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';

/**
 * Driver-adapter для seed-скриптів (`prisma db seed` і прямий `ts-node prisma/seed.ts`).
 *
 * Чому локальна копія, а не імпорт з apps/api: seed виконується в межах пакета
 * @sto/database через ts-node і не має доступу до tsconfig/paths апки.
 *
 * Prisma 7 прибрав `url` зі схеми і `datasourceUrl` із конструктора — рантайм
 * отримує підключення ЛИШЕ через adapter.
 *
 * `loadEnvFile` тут ОБОВ'ЯЗКОВИЙ: раніше `new PrismaClient()` сам читав `.env` і
 * `env("DATABASE_URL")` зі схеми. Тепер URL треба мати в process.env ДО створення
 * adapter'а. Через `prisma db seed` його підвантажує prisma.config.ts, але при
 * прямому запуску (`ts-node prisma/seed-catalog.ts`, як описано в його ж хедері)
 * конфіг не виконується — без цього рядка скрипт падав би на відсутньому URL.
 */
process.loadEnvFile?.(path.join(__dirname, '..', '.env'));

export function createPgAdapter(url?: string): PrismaPg {
  const connectionString = url ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL не заданий — Prisma 7 не створить adapter без нього.');
  }
  return new PrismaPg({
    connectionString,
    // Пул вузький навмисно: seed — однопотоковий скрипт, 25 з'єднань як в API не потрібні.
    max: 5,
    connectionTimeoutMillis: 20_000,
  });
}
