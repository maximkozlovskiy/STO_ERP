import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { Queue } from 'bullmq';
import { createPgAdapter } from '../../prisma/pg-adapter';
import { handleDbUnavailable, testDatabaseUrl } from '../../common/testing/require-db';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';
import type { CashService } from '../cash/cash.service';
import { DocumentNumberService } from '../document-number/document-number.service';
import { ExchangeRatesService } from '../exchange-rates/exchange-rates.service';
import type { LoyaltyService } from '../loyalty/loyalty.service';
import { PaymentsService, type CreatedPayment } from '../payments/payments.service';
import { SettlementsService } from '../settlements/settlements.service';
import { SupplierPaymentsService } from '../supplier-payments/supplier-payments.service';
import type { WorkOrdersService } from '../work-orders/work-orders.service';
import { BankReconciliationService } from './bank-reconciliation.service';

/**
 * ІНТЕГРАЦІЙНИЙ спек проти ЖИВОЇ dev-БД: рознесення рядка виписки з оплатою — ОДНА транзакція
 * (BR-BANK-009, 029, 041; рішення власника 2026-11-06, Bug #1023).
 *
 * Unit-спеки бачать лише, що оплата пишеться переданим `tx`; чи справді Postgres відкотить оплату,
 * проводку, подію й лічильник номерів разом із рядком — властивість бази. Тут збій підкладено ПІСЛЯ
 * створення оплати (крок посилання в рядку), і перевіряється, що в базі не лишилось нічого.
 *
 *  1. Внесення з рознесенням, вхідна оплата клієнта: ні рядка, ні оплати, ні її проводки.
 *  2. Внесення з рознесенням, нова оплата постачальнику: ні рядка, ні оплати, ні проводки, номер
 *     документа не витрачено (лічильник як був).
 *  3. Рознесення наявного вхідного рядка: рядок лишився `UNMATCHED` без контрагента, оплати немає.
 *
 * Mutation-verify: оплата повз транзакцію (`payments.createInTx(this.prisma, …)` /
 * `supplierPayments.createAndConfirmInTx(this.prisma, …)` — старий багатокомітний порядок) →
 * кейси 1, 3 / 2 червоніють: оплата лишається в базі.
 *
 * Дані: рахунок і два контрагенти «000 TST …» створюються в beforeAll і м'яко видаляються в
 * afterAll; рядки виписки кейсу 3 — теж. Оплат кейси не лишають (усе відкочується).
 * Умови запуску: жива dev-Postgres на DATABASE_URL. Без БД — SKIP (у CI з REQUIRE_DB=1 — падіння).
 */

const DATABASE_URL = testDatabaseUrl();
const STAMP = Date.now();
const MARKER = `000 TST single-tx ${STAMP}`;
const USER = randomUUID();

let dbAvailable = false;
let raw: PrismaClient;
let orgId: string;
let bankAccountId: string;
let clientId: string;
let supplierId: string;

class LinkFailure extends Error {}

const currentSeq = async (): Promise<bigint> => {
  const rows = await raw.$queryRaw<Array<{ currentSeq: bigint }>>`
    SELECT "currentSeq" FROM document_number_configs
    WHERE "orgId" = ${orgId}::uuid AND "documentType" = 'SUPPLIER_PAYMENT'::"DocumentType"
  `;
  return rows[0].currentSeq;
};

/** Справжні сервіси над живою БД; зовнішнє (черги, наряди, каса, аудит) — заглушки. */
function build() {
  const prisma = raw as unknown as PrismaService;
  const exchangeRates = new ExchangeRatesService(prisma);
  const settlements = new SettlementsService(prisma, exchangeRates);
  const payments = new PaymentsService(
    prisma,
    settlements,
    { emitStatusSteps: () => undefined } as unknown as WorkOrdersService,
    { queueEarn: () => Promise.resolve() } as unknown as LoyaltyService,
    { record: () => Promise.resolve() } as unknown as AuditService,
    {} as CashService,
    exchangeRates,
    { add: () => Promise.resolve() } as unknown as Queue,
  );
  const supplierPayments = new SupplierPaymentsService(
    prisma,
    settlements,
    new DocumentNumberService(prisma),
    {} as CashService,
    exchangeRates,
  );
  const service = new BankReconciliationService(
    prisma,
    exchangeRates,
    payments,
    settlements,
    {} as CashService,
    supplierPayments,
    { record: () => Promise.resolve() } as unknown as AuditService,
  );
  return { service, payments, supplierPayments };
}

/** Підкласти збій у крок посилання на оплату — ПІСЛЯ того, як оплату записано в транзакції. */
function failLink(
  service: BankReconciliationService,
  step: 'linkIncomingPayment' | 'linkSupplierPayment',
) {
  return vi
    .spyOn(service as unknown as Record<typeof step, () => Promise<void>>, step)
    .mockRejectedValueOnce(new LinkFailure('збій після створення оплати'));
}

const today = (): string => new Date().toISOString().slice(0, 10);

beforeAll(async () => {
  raw = new PrismaClient({ adapter: createPgAdapter(DATABASE_URL) });
  try {
    await raw.$connect();
    await raw.$queryRawUnsafe(`SELECT 1 FROM "bank_transactions" LIMIT 0`);
    await raw.$queryRawUnsafe(`SELECT "originBankTransactionId" FROM "supplier_payments" LIMIT 0`);
  } catch {
    handleDbUnavailable('підключення недоступне або міграції не застосовані');
    return;
  }
  const config = await raw.documentNumberConfig.findFirst({
    where: { documentType: 'SUPPLIER_PAYMENT' },
    select: { orgId: true },
  });
  if (!config) throw new Error('seed: немає нумерації оплат постачальнику');
  orgId = config.orgId;
  const base = await new ExchangeRatesService(raw as unknown as PrismaService).getBaseCurrency(
    orgId,
  );
  const [account, client, supplier] = await Promise.all([
    raw.bankAccount.create({
      data: {
        orgId,
        name: `${MARKER} рахунок`,
        ibanUA: `UA00${String(STAMP).padStart(25, '0').slice(-25)}`,
        currencyId: base.id,
      },
      select: { id: true },
    }),
    raw.counterparty.create({
      data: {
        orgId,
        type: 'CLIENT',
        companyName: `${MARKER} клієнт`,
        // Як CounterpartiesService.create: проводки пишуться на розрахунковий рахунок контрагента.
        settlementAccount: { create: { orgId, balance: 0 } },
      },
      select: { id: true },
    }),
    raw.counterparty.create({
      data: {
        orgId,
        type: 'SUPPLIER',
        companyName: `${MARKER} постачальник`,
        // Як CounterpartiesService.create: проводки пишуться на розрахунковий рахунок контрагента.
        settlementAccount: { create: { orgId, balance: 0 } },
      },
      select: { id: true },
    }),
  ]);
  bankAccountId = account.id;
  clientId = client.id;
  supplierId = supplier.id;
  dbAvailable = true;
}, 30_000);

afterAll(async () => {
  if (!raw) return;
  if (dbAvailable) {
    const deletedAt = new Date();
    await raw.bankTransaction
      .updateMany({ where: { orgId, purpose: MARKER, deletedAt: null }, data: { deletedAt } })
      .catch(() => undefined);
    await raw.counterparty
      .updateMany({ where: { orgId, id: { in: [clientId, supplierId] } }, data: { deletedAt } })
      .catch(() => undefined);
    await raw.bankAccount
      .updateMany({ where: { orgId, id: bankAccountId }, data: { deletedAt } })
      .catch(() => undefined);
  }
  await raw.$disconnect().catch(() => undefined);
});

describe('Рознесення рядка з оплатою — одна транзакція БД (Bug #1023)', () => {
  // guards: BR-BANK-041, BR-BANK-009
  it('внесення з рознесенням (вхідна оплата): збій після створення оплати → ні рядка, ні оплати, ні проводки', async ctx => {
    if (!dbAvailable) return ctx.skip();
    const { service, payments } = build();
    const createInTx = vi.spyOn(payments, 'createInTx');
    failLink(service, 'linkIncomingPayment');

    await expect(
      service.createManual(
        orgId,
        {
          bankAccountId,
          direction: 'IN',
          amount: 1,
          operationDate: today(),
          purpose: MARKER,
          allocation: { type: 'PREPAYMENT', counterpartyId: clientId },
        },
        USER,
      ),
    ).rejects.toBeInstanceOf(LinkFailure);

    // Оплату справді створено в транзакції — інакше кейс нічого не доводив би.
    expect(createInTx).toHaveBeenCalledTimes(1);
    const created = (await createInTx.mock.results[0]!.value) as CreatedPayment;
    const paymentId = created.payment.id;
    expect(await raw.payment.findUnique({ where: { id: paymentId } })).toBeNull();
    expect(await raw.settlementTransaction.count({ where: { orgId, documentId: paymentId } })).toBe(
      0,
    );
    expect(await raw.bankTransaction.count({ where: { orgId, purpose: MARKER } })).toBe(0);
    expect(await raw.payment.count({ where: { orgId, counterpartyId: clientId } })).toBe(0);
  });

  // guards: BR-BANK-041, BR-BANK-029
  it('внесення з рознесенням (нова оплата постачальнику): збій після проведення → ні рядка, ні оплати, номер не витрачено', async ctx => {
    if (!dbAvailable) return ctx.skip();
    const { service, supplierPayments } = build();
    const createAndConfirmInTx = vi.spyOn(supplierPayments, 'createAndConfirmInTx');
    failLink(service, 'linkSupplierPayment');
    const seqBefore = await currentSeq();

    await expect(
      service.createManual(
        orgId,
        {
          bankAccountId,
          direction: 'OUT',
          amount: 1,
          operationDate: today(),
          purpose: MARKER,
          allocation: { type: 'SUPPLIER_PAYMENT', counterpartyId: supplierId },
        },
        USER,
      ),
    ).rejects.toBeInstanceOf(LinkFailure);

    expect(createAndConfirmInTx).toHaveBeenCalledTimes(1);
    const created = (await createAndConfirmInTx.mock.results[0]!.value) as { id: string };
    expect(await raw.supplierPayment.findUnique({ where: { id: created.id } })).toBeNull();
    expect(
      await raw.settlementTransaction.count({ where: { orgId, documentId: created.id } }),
    ).toBe(0);
    expect(await raw.bankTransaction.count({ where: { orgId, purpose: MARKER } })).toBe(0);
    expect(await currentSeq()).toBe(seqBefore);
  });

  // guards: BR-BANK-009
  it('рознесення наявного вхідного рядка: збій після створення оплати → рядок UNMATCHED без контрагента, оплати немає', async ctx => {
    if (!dbAvailable) return ctx.skip();
    const { service, payments } = build();
    const row = await service.createManual(
      orgId,
      { bankAccountId, direction: 'IN', amount: 1, operationDate: today(), purpose: MARKER },
      USER,
    );
    const createInTx = vi.spyOn(payments, 'createInTx');
    failLink(service, 'linkIncomingPayment');

    await expect(
      service.matchTransaction(orgId, row.id, { counterpartyId: clientId, type: 'SERVICE' }, USER),
    ).rejects.toBeInstanceOf(LinkFailure);

    expect(createInTx).toHaveBeenCalledTimes(1);
    const created = (await createInTx.mock.results[0]!.value) as CreatedPayment;
    expect(await raw.payment.findUnique({ where: { id: created.payment.id } })).toBeNull();
    expect(
      await raw.bankTransaction.findUnique({
        where: { id: row.id },
        select: {
          status: true,
          counterpartyId: true,
          matchedType: true,
          paymentId: true,
          matchedAt: true,
        },
      }),
    ).toEqual({
      status: 'UNMATCHED',
      counterpartyId: null,
      matchedType: null,
      paymentId: null,
      matchedAt: null,
    });
  });
});
