import { vi } from 'vitest';

/**
 * Спільні типи для рукописних Prisma-моків у спеках.
 *
 * Навіщо: раніше кожен спек оголошував власну анотацію виду
 * `{ findMany: any; count: any; findFirst: any }`, перелічуючи РІВНО ті методи, які сам
 * використовує. Щойно тест домальовував ще один метод на льоту
 * (`prisma.x.findFirstOrThrow = vi.fn()`), анотація переставала відповідати реальності —
 * і це не помічалось, бо `*.spec.ts` були виключені з `tsc`. Після вмикання type-check
 * для тестів такі розбіжності стали помилками (31 × TS2339).
 *
 * Рішення — `PrismaModelMock`: делегат, у якого будь-який метод Prisma присутній і
 * типізований як мок. Це свідомо дозвільний тип: мета тут не відтворити справжні сигнатури
 * Prisma (для цього існує `vitest-mock-extended`), а прибрати ручний перелік методів, який
 * розсинхронізовувався. Сигнатури лишаються нестрогими, бо спеки передають часткові об'єкти.
 */
export type PrismaMockFn = ReturnType<typeof vi.fn>;

/** Делегат моделі: будь-який метод (`findFirst`, `findFirstOrThrow`, `upsert`, …) — це мок. */
export type PrismaModelMock = Record<string, PrismaMockFn>;

/**
 * Створює делегат моделі з переліку методів. Методи, не названі явно, усе одно доступні
 * за типом — їх можна домалювати у тесті без правки анотації.
 */
export function modelMock(...methods: string[]): PrismaModelMock {
  const out: PrismaModelMock = {};
  for (const m of methods) out[m] = vi.fn();
  return out;
}
