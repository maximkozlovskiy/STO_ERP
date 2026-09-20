import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import { BankStatementPullProcessor } from './bank-statement-pull.processor';

/**
 * BankStatementPullProcessor — auto-pull Privat24 виписки. Доводимо: обробляються лише
 * autoPullEnabled рахунки; resolveActive null → skip; source='PRIVAT24_API'; ідемпотентність
 * (applyImport skipDuplicates); авто-матч ЛИШЕ confidence===1; оновлення lastPulledAt;
 * помилка одного рахунку не валить інші; failed → DLQ.
 */
function makeJob(data: { orgId: string }): Job<typeof data> {
  return { data } as Job<typeof data>;
}

describe('BankStatementPullProcessor', () => {
  let processor: BankStatementPullProcessor;
  let prisma: {
    bankAccount: { findMany: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> };
    bankTransaction: { findFirst: ReturnType<typeof vi.fn> };
  };
  let providerConfig: { resolveActive: ReturnType<typeof vi.fn> };
  let providerImpl: { fetchStatements: ReturnType<typeof vi.fn> };
  let registry: { get: ReturnType<typeof vi.fn> };
  let reconciliation: {
    applyImport: ReturnType<typeof vi.fn>;
    resolveBatch: ReturnType<typeof vi.fn>;
    matchTransaction: ReturnType<typeof vi.fn>;
  };

  const ORG = 'org-1';
  const ACC = 'acc-1';

  const acctRow = (over: Record<string, unknown> = {}) => ({
    id: ACC,
    ibanUA: 'UA1',
    branchId: 'br-1',
    lastPulledAt: null,
    currencyId: 'cur-1',
    ...over,
  });

  const rawTx = (externalId: string, over: Record<string, unknown> = {}) => ({
    externalId,
    operationDate: new Date('2026-09-05T10:00:00Z'),
    amount: 100,
    payerName: 'ТОВ Ромашка',
    ...over,
  });

  beforeEach(() => {
    prisma = {
      bankAccount: {
        findMany: vi.fn().mockResolvedValue([acctRow()]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      bankTransaction: {
        findFirst: vi.fn().mockResolvedValue({ id: 'tx-1' }),
      },
    };
    providerConfig = {
      resolveActive: vi.fn().mockResolvedValue({
        provider: 'privat24',
        apiUrl: null,
        credentials: { merchantId: 'M', token: 'T' },
      }),
    };
    providerImpl = { fetchStatements: vi.fn().mockResolvedValue([]) };
    registry = { get: vi.fn().mockReturnValue(providerImpl) };
    reconciliation = {
      applyImport: vi.fn().mockResolvedValue({ created: 1, skipped: 0 }),
      resolveBatch: vi.fn().mockResolvedValue(new Map()),
      matchTransaction: vi.fn().mockResolvedValue(undefined),
    };
    processor = new BankStatementPullProcessor(
      prisma as never,
      providerConfig as never,
      registry as never,
      reconciliation as never,
      { wrap: (_c: unknown, fn: () => unknown) => fn() } as never,
      { capture: vi.fn() } as never,
    );
  });

  it('findMany фільтрує лише autoPullEnabled рахунки в межах orgId', async () => {
    await processor.process(makeJob({ orgId: ORG }));
    expect(prisma.bankAccount.findMany.mock.calls[0][0].where).toMatchObject({
      orgId: ORG,
      deletedAt: null,
      autoPullEnabled: true,
    });
  });

  it('немає рахунків → рано виходить (не резолвить провайдер)', async () => {
    prisma.bankAccount.findMany.mockResolvedValue([]);
    await processor.process(makeJob({ orgId: ORG }));
    expect(providerConfig.resolveActive).not.toHaveBeenCalled();
  });

  it('resolveActive null → skip рахунку (без fetch/applyImport)', async () => {
    providerConfig.resolveActive.mockResolvedValue(null);
    await processor.process(makeJob({ orgId: ORG }));
    expect(providerImpl.fetchStatements).not.toHaveBeenCalled();
    expect(reconciliation.applyImport).not.toHaveBeenCalled();
  });

  it('applyImport викликається з source=PRIVAT24_API', async () => {
    providerImpl.fetchStatements.mockResolvedValue([rawTx('r1')]);
    await processor.process(makeJob({ orgId: ORG }));
    expect(reconciliation.applyImport).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({ bankAccountId: ACC }),
      'PRIVAT24_API',
    );
    // operationDate передано як ISO-рядок (ApplyRowDto shape).
    const dto = reconciliation.applyImport.mock.calls[0][1];
    expect(typeof dto.rows[0].operationDate).toBe('string');
  });

  it('авто-матч: confidence===1 → matchTransaction; confidence<1 → пропуск', async () => {
    providerImpl.fetchStatements.mockResolvedValue([rawTx('sure'), rawTx('weak')]);
    reconciliation.resolveBatch.mockResolvedValue(
      new Map([
        [
          'sure',
          { status: 'matched', confidence: 1, counterpartyId: 'cp-1', matchType: 'SERVICE' },
        ],
        [
          'weak',
          { status: 'matched', confidence: 0.9, counterpartyId: 'cp-2', matchType: 'SERVICE' },
        ],
      ]),
    );
    await processor.process(makeJob({ orgId: ORG }));
    expect(reconciliation.matchTransaction).toHaveBeenCalledTimes(1);
    expect(reconciliation.matchTransaction).toHaveBeenCalledWith(
      ORG,
      'tx-1',
      expect.objectContaining({ counterpartyId: 'cp-1', type: 'SERVICE' }),
    );
  });

  it('авто-матч: транзакція вже рознесена (findFirst null) → matchTransaction не викликається', async () => {
    providerImpl.fetchStatements.mockResolvedValue([rawTx('sure')]);
    reconciliation.resolveBatch.mockResolvedValue(
      new Map([
        [
          'sure',
          { status: 'matched', confidence: 1, counterpartyId: 'cp-1', matchType: 'SERVICE' },
        ],
      ]),
    );
    prisma.bankTransaction.findFirst.mockResolvedValue(null);
    await processor.process(makeJob({ orgId: ORG }));
    expect(reconciliation.matchTransaction).not.toHaveBeenCalled();
  });

  it('авто-матч: помилка matchTransaction не валить pull (log-and-continue)', async () => {
    providerImpl.fetchStatements.mockResolvedValue([rawTx('sure')]);
    reconciliation.resolveBatch.mockResolvedValue(
      new Map([
        [
          'sure',
          { status: 'matched', confidence: 1, counterpartyId: 'cp-1', matchType: 'SERVICE' },
        ],
      ]),
    );
    reconciliation.matchTransaction.mockRejectedValue(new Error('overpay'));
    await processor.process(makeJob({ orgId: ORG }));
    // lastPulledAt все одно оновлено (гроші у staging).
    expect(prisma.bankAccount.updateMany).toHaveBeenCalled();
  });

  it('оновлює lastPulledAt курсор після успіху', async () => {
    providerImpl.fetchStatements.mockResolvedValue([rawTx('r1')]);
    await processor.process(makeJob({ orgId: ORG }));
    const call = prisma.bankAccount.updateMany.mock.calls.at(-1)[0];
    expect(call.where).toMatchObject({ id: ACC, orgId: ORG, deletedAt: null });
    expect(call.data.lastPulledAt).toBeInstanceOf(Date);
  });

  it('порожній результат → все одно рухає курсор', async () => {
    providerImpl.fetchStatements.mockResolvedValue([]);
    await processor.process(makeJob({ orgId: ORG }));
    expect(reconciliation.applyImport).not.toHaveBeenCalled();
    expect(prisma.bankAccount.updateMany).toHaveBeenCalled();
  });

  it('ідемпотентність overlapping-window: повторний pull того ж externalId → 0 дубль-Payment', async () => {
    // Перший pull: транзакція UNMATCHED, авто-матч confidence===1 → matchTransaction.
    providerImpl.fetchStatements.mockResolvedValue([rawTx('dup-1')]);
    reconciliation.resolveBatch.mockResolvedValue(
      new Map([
        [
          'dup-1',
          { status: 'matched', confidence: 1, counterpartyId: 'cp-1', matchType: 'SERVICE' },
        ],
      ]),
    );
    await processor.process(makeJob({ orgId: ORG }));
    expect(reconciliation.matchTransaction).toHaveBeenCalledTimes(1);

    // Другий pull (overlapping window): той самий externalId. applyImport skipDuplicates → created:0;
    // транзакція вже MATCHED → findFirst({status:UNMATCHED}) === null → matchTransaction НЕ повторюється.
    reconciliation.matchTransaction.mockClear();
    reconciliation.applyImport.mockResolvedValue({ created: 0, skipped: 1 });
    prisma.bankTransaction.findFirst.mockResolvedValue(null); // вже не UNMATCHED
    await processor.process(makeJob({ orgId: ORG }));
    expect(reconciliation.matchTransaction).not.toHaveBeenCalled();
    // Гроші-безпека: жодного повторного Payment на повторному вікні.
  });

  it('авто-матч НЕ спрацьовує на ambiguous/notFound (confidence undefined) — гроші лишаються у staging', async () => {
    providerImpl.fetchStatements.mockResolvedValue([rawTx('amb'), rawTx('nf')]);
    reconciliation.resolveBatch.mockResolvedValue(
      new Map([
        [
          'amb',
          { status: 'ambiguous', candidates: [{ counterpartyId: 'a' }, { counterpartyId: 'b' }] },
        ],
        ['nf', { status: 'notFound', candidates: [] }],
      ]),
    );
    await processor.process(makeJob({ orgId: ORG }));
    expect(reconciliation.matchTransaction).not.toHaveBeenCalled();
  });

  it('авто-матч edrpou confidence 0.9 (matched, але <1) → НЕ авто-матчиться', async () => {
    providerImpl.fetchStatements.mockResolvedValue([rawTx('edr')]);
    reconciliation.resolveBatch.mockResolvedValue(
      new Map([
        [
          'edr',
          { status: 'matched', confidence: 0.9, counterpartyId: 'cp-9', matchType: 'SERVICE' },
        ],
      ]),
    );
    await processor.process(makeJob({ orgId: ORG }));
    expect(reconciliation.matchTransaction).not.toHaveBeenCalled();
  });

  it('confidence===1 але counterpartyId відсутній → НЕ матчиться (guard проти битого MatchResult)', async () => {
    providerImpl.fetchStatements.mockResolvedValue([rawTx('nocp')]);
    reconciliation.resolveBatch.mockResolvedValue(
      new Map([['nocp', { status: 'matched', confidence: 1, matchType: 'SERVICE' }]]),
    );
    await processor.process(makeJob({ orgId: ORG }));
    expect(reconciliation.matchTransaction).not.toHaveBeenCalled();
  });

  it('per-account isolation: рахунок що кидає applyImport → інші рахунки продовжують курсор', async () => {
    prisma.bankAccount.findMany.mockResolvedValue([
      acctRow({ id: 'acc-a' }),
      acctRow({ id: 'acc-b', ibanUA: 'UA2' }),
    ]);
    providerImpl.fetchStatements.mockResolvedValue([rawTx('r')]);
    // acc-a applyImport кидає, acc-b успішний.
    reconciliation.applyImport
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce({ created: 1, skipped: 0 });
    // Не має впасти весь job — обробка триває.
    await expect(processor.process(makeJob({ orgId: ORG }))).resolves.toBeUndefined();
    // acc-b курсор оновлено (per-account isolation тримає).
    const updatedAccIds = prisma.bankAccount.updateMany.mock.calls.map(c => c[0].where.id);
    expect(updatedAccIds).toContain('acc-b');
    expect(updatedAccIds).not.toContain('acc-a'); // acc-a курсор НЕ рухається (втрати даних немає)
  });

  it('помилка fetchStatements одного рахунку → інші обробляються', async () => {
    prisma.bankAccount.findMany.mockResolvedValue([
      acctRow({ id: 'acc-fail' }),
      acctRow({ id: 'acc-ok', ibanUA: 'UA2' }),
    ]);
    providerImpl.fetchStatements
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce([rawTx('r1')]);
    await processor.process(makeJob({ orgId: ORG }));
    // Другий рахунок все одно імпортовано.
    expect(reconciliation.applyImport).toHaveBeenCalledTimes(1);
    expect(reconciliation.applyImport.mock.calls[0][1].bankAccountId).toBe('acc-ok');
  });
});
