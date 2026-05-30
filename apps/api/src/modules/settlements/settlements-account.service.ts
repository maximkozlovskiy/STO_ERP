import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PdfService } from '../pdf/pdf.service';
import { CreateReconciliationActDto } from './settlements.dto';

/** Returns the UTC instant corresponding to 00:00:00 Kyiv time on the given calendar date (YYYY-MM-DD). DST-safe. */
function kyivStartOfDay(date: string): Date {
  // Use noon in UTC to safely determine the Kyiv offset for that calendar date
  const probe = new Date(`${date}T12:00:00Z`);
  const kyivHour = parseInt(
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', hour: '2-digit', hour12: false }).format(probe),
    10,
  );
  const offsetMs = (kyivHour - probe.getUTCHours() + 24) % 24 * 3_600_000;
  return new Date(new Date(`${date}T00:00:00Z`).getTime() - offsetMs);
}

/** Returns the UTC instant corresponding to 23:59:59.999 Kyiv time on the given calendar date (YYYY-MM-DD). DST-safe. */
function kyivEndOfDay(date: string): Date {
  const probe = new Date(`${date}T12:00:00Z`);
  const kyivHour = parseInt(
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', hour: '2-digit', hour12: false }).format(probe),
    10,
  );
  const offsetMs = (kyivHour - probe.getUTCHours() + 24) % 24 * 3_600_000;
  return new Date(new Date(`${date}T23:59:59.999Z`).getTime() - offsetMs);
}

@Injectable()
export class SettlementsAccountService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pdf: PdfService,
  ) {}

  async getBalance(orgId: string, counterpartyId: string) {
    const account = await this.prisma.settlementAccount.findFirst({
      where: { orgId, counterpartyId },
    });
    if (!account) return { balance: 0, counterpartyId };
    return { balance: Number(account.balance), counterpartyId };
  }

  async getTransactions(orgId: string, counterpartyId: string, page = 1, limit = 50) {
    const account = await this.prisma.settlementAccount.findFirst({
      where: { orgId, counterpartyId },
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
    // Parallel cross-tenant validation — counterparty existence + account lookup
    // are independent reads on different tables (no FK chain).
    const [counterparty, account] = await Promise.all([
      this.prisma.counterparty.findFirst({
        where: { id: counterpartyId, orgId, deletedAt: null },
      }),
      this.prisma.settlementAccount.findFirst({
        where: { orgId, counterpartyId },
      }),
    ]);
    if (!counterparty) throw new NotFoundException('Контрагента не знайдено');
    if (!account) throw new NotFoundException('Розрахунковий рахунок не знайдено');

    // Convert Kyiv calendar boundaries to UTC using Intl (handles DST: UTC+2 winter / UTC+3 summer)
    const from = kyivStartOfDay(dto.periodFrom);
    const to = kyivEndOfDay(dto.periodTo);

    // Transactions within period
    const transactions = await this.prisma.settlementTransaction.findMany({
      where: {
        settlementAccountId: account.id,
        orgId,
        createdAt: { gte: from, lte: to },
      },
      orderBy: { createdAt: 'asc' },
      take: 5000,
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

  async generateReconciliationPdf(orgId: string, counterpartyId: string, actId: string): Promise<Buffer> {
    const act = await this.prisma.reconciliationAct.findFirst({
      where: { id: actId, orgId, counterpartyId },
      include: { counterparty: { select: { firstName: true, lastName: true, companyName: true } } },
    });
    if (!act) throw new NotFoundException('Акт звірки не знайдено');

    const org = await this.prisma.organisation.findFirst({ where: { id: orgId } });
    const cp = act.counterparty;
    const cpName = (cp?.companyName ?? [cp?.lastName, cp?.firstName].filter(Boolean).join(' ')) || 'Контрагент';

    const transactions = Array.isArray(act.snapshotJson)
      ? (act.snapshotJson as Array<{ date: string; type: string; amount: number; documentType?: string }>)
      : [];

    return this.pdf.generateReconciliationActPdf({
      org: { name: org?.name ?? 'СТО' },
      counterpartyName: cpName,
      periodFrom: act.periodFrom,
      periodTo: act.periodTo,
      openingBalance: Number(act.openingBalance),
      closingBalance: Number(act.closingBalance),
      transactions: transactions.map(t => ({ date: new Date(t.date), type: t.type, amount: t.amount, documentType: t.documentType })),
    });
  }

  async getReconciliationActs(orgId: string, counterpartyId: string) {
    const acts = await this.prisma.reconciliationAct.findMany({
      where: { orgId, counterpartyId },
      orderBy: { createdAt: 'desc' },
      take: 200,
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
