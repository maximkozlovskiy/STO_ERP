import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { CashDirection, CashOperationReason, Prisma } from '@prisma/client';
import { TRANSACTION_TIMEOUT_MS, translateError } from '@sto/shared';
import { getLocale } from '../../common/tenant/tenant-context';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { ExchangeRatesService } from '../exchange-rates/exchange-rates.service';
import { type Money, money, moneyFromDecimal } from '../../common/utils/money';
import { kyivDayRangeFilter } from '../../common/utils/kyiv-date';
import { searchContains } from '../../common/utils/like-pattern';
import { CashOperationResponseDto, CashReasonDto, CreateCashOperationDto } from './cash.dto';

// Знак операції для балансу: IN додає готівку (+), OUT — віднімає (−). Баланс рахується
// SQL-агрегатами (Σ IN − Σ OUT) у computeBalance для ефективності — ця мапа документує конвенцію.

// Параметри створення операції — спільний вхід для ручних (контролер) і авто (payments/payroll) операцій.
export interface CreateCashOperationInput {
  cashRegisterId: string;
  direction: CashDirection;
  amount: number;
  reason: CashOperationReason;
  expenseCategoryId?: string | null;
  counterpartyId?: string | null;
  employeeId?: string | null;
  documentType?: string | null;
  documentId?: string | null;
  notes?: string | null;
  createdBy?: string | null;
}

/**
 * Каса — рух готівки. CashService.createOperation — ЄДИНА точка руху (аналог
 * SettlementsService.createTransaction): append-only CashOperation, atomic, приймає зовнішній tx.
 * Фіскальна каса (isFiscal) → операція лише у відкриту зміну (cashShiftId). Нефіскальна → без зміни.
 * Баланс = initialBalance + Σ(CASH_SIGN*amount).
 */
@Injectable()
export class CashService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly exchangeRates: ExchangeRatesService,
  ) {}

  /**
   * Створити касову операцію. amount>0, знак із direction. Для фіскальної каси знаходить відкриту
   * зміну (кидає 400, якщо немає). Викликається з контролера (ручні) і з payments/payroll (авто, tx).
   */
  async createOperation(
    orgId: string,
    input: CreateCashOperationInput,
    tx?: Prisma.TransactionClient,
  ): Promise<CashOperationResponseDto> {
    const amount = money(input.amount);
    if (!(amount > 0))
      throw new BadRequestException(translateError('err.cash.amountMustBePositive', getLocale()));

    const db = tx ?? this.prisma;

    const register = await db.cashRegister.findFirst({
      where: { id: input.cashRegisterId, orgId, deletedAt: null },
      select: { id: true, isFiscal: true, branchId: true, currencyId: true },
    });
    if (!register)
      throw new NotFoundException(translateError('err.cashRegister.notFound', getLocale()));

    // Мультивалюта (Фаза 1): amountBase у базовій валюті org по курсу на дату операції. Валюта —
    // з каси (моно-валютна). Базова каса → rate=1, base=amount; інша валюта без курсу на дату → 400.
    const conv = await this.exchangeRates.resolveBaseConversion(
      orgId,
      register.currencyId,
      new Date(),
      amount,
    );

    // Стаття руху коштів (валідація належності org + тип↔напрям): OUT лише EXPENSE-стаття,
    // IN лише INCOME-стаття — гарантує коректність звітності по статтях.
    if (input.expenseCategoryId) {
      const cat = await db.expenseCategory.findFirst({
        where: { id: input.expenseCategoryId, orgId, deletedAt: null },
        select: { type: true, isActive: true },
      });
      if (!cat)
        throw new NotFoundException(translateError('err.cash.categoryNotFound', getLocale()));
      // Bug #735: вимкнена стаття (isActive=false, напр. після toggleActive гілки) не має
      // приймати НОВІ операції — інакше вона «архівована» лише в UI, а пряме API її пропускає,
      // спотворюючи звітність по активних статтях. Історичні операції лишаються недоторканими.
      if (!cat.isActive)
        throw new BadRequestException(translateError('err.cash.categoryInactive', getLocale()));
      const expected = input.direction === 'IN' ? 'INCOME' : 'EXPENSE';
      if (cat.type !== expected) {
        throw new BadRequestException(
          input.direction === 'IN'
            ? translateError('err.cash.categoryTypeIncome', getLocale())
            : translateError('err.cash.categoryTypeExpense', getLocale()),
        );
      }
    }

    // Фіскальна каса → потрібна відкрита зміна цієї каси.
    let cashShiftId: string | null = null;
    if (register.isFiscal) {
      const shift = await db.cashShift.findFirst({
        where: { orgId, cashRegisterId: register.id, status: 'OPEN', deletedAt: null },
        select: { id: true },
      });
      if (!shift)
        throw new BadRequestException(
          translateError('err.cash.shiftRequiredForFiscal', getLocale()),
        );
      cashShiftId = shift.id;
    }

    const run = async (client: Prisma.TransactionClient) => {
      // Overdraft-guard: OUT не може вигнати касу в мінус. Баланс читаємо ТИМ САМИМ client, що й
      // insert нижче — тож multi-OUT в одній tx (payroll: OUT на співробітника) враховує вже-списане
      // цієї транзакції. Толеранс −0.001 лишається: з Money обидва операнди кратні копійці й
      // похибки вже немає, але поріг також поглинає легітимну копійчану різницю — знімати його
      // означало б змінити поведінку guard-а, а не прибрати мертвий код.
      if (input.direction === 'OUT') {
        const balance = await this.getBalance(orgId, register.id, client);
        if (balance - amount < -0.001) {
          throw new BadRequestException(
            // Суми — у валюті каси (каса моно-валютна), тож без хардкоду ₴ (каса може бути USD/EUR).
            translateError('err.cash.insufficientCash', getLocale(), {
              available: balance,
              required: amount,
            }),
          );
        }
      }
      const op = await client.cashOperation.create({
        data: {
          orgId,
          cashRegisterId: register.id,
          cashShiftId,
          direction: input.direction,
          amount,
          amountBase: conv.amountBase,
          rateUsed: conv.rateUsed,
          reason: input.reason,
          expenseCategoryId: input.expenseCategoryId ?? null,
          counterpartyId: input.counterpartyId ?? null,
          employeeId: input.employeeId ?? null,
          documentType: input.documentType ?? null,
          documentId: input.documentId ?? null,
          notes: input.notes ?? null,
          createdBy: input.createdBy ?? null,
        },
        include: { expenseCategory: { select: { name: true } } },
      });
      return op;
    };

    // Зовнішній tx: guard читає його ж стан (викликач керує isolation). Без tx: власна Serializable
    // транзакція — Postgres SSI ловить конкурентний OUT, що прочитав той самий залишок (Bug #416
    // патерн invoices). P2034 (serialization failure) → зрозуміла 400 замість 500.
    let op: Awaited<ReturnType<typeof run>>;
    try {
      op = tx
        ? await run(tx)
        : await this.prisma.$transaction(run, {
            timeout: TRANSACTION_TIMEOUT_MS,
            isolationLevel: 'Serializable',
          });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2034') {
        throw new BadRequestException(translateError('err.cash.concurrentOperation', getLocale()));
      }
      throw e;
    }

    // Аудит (поза tx щоб не подовжувати транзакцію; best-effort).
    if (input.createdBy) {
      this.audit
        .record(orgId, 'CashOperation', op.id, 'CREATE', input.createdBy, undefined, {
          direction: input.direction,
          amount,
          reason: input.reason,
        })
        .catch(() => undefined);
    }
    return this.opToDto(op);
  }

  /** Ручна операція з контролера. */
  async createManual(
    orgId: string,
    cashRegisterId: string,
    dto: CreateCashOperationDto,
    userId?: string,
  ): Promise<CashOperationResponseDto> {
    // CashReasonDto — власний TS-enum DTO-шару; рівність із рядковим літералом вірна
    // за значенням, але для типів це різні enum-и. Звіряємося з членом enum.
    if (dto.reason === CashReasonDto.EXPENSE && !dto.expenseCategoryId)
      throw new BadRequestException(
        translateError('err.cash.expenseRequiresCategory', getLocale()),
      );
    return this.createOperation(orgId, {
      cashRegisterId,
      direction: dto.direction,
      amount: dto.amount,
      reason: dto.reason,
      expenseCategoryId: dto.expenseCategoryId ?? null,
      counterpartyId: dto.counterpartyId ?? null,
      notes: dto.notes ?? null,
      createdBy: userId ?? null,
    });
  }

  /**
   * Поточний залишок каси = initialBalance + Σ(sign*amount). `db` — опційний tx-client: коли
   * передано, агрегація бачить незакомічені операції ТІЄЇ Ж транзакції (потрібно overdraft-guard-у
   * у createOperation, де multi-OUT списуються в одну tx і кожен наступний OUT має враховувати
   * попередні). Без `db` — звичайне читання поза транзакцією.
   */
  async getBalance(
    orgId: string,
    cashRegisterId: string,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<Money> {
    const register = await db.cashRegister.findFirst({
      where: { id: cashRegisterId, orgId, deletedAt: null },
      select: { initialBalance: true },
    });
    if (!register)
      throw new NotFoundException(translateError('err.cashRegister.notFound', getLocale()));
    return this.computeBalance(
      orgId,
      cashRegisterId,
      moneyFromDecimal(register.initialBalance),
      db,
    );
  }

  /**
   * Пакетний розрахунок балансів кількох кас ОДНИМ запитом (замість N×getBalance = 3×N запитів).
   * `initials` — мапа cashRegisterId → initialBalance (виклик уже має її з кешованого DTO, тож
   * реєстри не перечитуються). Один `groupBy` по (cashRegisterId, direction) з `cashRegisterId IN
   * [ids]` замінює 2×N агрегацій. Семантика ІДЕНТИЧНА getBalance: initial + Σ(IN) − Σ(OUT), money().
   * Пустий вхід → пуста мапа (0 запитів). Каси без операцій отримують чистий initialBalance.
   */
  async getBalances(orgId: string, initials: Map<string, number>): Promise<Map<string, Money>> {
    const ids = [...initials.keys()];
    const result = new Map<string, Money>();
    if (ids.length === 0) return result;
    const grouped = await this.prisma.cashOperation.groupBy({
      by: ['cashRegisterId', 'direction'],
      where: { orgId, cashRegisterId: { in: ids } },
      _sum: { amount: true },
    });
    // sign*amount акумулятор на реєстр (IN +, OUT −). Акумулятор — сирий number:
    // округлення раз у кінці (money() нижче), а не покроково.
    const deltas = new Map<string, number>();
    for (const g of grouped) {
      const sum = moneyFromDecimal(g._sum.amount);
      // `sum * -1`, а не `-sum`: унарний мінус до Money заборонений лінтом
      // (no-unsafe-unary-minus) — заперечення не зберігає інваріант бренду.
      const signed = g.direction === 'IN' ? sum : sum * -1;
      deltas.set(g.cashRegisterId, (deltas.get(g.cashRegisterId) ?? 0) + signed);
    }
    for (const [id, initial] of initials) {
      result.set(id, money(initial + (deltas.get(id) ?? 0)));
    }
    return result;
  }

  private async computeBalance(
    orgId: string,
    cashRegisterId: string,
    initial: number,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<Money> {
    const [inAgg, outAgg] = await Promise.all([
      db.cashOperation.aggregate({
        where: { orgId, cashRegisterId, direction: 'IN' },
        _sum: { amount: true },
      }),
      db.cashOperation.aggregate({
        where: { orgId, cashRegisterId, direction: 'OUT' },
        _sum: { amount: true },
      }),
    ]);
    const inSum = moneyFromDecimal(inAgg._sum.amount);
    const outSum = moneyFromDecimal(outAgg._sum.amount);
    return money(initial + inSum - outSum);
  }

  async listOperations(
    orgId: string,
    cashRegisterId: string,
    limit?: number,
    filters: { q?: string; dateFrom?: string; dateTo?: string } = {},
  ): Promise<CashOperationResponseDto[]> {
    // Відбір за київським днем операції та пошук за приміткою або статтею витрат. Контрагент в
    // операції — лише id без зв'язку в схемі, тому за ним тут не шукаємо.
    const createdAt = kyivDayRangeFilter(filters.dateFrom, filters.dateTo);
    // limit приходить із query-рядка без DTO: `?limit=abc` давав NaN, а `take: NaN` Prisma
    // відхиляє (безіменний 400 «Некоректний запит»); від'ємне число вона читає як «останні N».
    // Усе, що не є додатним числом, — типові 100; стеля 500 лишається.
    const take =
      limit !== undefined && Number.isFinite(limit) && limit >= 1
        ? Math.min(Math.trunc(limit), 500)
        : 100;
    const contains = searchContains(filters.q);
    const ops = await this.prisma.cashOperation.findMany({
      where: {
        orgId,
        cashRegisterId,
        ...(createdAt && { createdAt }),
        ...(contains && {
          OR: [{ notes: contains }, { expenseCategory: { name: contains } }],
        }),
      },
      orderBy: { createdAt: 'desc' },
      take,
      include: { expenseCategory: { select: { name: true } } },
    });
    return ops.map(o => this.opToDto(o));
  }

  private opToDto(o: {
    id: string;
    cashRegisterId: string;
    cashShiftId: string | null;
    direction: CashDirection;
    amount: Prisma.Decimal;
    amountBase?: Prisma.Decimal | null;
    rateUsed?: Prisma.Decimal | null;
    reason: CashOperationReason;
    expenseCategoryId: string | null;
    counterpartyId: string | null;
    employeeId: string | null;
    documentType: string | null;
    documentId: string | null;
    notes: string | null;
    createdAt: Date;
    expenseCategory?: { name: string } | null;
  }): CashOperationResponseDto {
    return {
      id: o.id,
      cashRegisterId: o.cashRegisterId,
      cashShiftId: o.cashShiftId,
      direction: o.direction,
      amount: Number(o.amount),
      amountBase: o.amountBase != null ? Number(o.amountBase) : null,
      rateUsed: o.rateUsed != null ? Number(o.rateUsed) : null,
      reason: o.reason,
      expenseCategoryId: o.expenseCategoryId,
      expenseCategoryName: o.expenseCategory?.name ?? null,
      counterpartyId: o.counterpartyId,
      employeeId: o.employeeId,
      documentType: o.documentType,
      documentId: o.documentId,
      notes: o.notes,
      createdAt: o.createdAt.toISOString(),
    };
  }
}
