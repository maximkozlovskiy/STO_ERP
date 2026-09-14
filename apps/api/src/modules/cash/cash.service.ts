import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { CashDirection, CashOperationReason, Prisma } from '@prisma/client';
import { TRANSACTION_TIMEOUT_MS } from '@sto/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { ExchangeRatesService } from '../exchange-rates/exchange-rates.service';
import { roundMoney } from '../../common/utils/math';
import { CashOperationResponseDto, CreateCashOperationDto } from './cash.dto';

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
    const amount = roundMoney(input.amount);
    if (!(amount > 0)) throw new BadRequestException('Сума має бути додатною');

    const db = tx ?? this.prisma;

    const register = await db.cashRegister.findFirst({
      where: { id: input.cashRegisterId, orgId, deletedAt: null },
      select: { id: true, isFiscal: true, branchId: true, currencyId: true },
    });
    if (!register) throw new NotFoundException('Касу не знайдено');

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
      if (!cat) throw new NotFoundException('Статтю не знайдено');
      // Bug #735: вимкнена стаття (isActive=false, напр. після toggleActive гілки) не має
      // приймати НОВІ операції — інакше вона «архівована» лише в UI, а пряме API її пропускає,
      // спотворюючи звітність по активних статтях. Історичні операції лишаються недоторканими.
      if (!cat.isActive) throw new BadRequestException('Стаття вимкнена — оберіть активну');
      const expected = input.direction === 'IN' ? 'INCOME' : 'EXPENSE';
      if (cat.type !== expected) {
        throw new BadRequestException(
          input.direction === 'IN'
            ? 'Для внесення оберіть статтю оприбуткування'
            : 'Для видачі оберіть статтю витрат',
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
          'Для фіскальної каси відкрийте зміну перед операціями з готівкою',
        );
      cashShiftId = shift.id;
    }

    const run = async (client: Prisma.TransactionClient) => {
      // Overdraft-guard: OUT не може вигнати касу в мінус. Баланс читаємо ТИМ САМИМ client, що й
      // insert нижче — тож multi-OUT в одній tx (payroll: OUT на співробітника) враховує вже-списане
      // цієї транзакції. Толеранс −0.001 щоб копійкова похибка roundMoney не давала хибний блок.
      if (input.direction === 'OUT') {
        const balance = await this.getBalance(orgId, register.id, client);
        if (balance - amount < -0.001) {
          throw new BadRequestException(
            `Недостатньо готівки в касі: доступно ${roundMoney(balance)} ₴, потрібно ${amount} ₴`,
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
        throw new BadRequestException('Каса зайнята паралельною операцією — повторіть');
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
    if (dto.reason === 'EXPENSE' && !dto.expenseCategoryId)
      throw new BadRequestException('Для витрати вкажіть статтю витрат');
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
  ): Promise<number> {
    const register = await db.cashRegister.findFirst({
      where: { id: cashRegisterId, orgId, deletedAt: null },
      select: { initialBalance: true },
    });
    if (!register) throw new NotFoundException('Касу не знайдено');
    return this.computeBalance(orgId, cashRegisterId, Number(register.initialBalance), db);
  }

  private async computeBalance(
    orgId: string,
    cashRegisterId: string,
    initial: number,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<number> {
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
    const inSum = Number(inAgg._sum.amount ?? 0);
    const outSum = Number(outAgg._sum.amount ?? 0);
    return roundMoney(initial + inSum - outSum);
  }

  async listOperations(
    orgId: string,
    cashRegisterId: string,
    limit = 100,
  ): Promise<CashOperationResponseDto[]> {
    const ops = await this.prisma.cashOperation.findMany({
      where: { orgId, cashRegisterId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 500),
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
