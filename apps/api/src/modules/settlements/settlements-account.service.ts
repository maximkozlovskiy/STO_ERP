import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PdfService } from '../pdf/pdf.service';
import { CreateReconciliationActDto } from './settlements.dto';

// Module-level Intl singleton — DateTimeFormat constructor is the expensive part (locale-data init).
// Both kyivStartOfDay/kyivEndOfDay used to allocate a new formatter per call; createReconciliationAct
// invokes both per request → 2 allocations × every reconciliation.
const KYIV_HOUR_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Kyiv',
  hour: '2-digit',
  hour12: false,
});

/** Returns the UTC instant corresponding to 00:00:00 Kyiv time on the given calendar date (YYYY-MM-DD). DST-safe. */
function kyivStartOfDay(date: string): Date {
  // Use noon in UTC to safely determine the Kyiv offset for that calendar date
  const probe = new Date(`${date}T12:00:00Z`);
  const kyivHour = parseInt(KYIV_HOUR_FMT.format(probe), 10);
  const offsetMs = ((kyivHour - probe.getUTCHours() + 24) % 24) * 3_600_000;
  return new Date(new Date(`${date}T00:00:00Z`).getTime() - offsetMs);
}

/** Returns the UTC instant corresponding to 23:59:59.999 Kyiv time on the given calendar date (YYYY-MM-DD). DST-safe. */
function kyivEndOfDay(date: string): Date {
  const probe = new Date(`${date}T12:00:00Z`);
  const kyivHour = parseInt(KYIV_HOUR_FMT.format(probe), 10);
  const offsetMs = ((kyivHour - probe.getUTCHours() + 24) % 24) * 3_600_000;
  return new Date(new Date(`${date}T23:59:59.999Z`).getTime() - offsetMs);
}

@Injectable()
export class SettlementsAccountService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pdf: PdfService,
  ) {}

  async getBalance(orgId: string, counterpartyId: string) {
    // Narrow projection — лише balance потрібен для відповіді.
    const account = await this.prisma.settlementAccount.findFirst({
      where: { orgId, counterpartyId },
      select: { balance: true },
    });
    if (!account) return { balance: 0, counterpartyId };
    return { balance: Number(account.balance), counterpartyId };
  }

  async getTransactions(orgId: string, counterpartyId: string, page = 1, limit = 50) {
    // DoS hardening: cap user-controlled pagination params (defensive backup
    // to controller-level validation). `?limit=999999` would OOM the API
    // when settlement_transactions has tens of thousands of rows per org.
    const safeLimit = Math.min(Math.max(limit, 1), 200);
    const safePage = Math.max(page, 1);

    // Narrow projection — потрібен лише account.id як FK у settlementTransaction queries.
    const account = await this.prisma.settlementAccount.findFirst({
      where: { orgId, counterpartyId },
      select: { id: true },
    });
    if (!account) return { items: [], total: 0, page: safePage, limit: safeLimit };

    const skip = (safePage - 1) * safeLimit;
    const [items, total] = await Promise.all([
      this.prisma.settlementTransaction.findMany({
        where: { settlementAccountId: account.id, orgId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: safeLimit,
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
      total,
      page: safePage,
      limit: safeLimit,
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
    // Narrow projections — counterparty потрібен лише для NotFoundException;
    // account.id + account.balance використовуються для closingBalance розрахунку.
    const [counterparty, account] = await Promise.all([
      this.prisma.counterparty.findFirst({
        where: { id: counterpartyId, orgId, deletedAt: null },
        select: { id: true },
      }),
      this.prisma.settlementAccount.findFirst({
        where: { orgId, counterpartyId },
        select: { id: true, balance: true },
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

  async generateReconciliationPdf(
    orgId: string,
    counterpartyId: string,
    actId: string,
  ): Promise<Buffer> {
    // Perf: act + organisation мають незалежний tenant-isolation (act has orgId+actId+counterpartyId,
    // org has id=orgId) — паралель не псує семантику NotFound (throw після Promise.all).
    // PDF narrow select: act має 10+ колонок (id/orgId/createdAt/syncVersion/deletedAt тощо),
    // PDF використовує лише periodFrom/periodTo/openingBalance/closingBalance/snapshotJson + counterparty.
    // org має 15+ settings колонок, PDF читає лише name.
    const [act, org] = await Promise.all([
      this.prisma.reconciliationAct.findFirst({
        where: { id: actId, orgId, counterpartyId },
        select: {
          periodFrom: true,
          periodTo: true,
          openingBalance: true,
          closingBalance: true,
          snapshotJson: true,
          counterparty: { select: { firstName: true, lastName: true, companyName: true } },
        },
      }),
      this.prisma.organisation.findFirst({
        where: { id: orgId },
        select: { name: true },
      }),
    ]);
    if (!act) throw new NotFoundException('Акт звірки не знайдено');
    const cp = act.counterparty;
    const cpName =
      (cp?.companyName ?? [cp?.lastName, cp?.firstName].filter(Boolean).join(' ')) || 'Контрагент';

    const transactions = Array.isArray(act.snapshotJson)
      ? (act.snapshotJson as Array<{
          date: string;
          type: string;
          amount: number;
          documentType?: string;
        }>)
      : [];

    return this.pdf.generateReconciliationActPdf({
      org: { name: org?.name ?? 'СТО' },
      counterpartyName: cpName,
      periodFrom: act.periodFrom,
      periodTo: act.periodTo,
      openingBalance: Number(act.openingBalance),
      closingBalance: Number(act.closingBalance),
      transactions: transactions.map(t => ({
        date: new Date(t.date),
        type: t.type,
        amount: t.amount,
        documentType: t.documentType,
      })),
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
