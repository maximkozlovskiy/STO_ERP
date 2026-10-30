import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { BadRequestException } from '@nestjs/common';
import { PaymentSourceType } from '@prisma/client';
import { createPgAdapter } from '../../prisma/pg-adapter';
import { handleDbUnavailable, testDatabaseUrl } from '../../common/testing/require-db';
import { DocumentNumberService } from '../document-number/document-number.service';
import { SupplierPaymentsService } from './supplier-payments.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { SettlementsService } from '../settlements/settlements.service';
import type { CashService } from '../cash/cash.service';
import type { ExchangeRatesService } from '../exchange-rates/exchange-rates.service';

/**
 * ІНТЕГРАЦІЙНИЙ спек проти ЖИВОЇ dev-БД: номер документа відкочується разом із транзакцією
 * (BR-SUPPAY-013, рішення власника 2026-10-30, TECH-DEBT (б) №34).
 *
 * Unit-спеки бачать лише, що `DocumentNumberService.next` отримав tx; чи справді Postgres поверне
 * лічильник після відкату — властивість бази. Обидва кейси нічого не лишають у dev-базі: усі записи
 * роблять транзакції, які відкочуються (лічильник, оплата, подія outbox).
 *
 *  1. `next(org, type, tx)` у транзакції, що кидає: усередині лічильник +1, після відкату — як був.
 *     Мутація: `next` ігнорує `tx` (своя транзакція) → після відкату лічильник +1 → червоний.
 *  2. `createAndConfirm`, де проведення кидає після запису оплати (борг: «каса в мінус»): помилка
 *     піднята, лічильник як був, оплати з міткою немає.
 *
 * Умови запуску: жива dev-Postgres на DATABASE_URL. Без БД — SKIP (у CI з REQUIRE_DB=1 — падіння).
 */

const DATABASE_URL = testDatabaseUrl();
const MARKER = `000 TST rollback ${Date.now()}`;

let dbAvailable = false;
let raw: PrismaClient;
let orgId: string;
let supplierId: string;
let cashRegisterId: string;
let userId: string;

class Rollback extends Error {}

const currentSeq = async (): Promise<bigint> => {
  const rows = await raw.$queryRaw<Array<{ currentSeq: bigint }>>`
    SELECT "currentSeq" FROM document_number_configs
    WHERE "orgId" = ${orgId}::uuid AND "documentType" = 'SUPPLIER_PAYMENT'::"DocumentType"
  `;
  return rows[0].currentSeq;
};

beforeAll(async () => {
  raw = new PrismaClient({ adapter: createPgAdapter(DATABASE_URL) });
  try {
    await raw.$connect();
    await raw.$queryRawUnsafe(`SELECT 1 FROM "document_number_configs" LIMIT 0`);
  } catch {
    handleDbUnavailable('підключення недоступне або міграції не застосовані');
    return;
  }
  // БД доступна: брак довідників seed — падіння, а не тихий пропуск.
  const config = await raw.documentNumberConfig.findFirst({
    where: { documentType: 'SUPPLIER_PAYMENT' },
    select: { orgId: true },
  });
  if (!config) throw new Error('seed: немає нумерації оплат постачальнику');
  orgId = config.orgId;
  const [supplier, register, employee] = await Promise.all([
    raw.counterparty.findFirst({
      where: { orgId, deletedAt: null, type: { in: ['SUPPLIER', 'BOTH'] } },
      select: { id: true },
    }),
    raw.cashRegister.findFirst({ where: { orgId, deletedAt: null }, select: { id: true } }),
    raw.employee.findFirst({ where: { orgId, deletedAt: null }, select: { id: true } }),
  ]);
  if (!supplier || !register || !employee)
    throw new Error('seed: немає постачальника, каси чи працівника');
  supplierId = supplier.id;
  cashRegisterId = register.id;
  userId = employee.id;
  dbAvailable = true;
}, 30_000);

afterAll(async () => {
  if (raw) await raw.$disconnect().catch(() => undefined);
});

describe('Номер оплати постачальнику відкочується з транзакцією (BR-SUPPAY-013)', () => {
  // guards: BR-SUPPAY-013
  it('next(…, tx) у транзакції, що відкотилась: усередині лічильник +1, після відкату — як був', async ctx => {
    if (!dbAvailable) return ctx.skip();
    const numbers = new DocumentNumberService(raw as unknown as PrismaService);
    const before = await currentSeq();
    let inside: bigint | null = null;

    await expect(
      raw.$transaction(async tx => {
        await numbers.next(orgId, 'SUPPLIER_PAYMENT', tx);
        const rows = await tx.$queryRaw<Array<{ currentSeq: bigint }>>`
          SELECT "currentSeq" FROM document_number_configs
          WHERE "orgId" = ${orgId}::uuid AND "documentType" = 'SUPPLIER_PAYMENT'::"DocumentType"
        `;
        inside = rows[0].currentSeq;
        throw new Rollback('відкат');
      }),
    ).rejects.toBeInstanceOf(Rollback);

    expect(inside).not.toBeNull();
    expect(inside).not.toBe(before);
    expect(await currentSeq()).toBe(before);
  });

  // guards: BR-SUPPAY-013
  it('createAndConfirm: проведення відмовило після запису оплати → ні оплати, ні витраченого номера', async ctx => {
    if (!dbAvailable) return ctx.skip();
    const refused = new BadRequestException('Недостатньо готівки в касі');
    const service = new SupplierPaymentsService(
      raw as unknown as PrismaService,
      { createTransaction: () => Promise.reject(refused) } as unknown as SettlementsService,
      new DocumentNumberService(raw as unknown as PrismaService),
      {} as CashService,
      {
        resolveBaseConversion: (_o: string, _c: string, _d: Date, amount: number) =>
          Promise.resolve({ rateUsed: 1, amountBase: amount }),
        sameCurrency: () => Promise.resolve(true),
      } as unknown as ExchangeRatesService,
    );
    const before = await currentSeq();

    await expect(
      service.createAndConfirm(
        orgId,
        {
          supplierId,
          sourceType: PaymentSourceType.CASH_REGISTER,
          cashRegisterId,
          amount: 1,
          method: 'cash',
          notes: MARKER,
        },
        userId,
      ),
    ).rejects.toBe(refused);

    expect(await currentSeq()).toBe(before);
    expect(await raw.supplierPayment.count({ where: { orgId, notes: MARKER } })).toBe(0);
  });
});
