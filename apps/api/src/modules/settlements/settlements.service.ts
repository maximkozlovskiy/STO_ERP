import { Injectable, NotFoundException } from '@nestjs/common';
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

  async createTransaction(orgId: string, dto: CreateTransactionDto, tx?: Prisma.TransactionClient): Promise<void> {
    const run = async (db: Prisma.TransactionClient | PrismaService) => {
      const account = await db.settlementAccount.findFirst({
        where: { orgId, counterpartyId: dto.counterpartyId },
      });
      if (!account) throw new NotFoundException('Розрахунковий рахунок контрагента не знайдено');

      await db.settlementTransaction.create({
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
      });

      // Positive types increase balance (client owes us), negative types decrease it
      let balanceDelta: number;
      if (dto.type === 'CHARGE') balanceDelta = dto.amount;
      else if (dto.type === 'PAYMENT') balanceDelta = -dto.amount;
      else if (dto.type === 'PREPAYMENT') balanceDelta = -dto.amount;
      else if (dto.type === 'REFUND') balanceDelta = -dto.amount;
      else if (dto.type === 'CREDIT_NOTE') balanceDelta = -dto.amount;
      else throw new Error(`Unknown SettlementTransactionType: ${dto.type as string}`);

      await db.settlementAccount.update({
        where: { id: account.id, orgId },
        data: { balance: { increment: balanceDelta } },
      });
    };

    // When called inside an outer $transaction, use that client; otherwise wrap in own transaction
    if (tx) {
      await run(tx);
    } else {
      await this.prisma.$transaction(run);
    }
  }

  async getBalance(orgId: string, counterpartyId: string): Promise<number> {
    const account = await this.prisma.settlementAccount.findFirst({
      where: { orgId, counterpartyId },
    });
    return account ? Number(account.balance) : 0;
  }
}
