/**
 * SupplierPaymentsService.findAll() — сортування (whitelist orderBy)
 *
 * Виділено з `supplier-payments.service.spec.ts` (був 1410 рядків: 1235 з них — ОДИН
 * top-level describe із 56 тестами БЕЗ вкладених describe, секції розмічені лише
 * ASCII-швами автора) 2026-10-07. Кейси перенесені ДОСЛІВНО.
 *
 * Сетап — `makeSpHarness()` з `./supplier-payments.spec-fixture` (той самий beforeEach).
 */

import { it, expect } from 'vitest';
import { makeSpHarness, type SpHarness, ORG } from './supplier-payments.spec-fixture';

describe('SupplierPaymentsService — sort', () => {
  let service: SpHarness['service'];
  let prisma: SpHarness['prisma'];

  beforeEach(async () => {
    ({ service, prisma } = await makeSpHarness());
  });

  // ──────────────────────────────────────────────────────────────────────
  // findAll() — сортування (whitelist orderBy)
  // ──────────────────────────────────────────────────────────────────────

  function findManyOrderBy() {
    return (
      prisma.supplierPayment.findMany.mock.calls[0]![0] as {
        orderBy: Record<string, string>;
      }
    ).orderBy;
  }

  function findManyWhere() {
    return (
      prisma.supplierPayment.findMany.mock.calls[0]![0] as {
        where: Record<string, unknown>;
      }
    ).where;
  }

  it('findAll(): purchaseOrderId → where.purchaseOrderId (фільтр по замовленню)', async () => {
    const PO_ID = '55555555-5555-4555-8555-555555555555';
    await service.findAll(
      ORG,
      1,
      20,
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      undefined,
      PO_ID,
    );
    expect(findManyWhere()).toMatchObject({ orgId: ORG, purchaseOrderId: PO_ID });
  });

  // Відбір списку за датою. documentDate — дата БЕЗ часу (@db.Date): межі — самі календарні
  // дати, зсуву на київський пояс бути не повинно (він зачепив би попередній день).
  // Mutation-verify: `dateOnlyRangeFilter` → `kyivDayRangeFilter` — обидва кейси з датами падають.

  // guards: BR-PAY-018
  it('findAll(): dateFrom + dateTo → documentDate від 09.10 до 10.10 календарними датами, без зсуву на пояс', async () => {
    await service.findAll(
      ORG,
      1,
      20,
      undefined,
      undefined,
      undefined,
      false,
      '2026-10-09',
      '2026-10-10',
    );
    const where = findManyWhere();
    expect(where.documentDate).toEqual({
      gte: new Date('2026-10-09T00:00:00.000Z'),
      lte: new Date('2026-10-10T00:00:00.000Z'),
    });
    expect(where.orgId).toBe(ORG);
    expect((prisma.supplierPayment.count.mock.calls[0]![0] as { where: unknown }).where).toEqual(
      where,
    );
  });

  // guards: BR-PAY-018
  it('findAll(): лише dateFrom → у documentDate тільки нижня межа, сама дата', async () => {
    await service.findAll(ORG, 1, 20, undefined, undefined, undefined, false, '2026-01-15');
    expect(findManyWhere().documentDate).toEqual({ gte: new Date('2026-01-15T00:00:00.000Z') });
  });

  it('findAll(): без дат — умови на documentDate немає', async () => {
    await service.findAll(ORG, 1, 20);
    expect(findManyWhere()).not.toHaveProperty('documentDate');
  });

  it('findAll(): валідний sortBy=amount + sortDir=asc → orderBy { amount: asc }', async () => {
    await service.findAll(
      ORG,
      1,
      20,
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      'amount',
      'asc',
    );
    expect(findManyOrderBy()).toEqual({ amount: 'asc' });
  });

  it('findAll(): sortBy=documentDate → orderBy { documentDate: desc } (default dir)', async () => {
    await service.findAll(
      ORG,
      1,
      20,
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      'documentDate',
    );
    expect(findManyOrderBy()).toEqual({ documentDate: 'desc' });
  });

  it('findAll(): невідомий sortBy → fallback orderBy { createdAt: desc }', async () => {
    await service.findAll(
      ORG,
      1,
      20,
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      'DROP TABLE',
      'asc',
    );
    // Невідоме поле → повний fallback createdAt desc; asc ігнорується
    // (напрям без валідного поля не має сенсу, інакше garbage sortBy тихо міняє порядок).
    expect(findManyOrderBy()).toEqual({ createdAt: 'desc' });
  });

  it('findAll(): валідне поле + asc зберігає напрям (createdAt asc)', async () => {
    await service.findAll(
      ORG,
      1,
      20,
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      'createdAt',
      'asc',
    );
    expect(findManyOrderBy()).toEqual({ createdAt: 'asc' });
  });

  it('findAll(): без sort-параметрів → orderBy { createdAt: desc }', async () => {
    await service.findAll(ORG, 1, 20);
    expect(findManyOrderBy()).toEqual({ createdAt: 'desc' });
  });
});
