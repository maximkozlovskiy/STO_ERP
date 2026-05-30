import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class LoyaltyService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('loyalty') private readonly loyaltyQueue: Queue,
  ) {}

  /** Тенант-валідація: counterparty має належати org */
  private async assertCounterparty(orgId: string, counterpartyId: string): Promise<void> {
    const cp = await this.prisma.counterparty.findFirst({
      where: { id: counterpartyId, orgId, deletedAt: null },
      select: { id: true },
    });
    if (!cp) throw new NotFoundException('Контрагента не знайдено');
  }

  async getOrCreateAccount(orgId: string, counterpartyId: string) {
    await this.assertCounterparty(orgId, counterpartyId);
    return this.prisma.loyaltyAccount.upsert({
      where: { counterpartyId },
      update: {},
      create: { orgId, counterpartyId, balance: 0 },
    });
  }

  async getBalance(orgId: string, counterpartyId: string): Promise<{ balance: number; counterpartyId: string }> {
    // Parallel: tenant guard + balance fetch — обидва читають за {counterpartyId, orgId},
    // тенант ізоляція дублюється в `acc` query (orgId фільтр), тому assert лишається лише
    // як контракт NotFound для відсутнього CP. -1 RTT per call.
    const [cp, acc] = await Promise.all([
      this.prisma.counterparty.findFirst({ where: { id: counterpartyId, orgId, deletedAt: null }, select: { id: true } }),
      this.prisma.loyaltyAccount.findFirst({ where: { counterpartyId, orgId } }),
    ]);
    if (!cp) throw new NotFoundException('Контрагента не знайдено');
    return { balance: acc ? Number(acc.balance) : 0, counterpartyId };
  }

  async getTransactions(orgId: string, counterpartyId: string) {
    // Parallel: tenant guard + account fetch (same rationale as getBalance).
    const [cp, acc] = await Promise.all([
      this.prisma.counterparty.findFirst({ where: { id: counterpartyId, orgId, deletedAt: null }, select: { id: true } }),
      this.prisma.loyaltyAccount.findFirst({ where: { counterpartyId, orgId } }),
    ]);
    if (!cp) throw new NotFoundException('Контрагента не знайдено');
    if (!acc) return { items: [], total: 0 };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.loyaltyTransaction.findMany({
        where: { accountId: acc.id },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      this.prisma.loyaltyTransaction.count({ where: { accountId: acc.id } }),
    ]);
    return {
      items: items.map(t => ({
        id: t.id,
        type: t.type,
        points: Number(t.points),
        documentId: t.documentId,
        documentType: t.documentType,
        notes: t.notes,
        createdAt: t.createdAt.toISOString(),
      })),
      total,
    };
  }

  /** Додати в чергу нарахування балів після оплати (BullMQ-safe: attempts=10) */
  async queueEarn(
    orgId: string,
    counterpartyId: string,
    paymentAmount: number,
    documentId?: string,
  ): Promise<void> {
    await this.loyaltyQueue.add(
      'earn',
      { orgId, counterpartyId, paymentAmount, documentId },
      { attempts: 10, backoff: { type: 'exponential', delay: 30_000 } },
    );
  }

  /** Нарахувати бали за оплату (виконується процесором з черги) */
  async earn(
    orgId: string,
    counterpartyId: string,
    paymentAmount: number,
    documentId?: string,
  ): Promise<void> {
    const settings = await this.prisma.organisationSettings.findFirst({ where: { orgId } });
    if (!settings?.loyaltyEnabled) return;

    const earnPer = Number(settings.loyaltyEarnPer ?? 100);
    const earnPoints = Number(settings.loyaltyEarnPoints ?? 1);
    if (earnPer <= 0) return;

    const points = Math.floor(paymentAmount / earnPer) * earnPoints;
    if (points <= 0) return;

    const acc = await this.getOrCreateAccount(orgId, counterpartyId);
    await this.prisma.$transaction([
      this.prisma.loyaltyAccount.update({
        where: { id: acc.id },
        data: { balance: { increment: points } },
      }),
      this.prisma.loyaltyTransaction.create({
        data: {
          accountId: acc.id,
          type: 'EARN',
          points,
          documentId: documentId ?? null,
          documentType: documentId ? 'Payment' : null,
        },
      }),
    ]);
  }

  /** Списати бали (повертає суму знижки у гривнях) */
  async redeem(
    orgId: string,
    counterpartyId: string,
    points: number,
  ): Promise<{ discountAmount: number }> {
    if (points <= 0) throw new BadRequestException('Кількість балів має бути > 0');
    await this.assertCounterparty(orgId, counterpartyId);

    const settings = await this.prisma.organisationSettings.findFirst({ where: { orgId } });
    const redeemRate = Number(settings?.loyaltyRedeemRate ?? 1);
    const discountAmount = points * redeemRate;

    // Atomic check-and-decrement guards against double-spend when two redeem
    // requests race. We use `updateMany` with `balance >= points` so the SQL
    // `UPDATE ... WHERE balance >= N` is evaluated atomically by Postgres —
    // two concurrent updates cannot both succeed against the same row.
    // If `count === 0`, either the account doesn't exist or balance was too low.
    const result = await this.prisma.$transaction(async (tx) => {
      const acc = await tx.loyaltyAccount.findFirst({
        where: { counterpartyId, orgId },
        select: { id: true },
      });
      if (!acc) throw new NotFoundException('Рахунок лояльності не знайдено');

      const updated = await tx.loyaltyAccount.updateMany({
        where: { id: acc.id, balance: { gte: points } },
        data: { balance: { decrement: points } },
      });
      if (updated.count === 0) {
        throw new BadRequestException('Недостатньо балів');
      }

      await tx.loyaltyTransaction.create({
        data: {
          accountId: acc.id,
          type: 'REDEEM',
          points,
          notes: `Списання ${points} балів = ${discountAmount} грн знижки`,
        },
      });
      return discountAmount;
    }, { timeout: 5_000 }); // Bug #132: explicit timeout — atomic redeem з 2 операціями

    return { discountAmount: result };
  }
}
