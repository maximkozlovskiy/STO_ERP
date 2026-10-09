/**
 * InvoicesService.findAll — відбір списку рахунків за датою документа.
 *
 * `documentDate` — дата БЕЗ часу (`@db.Date`): межі `dateFrom` / `dateTo` — самі календарні дати,
 * обидві включні. Зсуву на київський пояс тут бути не повинно: для колонки-дати `gte 08.10T21:00Z`
 * — це вже 08.10, і у відбір «з 09.10» потрапив би попередній день (клас Bug #798). Мітки часу
 * (`createdAt` оплат, каси, рухів складу) рахуються інакше — київською добою, BR-PAY-018.
 *
 * Mutation-verify (2026-10-09): `dateOnlyRangeFilter` → `kyivDayRangeFilter` у `findAll` — падають
 * три кейси з міткою guards (межі з'їжджають на 21:00Z / 20:59:59.999Z).
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { makeInvoicesHarness, ORG, type InvoicesHarness } from './invoices.spec-fixture';

describe('InvoicesService.findAll — відбір за датою документа', () => {
  let service: InvoicesHarness['service'];
  let findMany: ReturnType<typeof vi.fn>;
  let count: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const harness = await makeInvoicesHarness();
    service = harness.service;
    // Харнес будувався під create/transition і списку не знає — доповнюємо його тут.
    findMany = vi.fn().mockResolvedValue([]);
    count = vi.fn().mockResolvedValue(0);
    Object.assign(harness.prisma.invoice, { findMany, count });
  });

  const list = (dateFrom?: string, dateTo?: string) =>
    service.findAll(ORG, 1, 20, undefined, undefined, false, dateFrom, dateTo);

  const where = (call = 0) =>
    (findMany.mock.calls[call]![0] as { where: Record<string, unknown> }).where;

  // guards: BR-PAY-018
  it('dateFrom + dateTo → documentDate від 09.10 до 10.10 календарними датами, без зсуву на пояс', async () => {
    await list('2026-10-09', '2026-10-10');
    expect(where().documentDate).toEqual({
      gte: new Date('2026-10-09T00:00:00.000Z'),
      lte: new Date('2026-10-10T00:00:00.000Z'),
    });
  });

  // Без мітки guards: під зсувом на пояс цей кейс лишається зеленим (північ UTC дати 09.10
  // потрапляє і в київську добу 09.10) — він стереже включність меж, а не відсутність зсуву.
  it('один день: рахунок з датою 09.10 входить у «09.10», сусідні дати — ні', async () => {
    await list('2026-10-09', '2026-10-09');
    const { gte, lte } = where().documentDate as { gte: Date; lte: Date };
    // Prisma віддає @db.Date як північ UTC цієї дати.
    const inRange = (ymd: string) => {
      const d = new Date(`${ymd}T00:00:00.000Z`);
      return d >= gte && d <= lte;
    };
    expect(inRange('2026-10-09')).toBe(true);
    expect(inRange('2026-10-08')).toBe(false);
    expect(inRange('2026-10-10')).toBe(false);
  });

  // guards: BR-PAY-018
  it('зимова дата і дні переведення годинника — так само без зсуву', async () => {
    await list('2026-01-15', '2026-03-29');
    await list('2026-10-25', '2026-10-25');
    expect(where(0).documentDate).toEqual({
      gte: new Date('2026-01-15T00:00:00.000Z'),
      lte: new Date('2026-03-29T00:00:00.000Z'),
    });
    expect(where(1).documentDate).toEqual({
      gte: new Date('2026-10-25T00:00:00.000Z'),
      lte: new Date('2026-10-25T00:00:00.000Z'),
    });
  });

  // guards: BR-PAY-018
  it('лише одна межа → у documentDate тільки вона', async () => {
    await list('2026-10-09', undefined);
    await list(undefined, '2026-10-10');
    expect(where(0).documentDate).toEqual({ gte: new Date('2026-10-09T00:00:00.000Z') });
    expect(where(1).documentDate).toEqual({ lte: new Date('2026-10-10T00:00:00.000Z') });
  });

  it('без дат — умови на documentDate немає', async () => {
    await list();
    expect(where()).not.toHaveProperty('documentDate');
  });

  it('відбір за датою не чіпає tenant-фільтр: orgId і deletedAt на місці, лічильник отримує той самий where', async () => {
    await list('2026-10-09', '2026-10-10');
    expect(where()).toMatchObject({ orgId: ORG, deletedAt: null });
    expect((count.mock.calls[0]![0] as { where: unknown }).where).toEqual(where());
  });
});
