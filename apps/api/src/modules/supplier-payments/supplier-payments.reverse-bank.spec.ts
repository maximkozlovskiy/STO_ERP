/**
 * Сторно банківської оплати постачальнику окремою дією (BR-SUPPAY-017, TECH-DEBT (б) №90):
 * `POST /supplier-payments/:id/reverse` `{ reason }` → `SupplierPaymentsService.reverseBankPayment`.
 *
 *   • HTTP: ключ ідемпотентності обов'язковий, повтор із тим самим ключем — без другого сторно; ролі
 *     OWNER / ADMIN / ACCOUNTANT; порожня причина — 400 до сервісу;
 *   • відмови до першого запису: не «Проведено», каса (сторнує каса), рядок виписки, рознесений на
 *     оплату (спершу зняти рознесення) — статус, журнал і замовлення не змінено;
 *   • сторно — той самий `reverse`: проводка `SUPPLIER_PAYMENT_CANCEL` на документ-оплату з курсом
 *     оригіналу, «сплачено» й `paidAt` замовлення назад, курсова різниця повної оплати відкочена;
 *   • порядок блокувань той самий, що в проведенні (оплата → рахунок розрахунків → замовлення).
 *
 * Таблиці — у пам'яті (`memoryTable`): `where` виконується, тож фільтр рядка виписки й організації
 * перевіряється справді, а не заготовкою. Сам `reverse` (каса, виписка) — `supplier-payments.reverse.spec.ts`.
 *
 * Mutation-verify (2026-11-13): прибрати перевірку каси / рядка виписки / статусу → кейс відмови
 * червоний; документ проводки `CashOperation` замість оплати → «проводка … на документ-оплату»;
 * `FOR UPDATE` замовлення перед CAS оплати → «порядок блокувань».
 */
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
import type { ExecutionContext, INestApplication } from '@nestjs/common';
import { BadRequestException, NotFoundException, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { translateError } from '@sto/shared';
import { SupplierPaymentsController } from './supplier-payments.controller';
import { SupplierPaymentsService } from './supplier-payments.service';
import { exchangeRatesProvider } from './supplier-payments.spec-fixture';
import { memoryTable, type MemRow } from '../cash/cash.spec-fixture';
import { PrismaService } from '../../prisma/prisma.service';
import { RequiredIdempotencyInterceptor } from '../../common/interceptors/idempotency.interceptor';
import { makeIdempotencyStore } from '../../common/testing/idempotency-store';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import type { SettlementsService } from '../settlements/settlements.service';
import type { DocumentNumberService } from '../document-number/document-number.service';
import type { CashService } from '../cash/cash.service';
import type { ExchangeRatesService } from '../exchange-rates/exchange-rates.service';

const ORG = '00000000-0000-4000-8000-000000000001';
const OTHER_ORG = '99999999-9999-4999-8999-999999999999';
const SP = '11111111-1111-4111-8111-111111111111';
const SP_DRAFT = '11111111-1111-4111-8111-111111111112';
const SUPPLIER = '22222222-2222-4222-8222-222222222222';
const BANK_ACC = '33333333-3333-4333-8333-333333333333';
const PO = '55555555-5555-4555-8555-555555555555';
const USER = '77777777-7777-4777-8777-777777777777';
const BANK_ROW = '99999999-0000-4000-8000-000000000017';
const USD = 'usd-id';
const BASE = 'uah-id';
const REASON = 'оплачено не тому постачальнику';

// ─── HTTP: POST /supplier-payments/:id/reverse ───────────────────────────────────────────────

const serviceMock = { reverseBankPayment: vi.fn() };
let jwtRole = 'ACCOUNTANT';
const mockJwtGuard = {
  canActivate: vi.fn().mockImplementation((ctx: ExecutionContext) => {
    const req = ctx.switchToHttp().getRequest<{ user?: unknown }>();
    req.user = { id: USER, orgId: ORG, role: jwtRole };
    return true;
  }),
};

describe('POST /supplier-payments/:id/reverse — HTTP-контракт (BR-SUPPAY-017)', () => {
  let app: INestApplication;
  let store: ReturnType<typeof makeIdempotencyStore>;

  beforeAll(async () => {
    store = makeIdempotencyStore();
    const module = await Test.createTestingModule({
      controllers: [SupplierPaymentsController],
      providers: [
        { provide: SupplierPaymentsService, useValue: serviceMock },
        { provide: PrismaService, useValue: { idempotencyKey: store.idempotencyKey } },
        RequiredIdempotencyInterceptor,
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(mockJwtGuard)
      .overrideGuard(RolesGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => new RolesGuard(new Reflector()).canActivate(ctx),
      })
      .compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalPipes(new ValidationPipe({ transform: true }));
    await app.init();
    await (app as NestFastifyApplication).getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jwtRole = 'ACCOUNTANT';
    store.rows.clear();
    serviceMock.reverseBankPayment.mockReset();
    serviceMock.reverseBankPayment.mockImplementation(() =>
      Promise.resolve({ id: SP, status: 'REVERSED' }),
    );
  });

  const reverse = (key: string | null = randomUUID(), payload: unknown = { reason: REASON }) =>
    (app as NestFastifyApplication).inject({
      method: 'POST',
      url: `/supplier-payments/${SP}/reverse`,
      payload: payload as Record<string, unknown>,
      ...(key && { headers: { 'idempotency-key': key } }),
    });

  // guards: BR-SUPPAY-017
  it('без Idempotency-Key → 400, сторно не викликається', async () => {
    const res = await reverse(null);
    expect(res.statusCode).toBe(400);
    expect(serviceMock.reverseBankPayment).not.toHaveBeenCalled();
  });

  // guards: BR-SUPPAY-017
  it.each(['OWNER', 'ADMIN', 'ACCOUNTANT'])(
    '%s → 200; сервіс отримує організацію, оплату, причину й автора',
    async role => {
      jwtRole = role;
      const res = await reverse();
      expect(res.statusCode).toBe(200);
      expect(serviceMock.reverseBankPayment).toHaveBeenCalledWith(
        ORG,
        SP,
        { reason: REASON },
        USER,
      );
    },
  );

  // guards: BR-SUPPAY-017
  it.each(['STOREKEEPER', 'RECEPTIONIST', 'MECHANIC'])('%s → 403', async role => {
    jwtRole = role;
    const res = await reverse();
    expect(res.statusCode).toBe(403);
    expect(serviceMock.reverseBankPayment).not.toHaveBeenCalled();
  });

  // guards: BR-SUPPAY-017
  it.each([{}, { reason: '' }, { reason: '   ' }, { reason: 'x'.repeat(501) }])(
    'причина %j → 400 до сервісу',
    async payload => {
      const res = await reverse(randomUUID(), payload);
      expect(res.statusCode).toBe(400);
      expect(serviceMock.reverseBankPayment).not.toHaveBeenCalled();
    },
  );

  // Обрив відповіді: web повторює той самий запит із тим самим ключем — другого сторно немає.
  // guards: BR-SUPPAY-017
  it('повтор із тим самим ключем → та сама відповідь, сторно рівно раз', async () => {
    const key = randomUUID();
    const first = await reverse(key);
    const second = await reverse(key);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBeLessThan(300);
    expect(second.json()).toEqual(first.json());
    expect(serviceMock.reverseBankPayment).toHaveBeenCalledTimes(1);
  });
});

// ─── Сервіс: reverseBankPayment ──────────────────────────────────────────────────────────────

interface Seed {
  sp?: MemRow;
  po?: MemRow;
  bankRows?: MemRow[];
  /** Інші проводки журналу (курсова різниця повної оплати замовлення). */
  journal?: MemRow[];
}

function makeHarness(seed: Seed = {}) {
  // USD-оплата 100 за курсом 41.47 закрила замовлення 100 USD повністю.
  const sp: MemRow = {
    id: SP,
    orgId: ORG,
    number: 'ОПП-20261113-000001',
    status: 'CONFIRMED',
    supplierId: SUPPLIER,
    purchaseOrderId: PO,
    sourceType: 'BANK_ACCOUNT',
    bankAccountId: BANK_ACC,
    cashRegisterId: null,
    amount: 100,
    currencyId: USD,
    totalAmountBase: 4147,
    rateUsed: 41.47,
    method: 'bank_transfer',
    notes: null,
    documentDate: new Date('2026-11-10T00:00:00.000Z'),
    createdAt: new Date('2026-11-10T09:00:00.000Z'),
    updatedAt: new Date('2026-11-10T09:00:00.000Z'),
    deletedAt: null,
    ...seed.sp,
  };
  // Чернетка на те саме замовлення — для порівняння порядку блокувань із проведенням.
  const draft: MemRow = {
    ...sp,
    id: SP_DRAFT,
    number: 'ОПП-20261113-000002',
    status: 'DRAFT',
    amount: 10,
    totalAmountBase: null,
    rateUsed: null,
  };
  const po: MemRow = {
    id: PO,
    orgId: ORG,
    supplierId: SUPPLIER,
    status: 'RECEIVED',
    totalAmount: 100,
    paidAmount: 100,
    paidAt: new Date('2026-11-10T00:00:00.000Z'),
    currencyId: USD,
    deletedAt: null,
    ...seed.po,
  };
  const tables = {
    domainEvent: memoryTable([]),
    supplierPayment: memoryTable([sp, draft]),
    purchaseOrder: memoryTable([po]),
    bankTransaction: memoryTable(seed.bankRows ?? []),
    settlementTransaction: memoryTable([
      {
        id: 'st-orig',
        orgId: ORG,
        type: 'SUPPLIER_PAYMENT',
        amount: 100,
        amountBase: 4147,
        rateUsed: 41.47,
        currencyId: USD,
        documentType: 'SupplierPayment',
        documentId: SP,
        createdAt: new Date('2026-11-10T09:00:00.000Z'),
      },
      ...(seed.journal ?? []),
    ]),
  };
  // Сире блокування (`SELECT … FOR UPDATE`) теж записується в порядок блокувань.
  const rawLocks = vi.fn((strings: TemplateStringsArray) =>
    Promise.resolve(strings.join('?').includes('purchase_orders') ? [{ id: PO }] : []),
  );
  const tx = { ...tables, $queryRaw: rawLocks };

  // Кореневий клієнт — лише читання й `$transaction`: усі записи сторно — у транзакції.
  const root: Record<string, unknown> = {
    $transaction: vi.fn((fn: (client: unknown) => Promise<unknown>) => fn(tx)),
  };
  for (const [name, table] of Object.entries(tables)) {
    const forbid = () => {
      throw new Error(`запис через this.prisma.${name} поза транзакцією`);
    };
    root[name] = {
      ...table,
      create: vi.fn(forbid),
      update: vi.fn(forbid),
      updateMany: vi.fn(forbid),
    };
  }

  const settlementRows: MemRow[] = [];
  const settlements = {
    createTransaction: vi.fn((orgId: string, dto: MemRow, client?: unknown) => {
      settlementRows.push({ orgId, ...dto, __tx: client });
      return Promise.resolve();
    }),
  };
  const exchangeRates = exchangeRatesProvider().useValue;
  exchangeRates.getBaseCurrency.mockResolvedValue({ id: BASE, code: 'UAH' });
  exchangeRates.resolveBaseConversion.mockResolvedValue({ rateUsed: 41.5, amountBase: 415 });
  const cash = { createOperation: vi.fn() };

  const service = new SupplierPaymentsService(
    root as unknown as PrismaService,
    settlements as unknown as SettlementsService,
    { next: vi.fn() } as unknown as DocumentNumberService,
    cash as unknown as CashService,
    exchangeRates as unknown as ExchangeRatesService,
  );

  const reverse = (orgId = ORG, reason = REASON) =>
    service.reverseBankPayment(orgId, SP, { reason }, USER);

  /** Порядок записів-блокувань: CAS оплати, проводка (рахунок розрахунків), CAS замовлення. */
  const lockOrder = (from: number) =>
    [
      ...tables.supplierPayment.updateMany.mock.invocationCallOrder.map(
        n => [n, 'оплата'] as const,
      ),
      ...settlements.createTransaction.mock.invocationCallOrder.map(
        n => [n, 'рахунок розрахунків'] as const,
      ),
      ...tables.purchaseOrder.updateMany.mock.invocationCallOrder.map(
        n => [n, 'замовлення'] as const,
      ),
      // Сире блокування — за таблицею запиту: `supplier_payments` (сторно блокує оплату першим
      // кроком) чи `purchase_orders`.
      ...rawLocks.mock.invocationCallOrder.map((n, i) => {
        const sql = (rawLocks.mock.calls[i]?.[0] ?? []).join('?');
        return [n, sql.includes('supplier_payments') ? 'оплата' : 'замовлення'] as const;
      }),
    ]
      .filter(([n]) => n > from)
      .sort((a, b) => a[0] - b[0])
      .map(([, what]) => what)
      // Повторне блокування того самого рядка (FOR UPDATE, потім CAS) нового порядку не дає.
      .filter((what, i, all) => what !== all[i - 1]);

  return { service, tables, tx, root, settlementRows, settlements, sp, po, reverse, lockOrder };
}

/** Відмова: 400 з текстом ключа, нічого не записано. */
async function expectRefused(h: ReturnType<typeof makeHarness>, key: string, status = 'CONFIRMED') {
  await expect(h.reverse()).rejects.toThrow(new BadRequestException(translateError(key, 'uk')));
  expect(h.sp.status).toBe(status);
  expect(h.settlementRows).toEqual([]);
  expect(Number(h.po.paidAmount)).toBe(100);
  expect(h.po.paidAt).not.toBeNull();
  expect(h.tables.domainEvent.rows).toEqual([]);
}

describe('SupplierPaymentsService.reverseBankPayment — сторно (BR-SUPPAY-017)', () => {
  const usdFx = (type: string, amountBase: number): MemRow => ({
    id: `st-fx-${type}`,
    orgId: ORG,
    type,
    amount: amountBase,
    amountBase,
    rateUsed: 1,
    currencyId: null,
    documentType: 'PurchaseOrder',
    documentId: PO,
  });

  // guards: BR-SUPPAY-017, BR-SUPPAY-012
  it('проводка SUPPLIER_PAYMENT_CANCEL на документ-оплату, з курсом оригіналу й причиною; у транзакції', async () => {
    const h = makeHarness();

    const res = await h.reverse();

    expect(res).toMatchObject({ id: SP, status: 'REVERSED' });
    expect(h.sp.status).toBe('REVERSED');
    const cancel = h.settlementRows.filter(r => r.type === 'SUPPLIER_PAYMENT_CANCEL');
    expect(cancel).toEqual([
      expect.objectContaining({
        orgId: ORG,
        counterpartyId: SUPPLIER,
        documentType: 'SupplierPayment',
        documentId: SP,
        amount: 100,
        currencyId: USD,
        // Курс оригіналу (41.47), а не поточний (41.5 у моку курсів).
        conversion: { rateUsed: 41.47, amountBase: 4147 },
        notes: REASON,
        createdBy: USER,
        __tx: h.tx,
      }),
    ]);
    expect(h.root.$transaction).toHaveBeenCalledTimes(1);
  });

  // guards: BR-SUPPAY-017, BR-SUPPAY-012
  it('«сплачено» замовлення назад, paidAt знято, курсова різниця повної оплати відкочена', async () => {
    const h = makeHarness({ journal: [usdFx('FX_GAIN', 53)] });

    await h.reverse();

    expect(Number(h.po.paidAmount)).toBe(0);
    expect(h.po.paidAt).toBeNull();
    expect(h.settlementRows.filter(r => r.type === 'FX_GAIN' || r.type === 'FX_LOSS')).toEqual([
      expect.objectContaining({
        type: 'FX_LOSS',
        amount: 53,
        documentType: 'PurchaseOrder',
        documentId: PO,
        __tx: h.tx,
      }),
    ]);
  });

  // guards: BR-SUPPAY-017
  it('подія статусу «Проведено» → «Сторновано» з автором', async () => {
    const h = makeHarness();

    await h.reverse();

    expect(h.tables.domainEvent.rows).toEqual([
      expect.objectContaining({
        documentType: 'SUPPLIER_PAYMENT',
        documentId: SP,
        fromStatus: 'CONFIRMED',
        toStatus: 'REVERSED',
        actorId: USER,
      }),
    ]);
  });

  // Проведення: CAS оплати → проводка (рахунок розрахунків) → CAS «сплачено» замовлення. Сторно —
  // у тому самому порядку: одночасні проведення й сторно оплат одного замовлення не зустрічаються
  // назустріч (deadlock «оплата ‖ сторно», BR-PAY-005).
  // guards: BR-SUPPAY-017
  it('порядок блокувань той самий, що в проведенні: оплата → рахунок розрахунків → замовлення', async () => {
    // «Замовлено»: курсової різниці при повній оплаті немає — у порядку лише три блокування.
    const h = makeHarness({ po: { status: 'ORDERED', paidAmount: 90, paidAt: null } });

    await h.service.confirm(ORG, SP_DRAFT, USER);
    const confirmOrder = h.lockOrder(0);
    const mark = Math.max(
      0,
      ...h.settlements.createTransaction.mock.invocationCallOrder,
      ...h.tables.purchaseOrder.updateMany.mock.invocationCallOrder,
    );
    await h.reverse();
    const reverseOrder = h.lockOrder(mark);

    expect(confirmOrder).toEqual(['оплата', 'рахунок розрахунків', 'замовлення']);
    expect(reverseOrder).toEqual(confirmOrder);
  });

  // guards: BR-SUPPAY-017
  it('причина обрізається; порожня (пробіли) → 400 до транзакції', async () => {
    const h = makeHarness();

    await expect(h.reverse(ORG, '   ')).rejects.toThrow(BadRequestException);
    expect(h.root.$transaction).not.toHaveBeenCalled();
    expect(h.sp.status).toBe('CONFIRMED');

    await h.reverse(ORG, `  ${REASON}  `);
    expect(h.settlementRows[0]).toMatchObject({ notes: REASON });
  });
});

describe('SupplierPaymentsService.reverseBankPayment — відмови до запису (BR-SUPPAY-017)', () => {
  // guards: BR-SUPPAY-017
  it('уже сторновано → 400 «Оплату постачальнику вже сторновано»', async () => {
    const h = makeHarness({ sp: { status: 'REVERSED' } });
    await expectRefused(h, 'err.supplierPayment.alreadyReversed', 'REVERSED');
  });

  // guards: BR-SUPPAY-017
  it.each(['DRAFT', 'CANCELLED'])(
    'статус %s → 400 «оплата змінилась», нічого не записано',
    async status => {
      const h = makeHarness({ sp: { status } });
      await expectRefused(h, 'err.supplierPayment.reversalStateChanged', status);
    },
  );

  // guards: BR-SUPPAY-017, BR-CASH-024
  it('оплата з каси → 400 «сторнуйте її касову операцію»', async () => {
    const h = makeHarness({
      sp: { sourceType: 'CASH_REGISTER', bankAccountId: null, cashRegisterId: 'cr-1' },
    });
    await expectRefused(h, 'err.supplierPayment.reverseViaCashDesk');
  });

  // guards: BR-SUPPAY-017, BR-BANK-027
  it('рядок виписки прив’язано до оплати → 400 «спершу зніміть рознесення рядка»', async () => {
    const h = makeHarness({
      bankRows: [
        { id: BANK_ROW, orgId: ORG, status: 'MATCHED', supplierPaymentId: SP, deletedAt: null },
      ],
    });
    await expectRefused(h, 'err.supplierPayment.reverseUnreconcileFirst');
  });

  // Паралельна прив'язка рядка виписки (BR-BANK-027) блокує рядок оплати: перевірка «рядка немає»
  // мусить іти ПІСЛЯ блокування оплати, інакше вона не бачить прив'язки, що комітиться поруч, і
  // рядок лишається прив'язаним до сторнованої оплати.
  // guards: BR-SUPPAY-017, BR-BANK-027
  it('оплата блокується (FOR UPDATE) до перевірки рядка виписки', async () => {
    const h = makeHarness();

    await h.reverse();

    const raw = h.tx.$queryRaw as unknown as {
      mock: { calls: [TemplateStringsArray, ...unknown[]][]; invocationCallOrder: number[] };
    };
    const lockIdx = raw.mock.calls.findIndex(([s]) => s.join('?').includes('supplier_payments'));
    expect(lockIdx).toBeGreaterThanOrEqual(0);
    expect(raw.mock.calls[lockIdx]![0].join('?')).toMatch(/FOR UPDATE/);
    expect(raw.mock.calls[lockIdx]!.slice(1)).toEqual([ORG, SP]);
    const lockAt = raw.mock.invocationCallOrder[lockIdx]!;
    const bankReads = h.tables.bankTransaction.findFirst.mock.invocationCallOrder;
    expect(bankReads.length).toBeGreaterThan(0);
    expect(Math.min(...bankReads)).toBeGreaterThan(lockAt);
  });

  // guards: BR-SUPPAY-017, BR-BANK-039
  it('оплату створено з рядка виписки (він же на неї вказує) → та сама відмова', async () => {
    const h = makeHarness({
      sp: { originBankTransactionId: BANK_ROW },
      bankRows: [
        { id: BANK_ROW, orgId: ORG, status: 'MATCHED', supplierPaymentId: SP, deletedAt: null },
      ],
    });
    await expectRefused(h, 'err.supplierPayment.reverseUnreconcileFirst');
  });

  // `where` рядка виписки — саме ця оплата й ця організація: чужий рядок сторно не блокує.
  // guards: BR-SUPPAY-017
  it('рядок виписки іншої оплати чи іншої організації не заважає', async () => {
    const h = makeHarness({
      bankRows: [
        { id: 'row-a', orgId: ORG, supplierPaymentId: SP_DRAFT, deletedAt: null },
        { id: 'row-b', orgId: OTHER_ORG, supplierPaymentId: SP, deletedAt: null },
      ],
    });
    await h.reverse();
    expect(h.sp.status).toBe('REVERSED');
  });

  // guards: BR-SUPPAY-017
  it('оплата іншої організації → 404, нічого не записано', async () => {
    const h = makeHarness();
    await expect(h.reverse(OTHER_ORG)).rejects.toThrow(NotFoundException);
    expect(h.sp.status).toBe('CONFIRMED');
    expect(h.settlementRows).toEqual([]);
  });
});
