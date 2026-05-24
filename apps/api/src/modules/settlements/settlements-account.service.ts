import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateReconciliationActDto } from './settlements.dto';

@Injectable()
export class SettlementsAccountService {
  constructor(private readonly prisma: PrismaService) {}

  async getBalance(orgId: string, counterpartyId: string) {
    const account = await this.prisma.settlementAccount.findFirst({
      where: { orgId, counterpartyId, deletedAt: null },
    });
    if (!account) return { balance: 0, counterpartyId };
    return { balance: Number(account.balance), counterpartyId };
  }

  async getTransactions(orgId: string, counterpartyId: string, page = 1, limit = 50) {
    const account = await this.prisma.settlementAccount.findFirst({
      where: { orgId, counterpartyId, deletedAt: null },
    });
    if (!account) return { items: [], total: 0, page, limit };

    const skip = (page - 1) * limit;
    const [items, total] = await this.prisma.$transaction([
      this.prisma.settlementTransaction.findMany({
        where: { settlementAccountId: account.id, orgId },
        orderBy: { createdAt: 'desc' },
        skip, take: limit,
      }),
      this.prisma.settlementTransaction.count({
        where: { settlementAccountId: account.id, orgId },
      }),
    ]);

    return {
      items: items.map(t => ({
        id: t.id,
        type: t.type,
        amount: Number(t.amount),
        documentType: t.documentType,
        documentId: t.documentId,
        notes: t.notes,
        createdAt: t.createdAt,
      })),
      total, page, limit,
    };
  }

  async createReconciliationAct(
    orgId: string,
    counterpartyId: string,
    dto: CreateReconciliationActDto,
    userId?: string,
  ) {
    const counterparty = await this.prisma.counterparty.findFirst({
      where: { id: counterpartyId, orgId, deletedAt: null },
    });
    if (!counterparty) throw new NotFoundException('Контрагента не знайдено');

    const account = await this.prisma.settlementAccount.findFirst({
      where: { orgId, counterpartyId, deletedAt: null },
    });
    if (!account) throw new NotFoundException('Розрахунковий рахунок не знайдено');

    const from = new Date(dto.periodFrom);
    const to = new Date(dto.periodTo);
    to.setHours(23, 59, 59, 999);

    // Transactions within period
    const transactions = await this.prisma.settlementTransaction.findMany({
      where: {
        settlementAccountId: account.id,
        orgId,
        createdAt: { gte: from, lte: to },
      },
      orderBy: { createdAt: 'asc' },
    });

    // Opening balance derived from current snapshot balance minus in-period delta
    // This avoids a full table scan on the append-only transactions log
    const periodDelta = transactions.reduce((sum, t) => {
      const delta = t.type === 'CHARGE' ? Number(t.amount) : -Number(t.amount);
      return sum + delta;
    }, 0);

    const closingBalance = Number(account.balance);
    const openingBalance = closingBalance - periodDelta;

    const act = await this.prisma.reconciliationAct.create({
      data: {
        orgId,
        counterpartyId,
        periodFrom: from,
        periodTo: to,
        openingBalance,
        closingBalance,
        snapshotJson: transactions.map(t => ({
          date: t.createdAt,
          type: t.type,
          amount: Number(t.amount),
          documentType: t.documentType,
          documentId: t.documentId,
        })),
        createdBy: userId ?? null,
      },
    });

    return {
      id: act.id,
      counterpartyId,
      periodFrom: act.periodFrom,
      periodTo: act.periodTo,
      openingBalance: Number(act.openingBalance),
      closingBalance: Number(act.closingBalance),
      transactions: act.snapshotJson,
      createdAt: act.createdAt,
    };
  }

  async getReconciliationActs(orgId: string, counterpartyId: string) {
    const acts = await this.prisma.reconciliationAct.findMany({
      where: { orgId, counterpartyId },
      orderBy: { createdAt: 'desc' },
    });

    return acts.map(a => ({
      id: a.id,
      counterpartyId: a.counterpartyId,
      periodFrom: a.periodFrom,
      periodTo: a.periodTo,
      openingBalance: Number(a.openingBalance),
      closingBalance: Number(a.closingBalance),
      createdAt: a.createdAt,
    }));
  }
}
