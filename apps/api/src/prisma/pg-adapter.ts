import { PrismaPg } from '@prisma/adapter-pg';

/**
 * Єдина точка створення driver-adapter для Prisma 7.
 *
 * Навіщо: Prisma 7 прибрав `url` зі схеми і `datasourceUrl` із конструктора — рантайм
 * отримує підключення ЛИШЕ через adapter (P1012). Без спільного хелпера той самий adapter
 * із тими самими параметрами пулу дублювався б у 8 місцях: PrismaService і 7
 * integration-специв.
 *
 * Параметри пулу перенесені 1:1 із колишнього `withConnectionPool`, який додавав їх
 * у query-рядок:
 *   connection_limit=25 → max: 25
 *   pool_timeout=20 (секунди) → connectionTimeoutMillis: 20_000
 * Втратити їх було б тихою регресією: дефолтний пул вужчий.
 */
const DEFAULT_MAX_CONNECTIONS = 25;
const DEFAULT_CONNECTION_TIMEOUT_MS = 20_000;

export function createPgAdapter(url?: string): PrismaPg {
  const connectionString = url ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL не заданий — Prisma 7 не створить adapter без нього.');
  }
  return new PrismaPg({
    connectionString,
    max: DEFAULT_MAX_CONNECTIONS,
    connectionTimeoutMillis: DEFAULT_CONNECTION_TIMEOUT_MS,
  });
}
