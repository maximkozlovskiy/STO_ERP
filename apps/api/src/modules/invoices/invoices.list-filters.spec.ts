/**
 * InvoicesService.findAll — відбір списку за контрагентом і кількома статусами.
 *
 * Пікер рахунку у вікні вхідного рознесення банківського платежу відбирає рахунки платника,
 * які ще можна оплатити (SENT / PARTIALLY_PAID / OVERDUE). Раніше `counterpartyId` у запиті
 * давав 400, і відбір робився на клієнті по перших 200 рядках.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { makeInvoicesHarness, ORG, type InvoicesHarness } from './invoices.spec-fixture';

describe('InvoicesService.findAll — counterpartyId і statuses', () => {
  let service: InvoicesHarness['service'];
  let findMany: ReturnType<typeof vi.fn>;
  let count: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const harness = await makeInvoicesHarness();
    service = harness.service;
    findMany = vi.fn().mockResolvedValue([]);
    count = vi.fn().mockResolvedValue(0);
    Object.assign(harness.prisma.invoice, { findMany, count });
  });

  const where = (call = 0) =>
    (findMany.mock.calls[call]![0] as { where: Record<string, unknown> }).where;

  it('counterpartyId → у where, orgId лишається', async () => {
    await service.findAll(
      ORG,
      1,
      20,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        counterpartyId: 'cp-1',
      },
    );
    expect(where()).toMatchObject({ orgId: ORG, counterpartyId: 'cp-1', deletedAt: null });
    expect((count.mock.calls[0]![0] as { where: Record<string, unknown> }).where).toMatchObject({
      counterpartyId: 'cp-1',
    });
  });

  it('statuses → status in [...]', async () => {
    await service.findAll(
      ORG,
      1,
      20,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        statuses: ['SENT', 'OVERDUE'],
      },
    );
    expect(where().AND).toEqual([{ status: { in: ['SENT', 'OVERDUE'] } }]);
  });

  it('status разом із statuses → обидві умови (перетин), статус не затирається', async () => {
    await service.findAll(
      ORG,
      1,
      20,
      'SENT',
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        statuses: ['OVERDUE'],
      },
    );
    expect(where().status).toBe('SENT');
    expect(where().AND).toEqual([{ status: { in: ['OVERDUE'] } }]);
  });

  it('без фільтрів → ні counterpartyId, ні AND у where', async () => {
    await service.findAll(ORG, 1, 20);
    expect(where()).not.toHaveProperty('counterpartyId');
    expect(where()).not.toHaveProperty('AND');
  });

  it('q разом із counterpartyId → OR пошуку не затирає відбір за контрагентом', async () => {
    await service.findAll(
      ORG,
      1,
      20,
      undefined,
      'INV',
      false,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        counterpartyId: 'cp-1',
      },
    );
    expect(where().counterpartyId).toBe('cp-1');
    expect(where().OR).toBeDefined();
  });
});
