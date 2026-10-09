import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { TRANSACTION_TIMEOUT_MS, translateError } from '@sto/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { getLocale } from '../../common/tenant/tenant-context';
import { calculatePagination } from '../../common/utils/pagination';
import { PdfService } from '../pdf/pdf.service';
import { CreateReconciliationActDto } from './settlements.dto';
import { BALANCE_SIGN } from './settlements.service';
import { money, moneyFromDecimal } from '../../common/utils/money';
import { kyivDayEnd, kyivDayStart } from '../../common/utils/kyiv-date';

/** Max rows in one reconciliation act snapshot; a larger period is rejected, not truncated. */
const ACT_MAX_TRANSACTIONS = 5000;

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
    // DoS hardening: cap user-controlled pagination params (defensive backup to controller-level
    // validation). `?limit=999999` would OOM the API when settlement_transactions has tens of
    // thousands of rows per org. Спільна утиліта: NaN-guard + cap(200) + clamp page≥1.
    const { skip, take: safeLimit } = calculatePagination({ page, limit });
    const safePage = Math.floor(skip / safeLimit) + 1;

    // Narrow projection — потрібен лише account.id як FK у settlementTransaction queries.
    const account = await this.prisma.settlementAccount.findFirst({
      where: { orgId, counterpartyId },
      select: { id: true },
    });
    if (!account) return { items: [], total: 0, page: safePage, limit: safeLimit };

    const [items, total] = await Promise.all([
      this.prisma.settlementTransaction.findMany({
        where: { settlementAccountId: account.id, orgId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: safeLimit,
        // Мультивалюта (Фаза 2): код валюти транзакції для UI (символ + base-сума).
        include: { currency: { select: { code: true } } },
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
        // Мультивалюта (Фаза 2): валюта + base-сума (null → історичні/base UAH).
        currencyId: t.currencyId,
        currencyCode: t.currency?.code ?? null,
        amountBase: t.amountBase != null ? Number(t.amountBase) : null,
        rateUsed: t.rateUsed != null ? Number(t.rateUsed) : null,
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

  /**
   * Σ(знак × сума у базовій валюті) транзакцій рахунку, пізніших за `after`. Два агрегати по
   * типах: рядки з `amountBase` і історичні без нього (до мультивалюти: amount = base).
   */
  private async signedDeltaAfter(
    db: Pick<Prisma.TransactionClient, 'settlementTransaction'>,
    settlementAccountId: string,
    orgId: string,
    after: Date,
  ): Promise<number> {
    const where = { settlementAccountId, orgId, createdAt: { gt: after } };
    const [withBase, legacy] = await Promise.all([
      db.settlementTransaction.groupBy({
        by: ['type'],
        where: { ...where, amountBase: { not: null } },
        _sum: { amountBase: true },
      }),
      db.settlementTransaction.groupBy({
        by: ['type'],
        where: { ...where, amountBase: null },
        _sum: { amount: true },
      }),
    ]);
    let delta = 0;
    for (const g of withBase) delta += BALANCE_SIGN[g.type] * Number(g._sum.amountBase ?? 0);
    for (const g of legacy) delta += BALANCE_SIGN[g.type] * Number(g._sum.amount ?? 0);
    return money(delta);
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
    if (!counterparty)
      throw new NotFoundException(
        translateError('err.settlement.counterpartyNotFound', getLocale()),
      );
    if (!account)
      throw new NotFoundException(translateError('err.settlement.accountNotFound', getLocale()));

    // Convert Kyiv calendar boundaries to UTC using Intl (handles DST: UTC+2 winter / UTC+3 summer)
    const from = kyivDayStart(dto.periodFrom);
    const to = kyivDayEnd(dto.periodTo);

    // Баланс, транзакції періоду й агрегат «після періоду» читаються з ОДНОГО знімка БД
    // (RepeatableRead). Три окремі читання давали акт, що не сходиться сам із собою: платіж,
    // проведений між читанням балансу й агрегатом, потрапляв у «після періоду», але не в баланс,
    // і закриваючий залишок з'їжджав рівно на його суму. Транзакція лише читає — конфліктів
    // серіалізації RepeatableRead тут не дає.
    const { balance, transactions, afterPeriodDelta } = await this.prisma.$transaction(
      async tx => {
        const snapshot = await tx.settlementAccount.findFirst({
          where: { id: account.id, orgId },
          select: { balance: true },
        });
        const rows = await tx.settlementTransaction.findMany({
          where: {
            settlementAccountId: account.id,
            orgId,
            createdAt: { gte: from, lte: to },
          },
          orderBy: { createdAt: 'asc' },
          // +1 понад стелю — лише щоб помітити переповнення: акт з обрізаним переліком і повними
          // сумами клієнт підписати не може, тож краще відмовити, ніж мовчки обрізати.
          take: ACT_MAX_TRANSACTIONS + 1,
        });
        if (rows.length > ACT_MAX_TRANSACTIONS) {
          throw new BadRequestException(
            translateError('err.settlement.actPeriodTooLarge', getLocale(), {
              limit: ACT_MAX_TRANSACTIONS,
            }),
          );
        }
        return {
          balance: snapshot?.balance ?? account.balance,
          transactions: rows,
          afterPeriodDelta: await this.signedDeltaAfter(tx, account.id, orgId, to),
        };
      },
      { isolationLevel: 'RepeatableRead', timeout: TRANSACTION_TIMEOUT_MS },
    );

    // Opening balance derived from current snapshot balance minus in-period delta
    // This avoids a full table scan on the append-only transactions log
    // Використовуємо ЄДИНЕ джерело знаку (BALANCE_SIGN) — раніше тут була захардкоджена
    // копія `type==='CHARGE' ? + : -`, яка не знала про постачальницькі типи (SUPPLIER_*).
    // Мультивалюта (Фаза 2): баланс зводиться у base → periodDelta від amountBase (не amount).
    // Історичні рядки (amountBase=null) = base UAH → фолбек на amount.
    // `money()` на кожному грошовому результаті (а не просто Number): без нього сума
    // транзакцій у JS-float дрейфує — заміряно 66% випадків на реалістичних даних, хоч
    // величина (≈2e-11) і нижча за розрядність Decimal(12,2). Тут це профілактика, не
    // виправлення бага: openingBalance пишеться в БД і читається звідти вже округленим
    // Postgres-ом. Але тип Money не дає ПОТІМ забути округлення, якщо значення почнуть
    // віддавати напряму з обчислення — а це акт звірки, який клієнт підписує.
    const periodDelta = money(
      transactions.reduce(
        (sum, t) => sum + BALANCE_SIGN[t.type] * Number(t.amountBase ?? t.amount),
        0,
      ),
    );

    // BR-SETL-011: закриваючий баланс — СТАНОМ НА КІНЕЦЬ ПЕРІОДУ, а не поточний. До 2026-10-08
    // сюди йшов `account.balance` як є, і акт за січень, сформований у березні, показував
    // березневий залишок. Поточний баланс мінус усе, що сталося ПІСЛЯ періоду, дає залишок на
    // його кінець; транзакцій після періоду може бути скільки завгодно, тому — агрегат, не вибірка.
    const closingBalance = money(moneyFromDecimal(balance) - afterPeriodDelta);
    const openingBalance = money(closingBalance - periodDelta);

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
          // Мультивалюта (Фаза 2): base-сума (для звірки у base, узгоджено з opening/closing).
          amountBase: t.amountBase != null ? Number(t.amountBase) : Number(t.amount),
          currencyId: t.currencyId,
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
    if (!act)
      throw new NotFoundException(
        translateError('err.settlement.reconciliationActNotFound', getLocale()),
      );
    const cp = act.counterparty;
    const cpName =
      (cp?.companyName ?? [cp?.lastName, cp?.firstName].filter(Boolean).join(' ')) || 'Контрагент';

    const transactions = Array.isArray(act.snapshotJson)
      ? (act.snapshotJson as Array<{
          date: string;
          type: string;
          amount: number;
          amountBase?: number;
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
      // Мультивалюта (Фаза 2): у base — суми узгоджені з opening/closing (base). amountBase з
      // нового snapshot; старі акти (без поля) → amount (усі були base UAH).
      transactions: transactions.map(t => ({
        date: new Date(t.date),
        type: t.type,
        amount: t.amountBase ?? t.amount,
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
