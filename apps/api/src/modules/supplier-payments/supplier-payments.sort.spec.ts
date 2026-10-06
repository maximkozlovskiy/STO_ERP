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
