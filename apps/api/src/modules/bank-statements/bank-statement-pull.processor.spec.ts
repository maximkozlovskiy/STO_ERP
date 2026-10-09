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
  let providerConfig: {
    resolveActive: ReturnType<typeof vi.fn>;
    resolveByCode: ReturnType<typeof vi.fn>;
  };
  let providerImpl: { fetchStatements: ReturnType<typeof vi.fn> };
  let registry: { get: ReturnType<typeof vi.fn> };
  let reconciliation: {
    applyImport: ReturnType<typeof vi.fn>;
    resolveBatch: ReturnType<typeof vi.fn>;
    matchTransaction: ReturnType<typeof vi.fn>;
    reconcile: ReturnType<typeof vi.fn>;
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
        findFirst: vi.fn().mockResolvedValue({ id: 'tx-1', direction: 'IN' }),
      },
    };
    providerConfig = {
      resolveActive: vi.fn().mockResolvedValue({
        provider: 'privat24',
        apiUrl: null,
        credentials: { merchantId: 'M', token: 'T' },
      }),
      resolveByCode: vi.fn().mockResolvedValue({
        provider: 'monobank',
        apiUrl: null,
        credentials: { token: 'T', accountId: '0' },
      }),
    };
    providerImpl = { fetchStatements: vi.fn().mockResolvedValue([]) };
    registry = { get: vi.fn().mockReturnValue(providerImpl) };
    reconciliation = {
      applyImport: vi.fn().mockResolvedValue({ created: 1, skipped: 0 }),
      resolveBatch: vi.fn().mockResolvedValue(new Map()),
      matchTransaction: vi.fn().mockResolvedValue(undefined),
      reconcile: vi.fn().mockResolvedValue(undefined),
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

  // guards: BR-BANK-012, BR-BANK-016
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

  // guards: BR-BANK-011
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

  // guards: BR-BANK-012
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

  // guards: BR-BANK-012
  it('оновлює lastPulledAt курсор після успіху', async () => {
    providerImpl.fetchStatements.mockResolvedValue([rawTx('r1')]);
    await processor.process(makeJob({ orgId: ORG }));
    const lastCall = prisma.bankAccount.updateMany.mock.calls.at(-1);
    expect(lastCall).toBeDefined();
    const call = lastCall![0];
    expect(call.where).toMatchObject({ id: ACC, orgId: ORG, deletedAt: null });
    expect(call.data.lastPulledAt).toBeInstanceOf(Date);
  });

  // guards: BR-BANK-012
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

  // guards: BR-BANK-011
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

  // guards: BR-BANK-011
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

  // guards: BR-BANK-011
  it('confidence===1 але counterpartyId відсутній → НЕ матчиться (guard проти битого MatchResult)', async () => {
    providerImpl.fetchStatements.mockResolvedValue([rawTx('nocp')]);
    reconciliation.resolveBatch.mockResolvedValue(
      new Map([['nocp', { status: 'matched', confidence: 1, matchType: 'SERVICE' }]]),
    );
    await processor.process(makeJob({ orgId: ORG }));
    expect(reconciliation.matchTransaction).not.toHaveBeenCalled();
  });

  // guards: BR-BANK-012
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

  // guards: BR-BANK-012
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

  // ─── Multi-bank: provider-routing + source ────────────────────────────────────

  // guards: BR-BANK-001
  it('provider=monobank → resolveByCode (НЕ resolveActive) + source MONOBANK_API', async () => {
    prisma.bankAccount.findMany.mockResolvedValue([acctRow({ provider: 'monobank' })]);
    providerImpl.fetchStatements.mockResolvedValue([rawTx('m1')]);
    await processor.process(makeJob({ orgId: ORG }));
    expect(providerConfig.resolveByCode).toHaveBeenCalledWith(ORG, 'br-1', 'BANK', 'monobank');
    expect(providerConfig.resolveActive).not.toHaveBeenCalled();
    expect(reconciliation.applyImport).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({ bankAccountId: ACC }),
      'MONOBANK_API',
    );
  });

  // guards: BR-BANK-001
  it('provider=privat24 → resolveByCode + source PRIVAT24_API', async () => {
    prisma.bankAccount.findMany.mockResolvedValue([acctRow({ provider: 'privat24' })]);
    providerConfig.resolveByCode.mockResolvedValue({
      provider: 'privat24',
      apiUrl: null,
      credentials: { merchantId: 'M', token: 'T' },
    });
    providerImpl.fetchStatements.mockResolvedValue([rawTx('p1')]);
    await processor.process(makeJob({ orgId: ORG }));
    expect(providerConfig.resolveByCode).toHaveBeenCalledWith(ORG, 'br-1', 'BANK', 'privat24');
    expect(reconciliation.applyImport.mock.calls[0][2]).toBe('PRIVAT24_API');
  });

  it('provider=null → legacy-fallback resolveActive (source з активного провайдера)', async () => {
    // acctRow дефолт не має provider → resolveActive-гілка (зворотна сумісність).
    prisma.bankAccount.findMany.mockResolvedValue([acctRow()]);
    providerImpl.fetchStatements.mockResolvedValue([rawTx('l1')]);
    await processor.process(makeJob({ orgId: ORG }));
    expect(providerConfig.resolveActive).toHaveBeenCalled();
    expect(providerConfig.resolveByCode).not.toHaveBeenCalled();
    expect(reconciliation.applyImport.mock.calls[0][2]).toBe('PRIVAT24_API');
  });

  it('невідомий provider-код (не privat24/monobank) → source FILE_IMPORT дефолт', async () => {
    prisma.bankAccount.findMany.mockResolvedValue([acctRow({ provider: 'oschad' })]);
    providerConfig.resolveByCode.mockResolvedValue({
      provider: 'oschad',
      apiUrl: null,
      credentials: { token: 'T' },
    });
    providerImpl.fetchStatements.mockResolvedValue([rawTx('o1')]);
    await processor.process(makeJob({ orgId: ORG }));
    expect(reconciliation.applyImport.mock.calls[0][2]).toBe('FILE_IMPORT');
  });

  it('IntegrationLog ctx.provider = active.provider (НЕ хардкод privat24)', async () => {
    const wrapSpy = vi.fn((_c: unknown, fn: () => unknown) => fn());
    processor = new BankStatementPullProcessor(
      prisma as never,
      providerConfig as never,
      registry as never,
      reconciliation as never,
      { wrap: wrapSpy } as never,
      { capture: vi.fn() } as never,
    );
    prisma.bankAccount.findMany.mockResolvedValue([acctRow({ provider: 'monobank' })]);
    providerImpl.fetchStatements.mockResolvedValue([rawTx('m1')]);
    await processor.process(makeJob({ orgId: ORG }));
    expect(wrapSpy.mock.calls[0][0]).toMatchObject({ provider: 'monobank' });
  });

  // ─── Вихідні рядки (BR-BANK-017 / 022) ────────────────────────────────────────
  // Написано ДО реалізації (2026-10-09). `direction` у RawTx контракт ще не називає: провайдери
  // віддають його полем рядка (BR-BANK-019), процесор передає далі в ApplyRowDto.direction.
  // Mutation-verify: (1) не передавати `direction` у rows applyImport → «напрям рядка передається»;
  // (2) прибрати умову «лише IN» перед matchTransaction → обидва кейси «OUT … не розноситься».

  /** Рядки, що вже лежать у staging: findFirst шукає за externalId (і за direction, якщо задано). */
  function stage(rows: Array<{ id: string; externalId: string; direction: 'IN' | 'OUT' }>) {
    prisma.bankTransaction.findFirst.mockImplementation(
      (args: { where: { externalId?: string; direction?: string } }) =>
        Promise.resolve(
          rows.find(
            r =>
              r.externalId === args.where.externalId &&
              (args.where.direction === undefined || args.where.direction === r.direction),
          ) ?? null,
        ),
    );
  }

  const sure = (counterpartyId: string) => ({
    status: 'matched',
    confidence: 1,
    counterpartyId,
    matchType: 'SERVICE',
  });

  // guards: BR-BANK-017, BR-BANK-019
  it('напрям рядка передається в applyImport: OUT як OUT, IN як IN', async () => {
    providerImpl.fetchStatements.mockResolvedValue([
      rawTx('out-1', { direction: 'OUT', amount: 320.4 }),
      rawTx('in-1', { direction: 'IN', amount: 150 }),
    ]);
    await processor.process(makeJob({ orgId: ORG }));
    const rows = reconciliation.applyImport.mock.calls[0][1].rows as Array<{
      externalId: string;
      direction?: string;
      amount: number;
    }>;
    expect(rows.map(r => [r.externalId, r.direction, r.amount])).toEqual([
      ['out-1', 'OUT', 320.4],
      ['in-1', 'IN', 150],
    ]);
  });

  // guards: BR-BANK-022
  it('OUT-рядок з упевненим збігом (confidence 1) сам НЕ розноситься — ні match, ні reconcile', async () => {
    providerImpl.fetchStatements.mockResolvedValue([rawTx('out-sure', { direction: 'OUT' })]);
    reconciliation.resolveBatch.mockResolvedValue(new Map([['out-sure', sure('cp-1')]]));
    stage([{ id: 'tx-out', externalId: 'out-sure', direction: 'OUT' }]);

    await processor.process(makeJob({ orgId: ORG }));

    expect(reconciliation.matchTransaction).not.toHaveBeenCalled();
    expect(reconciliation.reconcile).not.toHaveBeenCalled();
    // Рядок усе одно у staging, курсор рухається: людина рознесе вручну.
    expect(reconciliation.applyImport).toHaveBeenCalledTimes(1);
    expect(prisma.bankAccount.updateMany).toHaveBeenCalled();
  });

  // Підказка для вихідного рядка (BR-BANK-036) — теж лише підказка.
  // guards: BR-BANK-022
  it('OUT-рядок з підказкою SUPPLIER_PAYMENT і confidence 1 теж лишається нерознесеним', async () => {
    providerImpl.fetchStatements.mockResolvedValue([rawTx('out-sup', { direction: 'OUT' })]);
    reconciliation.resolveBatch.mockResolvedValue(
      new Map([['out-sup', { ...sure('cp-sup'), matchType: 'SUPPLIER_PAYMENT' }]]),
    );
    stage([{ id: 'tx-out', externalId: 'out-sup', direction: 'OUT' }]);

    await processor.process(makeJob({ orgId: ORG }));

    expect(reconciliation.matchTransaction).not.toHaveBeenCalled();
    expect(reconciliation.reconcile).not.toHaveBeenCalled();
  });

  // guards: BR-BANK-011, BR-BANK-022
  it('змішаний батч: розноситься лише IN-рядок, OUT із тим самим збігом — ні', async () => {
    providerImpl.fetchStatements.mockResolvedValue([
      rawTx('out-sure', { direction: 'OUT' }),
      rawTx('in-sure', { direction: 'IN' }),
    ]);
    reconciliation.resolveBatch.mockResolvedValue(
      new Map([
        ['out-sure', sure('cp-1')],
        ['in-sure', sure('cp-1')],
      ]),
    );
    stage([
      { id: 'tx-out', externalId: 'out-sure', direction: 'OUT' },
      { id: 'tx-in', externalId: 'in-sure', direction: 'IN' },
    ]);

    await processor.process(makeJob({ orgId: ORG }));

    expect(reconciliation.matchTransaction).toHaveBeenCalledTimes(1);
    const [orgArg, txIdArg, dtoArg] = reconciliation.matchTransaction.mock.calls[0];
    expect([orgArg, txIdArg]).toEqual([ORG, 'tx-in']);
    expect(dtoArg).toMatchObject({ counterpartyId: 'cp-1', type: 'SERVICE' });
    expect(reconciliation.reconcile).not.toHaveBeenCalled();
  });
});
