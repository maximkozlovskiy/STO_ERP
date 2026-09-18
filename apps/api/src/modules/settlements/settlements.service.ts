import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { TRANSACTION_TIMEOUT_MS, translateError } from '@sto/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { getLocale } from '../../common/tenant/tenant-context';
import { ExchangeRatesService } from '../exchange-rates/exchange-rates.service';
import { Prisma, SettlementTransactionType } from '@prisma/client';

export interface CreateTransactionDto {
  counterpartyId: string;
  type: SettlementTransactionType;
  amount: number; // always positive — sign determined by type (у валюті currencyId)
  // Мультивалюта (Фаза 2): валюта транзакції. Якщо не задано → базова org (rate=1, amountBase=amount) —
  // BC для викликачів, що передають UAH-суми (invoice/WO/PO/supplier). Payment передає валюту рахунку.
  currencyId?: string;
  // Мультивалюта (Фаза 3): дата події для курсу (дата документа для CHARGE / дата оплати для PAYMENT).
  // Default new Date() (BC). fallbackToLatest — документні потоки беруть останній курс якщо немає на дату.
  date?: Date;
  fallbackToLatest?: boolean;
  documentType?: string;
  documentId?: string;
  notes?: string;
  createdBy?: string;
}

// ЄДИНЕ ДЖЕРЕЛО ПРАВДИ про знак балансу (balance>0 = нам винні / дебіторська;
// balance<0 = ми винні / кредиторська). Експортується — reconciliation act
// (settlements-account.service) використовує ЦЮ мапу замість власної копії.
//
// Знак — чиста функція від type. Клієнтські vs постачальницькі типи РОЗДІЛЕНІ, бо
// семантика протилежна: клієнт CHARGE → клієнт нам винен (+); постачальник отримання
// товару → МИ винні постачальнику (SUPPLIER_CHARGE −). Той самий тип не можна переюзати.
// Record (not Partial): TS-exhaustive — новий enum-value → compile-error, не runtime-сюрприз.
// Called from every FSM transition (invoice→PAID, SP→CONFIRMED, PO/SD receipt) — every request paid alloc.
export const BALANCE_SIGN: Record<SettlementTransactionType, 1 | -1> = {
  CHARGE: 1, // клієнт винен нам (наряд/рахунок)
  PAYMENT: -1, // клієнт заплатив нам
  PREPAYMENT: -1,
  REFUND: -1,
  CREDIT_NOTE: -1,
  SUPPLIER_CHARGE: -1, // отримали товар → ми винні постачальнику
  SUPPLIER_PAYMENT: 1, // заплатили постачальнику → наш борг меншає
  SUPPLIER_REFUND: 1, // повернули товар постачальнику → наш борг меншає
  // Курсові різниці (Фаза 4): гасять base-залишок повністю сплаченого іновалютного документа.
  FX_GAIN: 1, // отримали більше base ніж нараховано → від'ємний залишок ↑ до 0
  FX_LOSS: -1, // отримали менше base ніж нараховано → додатний залишок ↓ до 0
};

@Injectable()
export class SettlementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly exchangeRates: ExchangeRatesService,
  ) {}

  async createTransaction(
    orgId: string,
    dto: CreateTransactionDto,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    if (!Number.isFinite(dto.amount) || dto.amount <= 0) {
      throw new BadRequestException(
        translateError('err.settlement.amountMustBePositive', getLocale()),
      );
    }
    // Мультивалюта (Фаза 2): баланс боргу зводиться у БАЗОВІЙ валюті → balanceDelta від amountBase.
    // Без currencyId → базова (rate=1, amountBase=amount) → 7 UAH-викликачів працюють без змін.
    const conv = dto.currencyId
      ? await this.exchangeRates.resolveBaseConversion(
          orgId,
          dto.currencyId,
          dto.date ?? new Date(),
          dto.amount,
          dto.fallbackToLatest ?? false,
        )
      : { rateUsed: 1, amountBase: dto.amount };
    const balanceDelta = BALANCE_SIGN[dto.type] * conv.amountBase;

    const run = async (db: Prisma.TransactionClient | PrismaService) => {
      // SettlementAccount has no deletedAt — it's a singleton per counterparty, never soft-deleted
      const account = await db.settlementAccount.findFirst({
        where: { orgId, counterpartyId: dto.counterpartyId },
        select: { id: true },
      });
      if (!account)
        throw new NotFoundException(
          translateError('err.settlement.counterpartyAccountNotFound', getLocale()),
        );

      // sto-optimize: create + balance update пишуть у різні таблиці (SettlementTransaction
      // та SettlementAccount), не залежать один від одного, обидва читають account.id зі scope.
      // Promise.all всередині $transaction зменшує JS-event-loop overhead і паралелить
      // мікротаски Prisma client; Postgres serializes на pinned connection — race-safe.
      await Promise.all([
        db.settlementTransaction.create({
          data: {
            orgId,
            settlementAccountId: account.id,
            type: dto.type,
            amount: dto.amount,
            currencyId: dto.currencyId ?? null,
            amountBase: conv.amountBase,
            rateUsed: conv.rateUsed,
            documentType: dto.documentType ?? null,
            documentId: dto.documentId ?? null,
            notes: dto.notes ?? null,
            createdBy: dto.createdBy ?? null,
          },
        }),
        db.settlementAccount.update({
          where: { id: account.id, orgId },
          data: { balance: { increment: balanceDelta } },
        }),
      ]);
    };

    if (tx) {
      await run(tx);
    } else {
      // explicit timeout — called from work-orders COMPLETED flow where additional writes may be in flight
      await this.prisma.$transaction(run, { timeout: TRANSACTION_TIMEOUT_MS });
    }
  }

  async getBalance(orgId: string, counterpartyId: string): Promise<number> {
    const account = await this.prisma.settlementAccount.findFirst({
      where: { orgId, counterpartyId },
    });
    return account ? Number(account.balance) : 0;
  }
}
