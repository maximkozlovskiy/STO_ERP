import { describe, it, expect, beforeEach } from 'vitest';
import type { BankReconciliationService } from './bank-reconciliation.service';
import {
  ORG,
  CP,
  build,
  makeExchange,
  makePayments,
  makePrisma,
} from './bank-reconciliation.spec-fixture';

// Аспект: авто-матч рядка виписки з контрагентом (resolveBatch). Правила BR-BANK — docs/objects/bank-statements.md.
// Кожен кейс доведений мутацією продукт-коду (зламав правило → червоний → відкотив).

describe('BankReconciliationService.resolveBatch — пріоритет каскаду і неоднозначність', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let service: BankReconciliationService;

  /** counterparty.findMany відповідає залежно від ознаки у where (iban / edrpou). */
  function counterpartiesBy(byIban: unknown[], byEdrpou: unknown[]) {
    prisma.counterparty.findMany.mockImplementation(
      async (args: { where: { iban?: unknown; edrpou?: unknown } }) =>
        args.where.iban ? byIban : args.where.edrpou ? byEdrpou : [],
    );
  }

  beforeEach(async () => {
    prisma = makePrisma();
    prisma.counterparty.findMany.mockResolvedValue([]);
    prisma.invoice.findMany.mockResolvedValue([]);
    prisma.workOrder.findMany.mockResolvedValue([]);
    service = await build(prisma, makeExchange(), makePayments());
  });

  // guards: BR-BANK-004
  it('IBAN має пріоритет над ЄДРПОУ: рядок з обома ознаками → контрагент за IBAN, confidence 1', async () => {
    counterpartiesBy([CP('cp-iban', { iban: 'UA111' })], [CP('cp-edr', { edrpou: '12345678' })]);
    const res = await service.resolveBatch(ORG, [
      {
        externalId: 'e1',
        operationDate: new Date(),
        amount: 100,
        payerIban: 'UA111',
        payerEdrpou: '12345678',
      },
    ]);
    const m = res.get('e1')!;
    expect(m.counterpartyId).toBe('cp-iban');
    expect(m.confidence).toBe(1);
    expect(m.reason).toBe('iban');
  });

  // guards: BR-BANK-004
  it('purpose → наряд (WO-…) → matched SERVICE confidence 0.7, без invoiceId', async () => {
    prisma.workOrder.findMany.mockResolvedValueOnce([
      {
        id: 'wo-1',
        number: '2026-0042',
        counterpartyId: 'cp-wo',
        counterparty: { companyName: null, firstName: 'Іван', lastName: 'Петренко' },
      },
    ]);
    const res = await service.resolveBatch(ORG, [
      { externalId: 'e1', operationDate: new Date(), amount: 100, purpose: 'Оплата WO-2026-0042' },
    ]);
    const m = res.get('e1')!;
    expect(m.status).toBe('matched');
    expect(m.counterpartyId).toBe('cp-wo');
    expect(m.counterpartyName).toBe('Петренко Іван');
    expect(m.matchType).toBe('SERVICE');
    expect(m.invoiceId).toBeUndefined();
    expect(m.confidence).toBe(0.7);
    expect(m.reason).toBe('purpose');
  });

  // guards: BR-BANK-005
  it('ЄДРПОУ >1 → ambiguous з кандидатами, reason edrpou (контрагент не вгадується)', async () => {
    counterpartiesBy([], [CP('cp-1', { edrpou: '12345678' }), CP('cp-2', { edrpou: '12345678' })]);
    const res = await service.resolveBatch(ORG, [
      { externalId: 'e1', operationDate: new Date(), amount: 100, payerEdrpou: '12345678' },
    ]);
    const m = res.get('e1')!;
    expect(m.status).toBe('ambiguous');
    expect(m.reason).toBe('edrpou');
    expect(m.counterpartyId).toBeUndefined();
    expect(m.candidates.map(c => c.counterpartyId)).toEqual(['cp-1', 'cp-2']);
  });

  // guards: BR-BANK-005
  it('неоднозначний IBAN зупиняє каскад: однозначний ЄДРПОУ того ж рядка його НЕ розв’язує', async () => {
    counterpartiesBy(
      [CP('cp-1', { iban: 'UA999' }), CP('cp-2', { iban: 'UA999' })],
      [CP('cp-edr', { edrpou: '12345678' })],
    );
    const res = await service.resolveBatch(ORG, [
      {
        externalId: 'e1',
        operationDate: new Date(),
        amount: 100,
        payerIban: 'UA999',
        payerEdrpou: '12345678',
      },
    ]);
    const m = res.get('e1')!;
    expect(m.status).toBe('ambiguous');
    expect(m.reason).toBe('iban');
    expect(m.counterpartyId).toBeUndefined();
  });
});

describe('BankReconciliationService.resolveBatch — tenant-фільтр', () => {
  // guards: BR-BANK-016
  it('resolveBatch: контрагенти, рахунки-фактури й наряди шукаються лише у своїй orgId і невидалені', async () => {
    const prisma = makePrisma();
    prisma.counterparty.findMany.mockResolvedValue([]);
    prisma.invoice.findMany.mockResolvedValue([]);
    prisma.workOrder.findMany.mockResolvedValue([]);
    const service = await build(prisma, makeExchange(), makePayments());
    await service.resolveBatch(ORG, [
      {
        externalId: 'e1',
        operationDate: new Date(),
        amount: 100,
        payerIban: 'UA1',
        payerEdrpou: '12345678',
        purpose: 'рахунок №77, наряд №15',
      },
    ]);
    const tenant = { orgId: ORG, deletedAt: null };
    expect(prisma.counterparty.findMany).toHaveBeenCalledTimes(2);
    expect(prisma.counterparty.findMany.mock.calls[0]![0].where).toMatchObject(tenant);
    expect(prisma.counterparty.findMany.mock.calls[1]![0].where).toMatchObject(tenant);
    expect(prisma.invoice.findMany.mock.calls[0]![0].where).toMatchObject(tenant);
    expect(prisma.workOrder.findMany.mock.calls[0]![0].where).toMatchObject(tenant);
  });
});
