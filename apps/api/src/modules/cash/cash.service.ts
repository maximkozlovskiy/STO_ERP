import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { CashDirection, CashOperationReason, Prisma } from '@prisma/client';
import { TRANSACTION_TIMEOUT_MS } from '@sto/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { roundMoney } from '../../common/utils/math';
import { CashOperationResponseDto, CreateCashOperationDto } from './cash.dto';

// Знак операції для балансу: IN додає готівку, OUT — віднімає.
const CASH_SIGN: Record<CashDirection, 1 | -1> = { IN: 1, OUT: -1 };

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
      select: { id: true, isFiscal: true, branchId: true },
    });
    if (!register) throw new NotFoundException('Касу не знайдено');

    // Стаття витрат (валідація належності org) — лише для EXPENSE.
    if (input.expenseCategoryId) {
      const cat = await db.expenseCategory.findFirst({
        where: { id: input.expenseCategoryId, orgId, deletedAt: null },
        select: { id: true },
      });
      if (!cat) throw new NotFoundException('Статтю витрат не знайдено');
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
      const op = await client.cashOperation.create({
        data: {
          orgId,
          cashRegisterId: register.id,
          cashShiftId,
          direction: input.direction,
          amount,
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

    const op = tx
      ? await run(tx)
      : await this.prisma.$transaction(run, { timeout: TRANSACTION_TIMEOUT_MS });

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

  /** Поточний залишок каси = initialBalance + Σ(sign*amount). */
  async getBalance(orgId: string, cashRegisterId: string): Promise<number> {
    const register = await this.prisma.cashRegister.findFirst({
      where: { id: cashRegisterId, orgId, deletedAt: null },
      select: { initialBalance: true },
    });
    if (!register) throw new NotFoundException('Касу не знайдено');
    return this.computeBalance(orgId, cashRegisterId, Number(register.initialBalance));
  }

  private async computeBalance(
    orgId: string,
    cashRegisterId: string,
    initial: number,
  ): Promise<number> {
    const [inAgg, outAgg] = await Promise.all([
      this.prisma.cashOperation.aggregate({
        where: { orgId, cashRegisterId, direction: 'IN' },
        _sum: { amount: true },
      }),
      this.prisma.cashOperation.aggregate({
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
