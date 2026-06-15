import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { TRANSACTION_TIMEOUT_MS } from '@sto/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma, SettlementTransactionType } from '@prisma/client';

export interface CreateTransactionDto {
  counterpartyId: string;
  type: SettlementTransactionType;
  amount: number; // always positive — sign determined by type
  documentType?: string;
  documentId?: string;
  notes?: string;
  createdBy?: string;
}

@Injectable()
export class SettlementsService {
  constructor(private readonly prisma: PrismaService) {}

  async createTransaction(
    orgId: string,
    dto: CreateTransactionDto,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    if (!Number.isFinite(dto.amount) || dto.amount <= 0) {
      throw new BadRequestException('Сума транзакції повинна бути більшою за нуль');
    }
    // Pre-compute balance delta — pure sync check, fail-fast before any DB work.
    // Positive types increase balance (client owes us), negative types decrease it.
    let balanceDelta: number;
    if (dto.type === 'CHARGE') balanceDelta = dto.amount;
    else if (dto.type === 'PAYMENT') balanceDelta = -dto.amount;
    else if (dto.type === 'PREPAYMENT') balanceDelta = -dto.amount;
    else if (dto.type === 'REFUND') balanceDelta = -dto.amount;
    else if (dto.type === 'CREDIT_NOTE') balanceDelta = -dto.amount;
    else throw new Error(`Unknown SettlementTransactionType: ${dto.type as string}`);

    const run = async (db: Prisma.TransactionClient | PrismaService) => {
      // SettlementAccount has no deletedAt — it's a singleton per counterparty, never soft-deleted
      const account = await db.settlementAccount.findFirst({
        where: { orgId, counterpartyId: dto.counterpartyId },
        select: { id: true },
      });
      if (!account) throw new NotFoundException('Розрахунковий рахунок контрагента не знайдено');

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

    // When called inside an outer $transaction, use that client; otherwise wrap in own transaction
    if (tx) {
      await run(tx);
    } else {
      // Bug #132: explicit timeout — викликається з work-orders COMPLETED flow, де можуть бути додаткові writes
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
