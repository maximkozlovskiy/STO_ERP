import { Test } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { SettlementsService } from './settlements.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ExchangeRatesService } from '../exchange-rates/exchange-rates.service';

describe('SettlementsService.createTransaction', () => {
  let service: SettlementsService;
  let prisma: {
    settlementAccount: { findFirst: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
    settlementTransaction: { create: ReturnType<typeof vi.fn> };
    $transaction: ReturnType<typeof vi.fn>;
  };
  let exchangeRates: { resolveBaseConversion: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    prisma = {
      settlementAccount: {
        findFirst: vi.fn(),
        update: vi.fn().mockResolvedValue({}),
      },
      settlementTransaction: {
        create: vi.fn().mockResolvedValue({}),
      },
      $transaction: vi
        .fn()
        .mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
    };
    // Дефолт: базова валюта (rate=1, amountBase=amount) — 7 UAH-викликачів не передають currencyId.
    exchangeRates = {
      resolveBaseConversion: vi
        .fn()
        .mockImplementation(async (_org: string, _cur: string, _date: Date, amount: number) => ({
          rateUsed: 1,
          amountBase: amount,
        })),
    };
    const module = await Test.createTestingModule({
      providers: [
        SettlementsService,
        { provide: PrismaService, useValue: prisma },
        { provide: ExchangeRatesService, useValue: exchangeRates },
      ],
    }).compile();
    service = module.get(SettlementsService);
  });

  const dto = (
    overrides: Partial<Parameters<SettlementsService['createTransaction']>[1]> = {},
  ) => ({
    counterpartyId: 'cp-1',
    type: 'CHARGE' as const,
    amount: 100,
    ...overrides,
  });

  // guards: BR-SETL-004
  it('кидає BadRequestException при amount = 0', async () => {
    await expect(service.createTransaction('org-1', dto({ amount: 0 }))).rejects.toThrow(
      BadRequestException,
    );
  });

  // guards: BR-SETL-004
  it('кидає BadRequestException при amount < 0', async () => {
    await expect(service.createTransaction('org-1', dto({ amount: -50 }))).rejects.toThrow(
      BadRequestException,
    );
  });

  // guards: BR-SETL-004
  it('кидає BadRequestException при amount = NaN', async () => {
    await expect(service.createTransaction('org-1', dto({ amount: NaN }))).rejects.toThrow(
      BadRequestException,
    );
  });

  // guards: BR-SETL-004
  it('кидає BadRequestException при amount = Infinity, нічого не пише', async () => {
    prisma.settlementAccount.findFirst.mockResolvedValue({ id: 'acc-1' });
    await expect(service.createTransaction('org-1', dto({ amount: Infinity }))).rejects.toThrow(
      BadRequestException,
    );
    expect(prisma.settlementTransaction.create).not.toHaveBeenCalled();
    expect(prisma.settlementAccount.update).not.toHaveBeenCalled();
  });

  // guards: BR-SETL-005, BR-CP-012
  it('кидає NotFoundException якщо немає SettlementAccount', async () => {
    prisma.settlementAccount.findFirst.mockResolvedValue(null);
    await expect(service.createTransaction('org-1', dto())).rejects.toThrow(NotFoundException);
  });

  // guards: BR-SETL-006
  it('рахунок шукається за організацією і контрагентом — чужа організація рахунку не бачить', async () => {
    prisma.settlementAccount.findFirst.mockResolvedValue({ id: 'acc-1' });
    await service.createTransaction('org-1', dto({ counterpartyId: 'cp-7' }));
    expect(prisma.settlementAccount.findFirst).toHaveBeenCalledWith({
      where: { orgId: 'org-1', counterpartyId: 'cp-7' },
      select: { id: true },
    });
  });

  // guards: BR-SETL-002
  it('з переданим tx пише журнал і баланс у транзакції викликача, власну не відкриває', async () => {
    const txClient = {
      settlementAccount: {
        findFirst: vi.fn().mockResolvedValue({ id: 'acc-tx' }),
        update: vi.fn().mockResolvedValue({}),
      },
      settlementTransaction: { create: vi.fn().mockResolvedValue({}) },
    };
    await service.createTransaction('org-1', dto({ amount: 100 }), txClient as never);
    expect(txClient.settlementTransaction.create).toHaveBeenCalledTimes(1);
    expect(txClient.settlementAccount.update).toHaveBeenCalledTimes(1);
    expect(txClient.settlementAccount.update).toHaveBeenCalledWith({
      where: { id: 'acc-tx', orgId: 'org-1' },
      data: { balance: { increment: 100 } },
    });
    // Поза транзакцією викликача — нічого: інакше відкат документа лишив би борг у журналі.
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.settlementAccount.findFirst).not.toHaveBeenCalled();
    expect(prisma.settlementTransaction.create).not.toHaveBeenCalled();
    expect(prisma.settlementAccount.update).not.toHaveBeenCalled();
  });

  // guards: BR-SETL-002
  it('без tx відкриває власну $transaction: рядок журналу і зміна балансу — в ній обидва', async () => {
    const txClient = {
      settlementAccount: {
        findFirst: vi.fn().mockResolvedValue({ id: 'acc-own' }),
        update: vi.fn().mockResolvedValue({}),
      },
      settlementTransaction: { create: vi.fn().mockResolvedValue({}) },
    };
    prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn(txClient),
    );
    await service.createTransaction('org-1', dto({ type: 'PAYMENT', amount: 40 }));
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(txClient.settlementTransaction.create).toHaveBeenCalledTimes(1);
    expect(txClient.settlementAccount.update).toHaveBeenCalledTimes(1);
    expect(txClient.settlementAccount.update).toHaveBeenCalledWith({
      where: { id: 'acc-own', orgId: 'org-1' },
      data: { balance: { increment: -40 } },
    });
    // Повз транзакцію (напряму через prisma) не пишеться нічого.
    expect(prisma.settlementTransaction.create).not.toHaveBeenCalled();
    expect(prisma.settlementAccount.update).not.toHaveBeenCalled();
  });

  // guards: BR-SETL-003, BR-SETL-006
  it('CHARGE інкрементує balance на +amount', async () => {
    prisma.settlementAccount.findFirst.mockResolvedValue({ id: 'acc-1' });
    await service.createTransaction('org-1', dto({ type: 'CHARGE', amount: 100 }));
    expect(prisma.settlementAccount.update).toHaveBeenCalledWith({
      where: { id: 'acc-1', orgId: 'org-1' },
      data: { balance: { increment: 100 } },
    });
  });

  // guards: BR-SETL-003
  it('PAYMENT декрементує balance на -amount', async () => {
    prisma.settlementAccount.findFirst.mockResolvedValue({ id: 'acc-1' });
    await service.createTransaction('org-1', dto({ type: 'PAYMENT', amount: 100 }));
    expect(prisma.settlementAccount.update).toHaveBeenCalledWith({
      where: { id: 'acc-1', orgId: 'org-1' },
      data: { balance: { increment: -100 } },
    });
  });

  // guards: BR-SETL-003
  it.each(['PREPAYMENT', 'REFUND', 'CREDIT_NOTE'] as const)(
    '%s декрементує balance на -amount',
    async type => {
      prisma.settlementAccount.findFirst.mockResolvedValue({ id: 'acc-1' });
      await service.createTransaction('org-1', dto({ type, amount: 50 }));
      expect(prisma.settlementAccount.update).toHaveBeenCalledWith({
        where: { id: 'acc-1', orgId: 'org-1' },
        data: { balance: { increment: -50 } },
      });
    },
  );

  // Постачальницькі типи — окрема семантика знаку (fix знаку балансу постачальника):
  // отримали товар (SUPPLIER_CHARGE) → ми винні (balance↓); заплатили/повернули → borg↑.
  // guards: BR-SETL-003
  it('SUPPLIER_CHARGE декрементує balance на -amount (ми винні постачальнику)', async () => {
    prisma.settlementAccount.findFirst.mockResolvedValue({ id: 'acc-1' });
    await service.createTransaction('org-1', dto({ type: 'SUPPLIER_CHARGE', amount: 100 }));
    expect(prisma.settlementAccount.update).toHaveBeenCalledWith({
      where: { id: 'acc-1', orgId: 'org-1' },
      data: { balance: { increment: -100 } },
    });
  });

  // guards: BR-SETL-003
  it.each(['SUPPLIER_PAYMENT', 'SUPPLIER_REFUND'] as const)(
    '%s інкрементує balance на +amount (наш борг постачальнику меншає)',
    async type => {
      prisma.settlementAccount.findFirst.mockResolvedValue({ id: 'acc-1' });
      await service.createTransaction('org-1', dto({ type, amount: 100 }));
      expect(prisma.settlementAccount.update).toHaveBeenCalledWith({
        where: { id: 'acc-1', orgId: 'org-1' },
        data: { balance: { increment: 100 } },
      });
    },
  );

  // guards: BR-SETL-006, BR-SETL-008
  it('створює settlementTransaction з усіма полями', async () => {
    prisma.settlementAccount.findFirst.mockResolvedValue({ id: 'acc-1' });
    await service.createTransaction(
      'org-1',
      dto({
        type: 'CHARGE',
        amount: 100,
        documentType: 'WorkOrder',
        documentId: 'wo-1',
        createdBy: 'emp-1',
        notes: 'test',
      }),
    );
    expect(prisma.settlementTransaction.create).toHaveBeenCalledWith({
      data: {
        orgId: 'org-1',
        settlementAccountId: 'acc-1',
        type: 'CHARGE',
        amount: 100,
        // Без currencyId → базова (rate=1, amountBase=amount) — BC для UAH-викликачів.
        currencyId: null,
        amountBase: 100,
        rateUsed: 1,
        documentType: 'WorkOrder',
        documentId: 'wo-1',
        notes: 'test',
        createdBy: 'emp-1',
      },
    });
  });

  // ── Мультивалюта (Фаза 2) ──────────────────────────────────────────────────
  // guards: BR-SETL-007
  it('без currencyId → base (rate=1, amountBase=amount), resolveBaseConversion не викликається', async () => {
    prisma.settlementAccount.findFirst.mockResolvedValue({ id: 'acc-1' });
    await service.createTransaction('org-1', dto({ type: 'CHARGE', amount: 250 }));
    expect(exchangeRates.resolveBaseConversion).not.toHaveBeenCalled();
    expect(prisma.settlementAccount.update).toHaveBeenCalledWith({
      where: { id: 'acc-1', orgId: 'org-1' },
      data: { balance: { increment: 250 } },
    });
  });

  // guards: BR-SETL-007
  it('з currencyId (USD) → balanceDelta від amountBase, не від amount', async () => {
    prisma.settlementAccount.findFirst.mockResolvedValue({ id: 'acc-1' });
    // 100 USD × курс 41.50 = 4150 UAH base
    exchangeRates.resolveBaseConversion.mockResolvedValue({ rateUsed: 41.5, amountBase: 4150 });
    await service.createTransaction(
      'org-1',
      dto({ type: 'PAYMENT', amount: 100, currencyId: 'usd-1' }),
    );
    expect(exchangeRates.resolveBaseConversion).toHaveBeenCalledWith(
      'org-1',
      'usd-1',
      expect.any(Date),
      100,
      false,
    );
    // PAYMENT = -1 → balance -= amountBase (4150), НЕ -100
    expect(prisma.settlementAccount.update).toHaveBeenCalledWith({
      where: { id: 'acc-1', orgId: 'org-1' },
      data: { balance: { increment: -4150 } },
    });
    expect(prisma.settlementTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        amount: 100,
        currencyId: 'usd-1',
        amountBase: 4150,
        rateUsed: 41.5,
      }),
    });
  });

  // Фаза 3: документні потоки передають date (дата події) + fallbackToLatest у resolveBaseConversion.
  // guards: BR-SETL-007
  it('пробрасує date + fallbackToLatest у resolveBaseConversion (документний потік)', async () => {
    prisma.settlementAccount.findFirst.mockResolvedValue({ id: 'acc-1' });
    exchangeRates.resolveBaseConversion.mockResolvedValue({ rateUsed: 41.5, amountBase: 4150 });
    const docDate = new Date('2026-01-01');
    await service.createTransaction(
      'org-1',
      dto({
        type: 'CHARGE',
        amount: 100,
        currencyId: 'usd-1',
        date: docDate,
        fallbackToLatest: true,
      }),
    );
    expect(exchangeRates.resolveBaseConversion).toHaveBeenCalledWith(
      'org-1',
      'usd-1',
      docDate,
      100,
      true,
    );
  });

  // guards: BR-SETL-007
  it('без date → new Date(); без fallbackToLatest → false (BC для Фази 2)', async () => {
    prisma.settlementAccount.findFirst.mockResolvedValue({ id: 'acc-1' });
    exchangeRates.resolveBaseConversion.mockResolvedValue({ rateUsed: 41.5, amountBase: 4150 });
    await service.createTransaction(
      'org-1',
      dto({ type: 'PAYMENT', amount: 100, currencyId: 'usd-1' }),
    );
    expect(exchangeRates.resolveBaseConversion).toHaveBeenCalledWith(
      'org-1',
      'usd-1',
      expect.any(Date),
      100,
      false,
    );
  });

  // guards: BR-SETL-007
  it('курсу немає (конвертація кидає) → помилка йде назовні, журнал і баланс не чіпаються', async () => {
    prisma.settlementAccount.findFirst.mockResolvedValue({ id: 'acc-1' });
    exchangeRates.resolveBaseConversion.mockRejectedValue(
      new BadRequestException('немає курсу USD на дату'),
    );
    await expect(
      service.createTransaction('org-1', dto({ amount: 100, currencyId: 'usd-1' })),
    ).rejects.toThrow(BadRequestException);
    // Тихий відкат на курс 1 записав би 100 USD як 100 грн боргу.
    expect(prisma.settlementTransaction.create).not.toHaveBeenCalled();
    expect(prisma.settlementAccount.update).not.toHaveBeenCalled();
  });

  // ── BR-SETL-010: createTransaction НЕ ідемпотентна ─────────────────────────────────────
  //
  // Це контракт, на який спираються ВСІ викликачі (перелік — settlements.callers.spec.ts): кожен
  // сам тримає «не нарахувати двічі» (CAS статусу документа, перевірка наявної проводки). Якби
  // createTransaction тихо почала дедуплікувати за documentType/documentId/type, зламались би
  // законні повтори: два часткові прийоми одного замовлення — це два SUPPLIER_CHARGE з тим самим
  // documentId, CHARGE і сторно-CREDIT_NOTE наряду — той самий документ. Тому кейси нижче мусять
  // упасти, якщо хтось додасть ідемпотентність чи дедуплікацію, не переглянувши викликачів.

  /**
   * «Жива» підміна клієнта БД: журнал — масив рядків, баланс — число. Має РІВНО три операції,
   * які createTransaction робить сьогодні; читання журналу (count / findFirst заради
   * дедуплікації) тут немає — такий виклик упаде TypeError-ом.
   */
  function fakeLedger() {
    const journal: Record<string, unknown>[] = [];
    const account = { balance: 0 };
    const client = {
      settlementAccount: {
        findFirst: vi.fn().mockResolvedValue({ id: 'acc-1' }),
        update: vi
          .fn()
          .mockImplementation(async (args: { data: { balance: { increment: number } } }) => {
            account.balance += args.data.balance.increment;
            return {};
          }),
      },
      settlementTransaction: {
        create: vi.fn().mockImplementation(async (args: { data: Record<string, unknown> }) => {
          journal.push(args.data);
          return {};
        }),
      },
    };
    return { client, journal, account };
  }

  // guards: BR-SETL-010
  it('два однакові виклики (той самий documentType / documentId / type) → ДВА рядки журналу і ДВІ зміни балансу', async () => {
    const { client, journal, account } = fakeLedger();
    prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn(client),
    );
    const same = dto({
      type: 'CHARGE',
      amount: 100,
      documentType: 'WorkOrder',
      documentId: 'wo-1',
      createdBy: 'user-1',
    });

    await service.createTransaction('org-1', same);
    await service.createTransaction('org-1', same);

    expect(journal).toHaveLength(2);
    for (const row of journal) {
      expect(row).toMatchObject({
        orgId: 'org-1',
        settlementAccountId: 'acc-1',
        type: 'CHARGE',
        amount: 100,
        amountBase: 100,
        documentType: 'WorkOrder',
        documentId: 'wo-1',
      });
    }
    // Баланс змінено ДВІЧІ: +100 і ще +100. Другий виклик не «впізнає» перший.
    expect(client.settlementAccount.update).toHaveBeenCalledTimes(2);
    expect(account.balance).toBe(200);
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });

  // guards: BR-SETL-010
  it('повтор у тій самій tx викликача теж не дедуплікується: два рядки журналу, баланс змінено двічі', async () => {
    const { client, journal, account } = fakeLedger();
    const same = dto({
      type: 'PAYMENT',
      amount: 40,
      documentType: 'Invoice',
      documentId: 'inv-1',
    });

    await service.createTransaction('org-1', same, client as never);
    await service.createTransaction('org-1', same, client as never);

    expect(journal).toHaveLength(2);
    expect(journal.map(r => [r.type, r.documentType, r.documentId, r.amount])).toEqual([
      ['PAYMENT', 'Invoice', 'inv-1', 40],
      ['PAYMENT', 'Invoice', 'inv-1', 40],
    ]);
    expect(account.balance).toBe(-80);
  });

  // guards: BR-SETL-010
  it('createTransaction не читає журнал перед записом: єдине читання — пошук рахунку (перевірки «вже проведено» немає)', async () => {
    const touched: string[] = [];
    const { client } = fakeLedger();
    // Будь-яке звернення до делегата записуємо; невідома операція (count, findFirst журналу…)
    // віддає функцію, що відповідає «такий рядок уже є» — саме те, на що спирався б дедуп.
    const recording = new Proxy(client as Record<string, Record<string, unknown>>, {
      get: (target, model: string) =>
        new Proxy(target[model] ?? {}, {
          get: (delegate, op: string) => {
            touched.push(`${model}.${op}`);
            return delegate[op] ?? vi.fn().mockResolvedValue({ id: 'existing', _count: 1 });
          },
        }),
    });
    const same = dto({ type: 'CHARGE', amount: 100, documentType: 'Invoice', documentId: 'inv-9' });

    await service.createTransaction('org-1', same, recording as never);
    await service.createTransaction('org-1', same, recording as never);

    expect([...touched].sort()).toEqual([
      'settlementAccount.findFirst',
      'settlementAccount.findFirst',
      'settlementAccount.update',
      'settlementAccount.update',
      'settlementTransaction.create',
      'settlementTransaction.create',
    ]);
  });
});
