import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import {
  Prisma,
  SupplierPaymentStatus,
  PaymentSourceType,
  PurchaseOrderStatus,
} from '@prisma/client';

import { kyivToday } from '../../common/utils/kyiv-date';
import { calculatePagination, buildSortOrderBy } from '../../common/utils/pagination';
import { uniqueDefinedIds, initCountsMap } from '../../common/utils/linked-counts';
import { PrismaService } from '../../prisma/prisma.service';
import { formatPersonName, TRANSACTION_TIMEOUT_MS } from '@sto/shared';
import { DocumentNumberService } from '../document-number/document-number.service';
import { SettlementsService } from '../settlements/settlements.service';
import {
  CreateSupplierPaymentDto,
  UpdateSupplierPaymentDto,
  SupplierPaymentResponseDto,
  PaginatedSupplierPaymentsDto,
  SupplierPaymentScheduleDto,
} from './supplier-payments.dto';

type SPStatus = SupplierPaymentStatus;

const SP_TRANSITIONS: Record<SPStatus, SPStatus[]> = {
  DRAFT: [SupplierPaymentStatus.CONFIRMED, SupplierPaymentStatus.CANCELLED],
  CONFIRMED: [],
  CANCELLED: [],
};

// Whitelist сортування — ключ із запиту → реальне поле БД. Module-level:
// findAll викликається на кожен list-refresh (polling кожні 30s, зміна фільтрів,
// пагінація) — SORT_FIELDS повинен бути алоцьований одноразово, а не на кожен виклик.
const SP_SORT_FIELDS: Record<string, string> = {
  number: 'number',
  amount: 'amount',
  documentDate: 'documentDate',
  createdAt: 'createdAt',
};

@Injectable()
export class SupplierPaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settlements: SettlementsService,
    private readonly docNumbers: DocumentNumberService,
  ) {}

  async findAll(
    orgId: string,
    page = 1,
    limit = 20,
    status?: SPStatus,
    supplierId?: string,
    q?: string,
    showDeleted = false,
    dateFrom?: string,
    dateTo?: string,
    sortBy?: string,
    sortDir?: 'asc' | 'desc',
    purchaseOrderId?: string,
  ): Promise<PaginatedSupplierPaymentsDto> {
    const where: Prisma.SupplierPaymentWhereInput = {
      orgId,
      ...(showDeleted ? {} : { deletedAt: null }),
    };
    if (status) where.status = status;
    if (purchaseOrderId) where.purchaseOrderId = purchaseOrderId;
    if (supplierId) {
      // cross-tenant guard: постачальник має належати цій org
      const cp = await this.prisma.counterparty.findFirst({
        where: { id: supplierId, orgId, deletedAt: null },
        select: { id: true },
      });
      if (!cp) throw new NotFoundException('Постачальника не знайдено');
      where.supplierId = supplierId;
    }
    if (q) {
      const like = q.trim();
      if (like.length > 0) {
        where.OR = [
          { number: { contains: like, mode: 'insensitive' } },
          {
            supplier: {
              OR: [
                { companyName: { contains: like, mode: 'insensitive' } },
                { lastName: { contains: like, mode: 'insensitive' } },
                { firstName: { contains: like, mode: 'insensitive' } },
              ],
            },
          },
        ];
      }
    }
    if (dateFrom || dateTo) {
      where.documentDate = {
        ...(dateFrom ? { gte: new Date(dateFrom) } : {}),
        ...(dateTo ? { lte: new Date(dateTo + 'T23:59:59.999Z') } : {}),
      };
    }

    // Невідоме поле → повний fallback на дефолт (createdAt desc), включно з напрямом
    // (garbage sortBy не повинен тихо міняти порядок). Whitelist-семантика у buildSortOrderBy.
    const { skip, take } = calculatePagination({ page, limit });
    const orderBy = buildSortOrderBy(SP_SORT_FIELDS, sortBy, sortDir);
    const [items, total] = await Promise.all([
      this.prisma.supplierPayment.findMany({
        where,
        skip,
        take,
        orderBy,
        include: {
          supplier: { select: { firstName: true, lastName: true, companyName: true } },
          bankAccount: { select: { name: true } },
          cashRegister: { select: { name: true } },
          purchaseOrder: { select: { number: true } },
        },
      }),
      this.prisma.supplierPayment.count({ where }),
    ]);

    return {
      items: items.map(item => this.toDto(item)),
      total,
      page,
      limit: take,
    };
  }

  /**
   * Графік оплат постачальникам — шахматка боргів по датах.
   *
   * АВТОРИТЕТНЕ джерело суми боргу — SettlementAccount.balance для АКТИВНИХ
   * (`deletedAt IS NULL`) counterparty ТИПУ `SUPPLIER` або `BOTH`: payable = max(0, −balance).
   * Балансовий борг враховує ВСІ рухи (PO-linked/unlinked платежі, повернення, коригування),
   * а не лише PO.
   *
   * **Розбіжність зі звітом «Взаєморозрахунки»** (Bug #600 documented trade-off):
   * `reports.settlements` НЕ фільтрує `deletedAt`/`type` — включає soft-deleted counterparty
   * і CLIENT-типу акаунти з від'ємним балансом. Тому:
   *   schedule.totals.total ≤ report.totalCredit
   * розбіжність = сума боргів deleted counterparty + boргів CLIENT-типу.
   *
   * Розподіл — FIFO: payable «наливається» на непогашені PO по черзі від найстарішого
   * (за paymentDate), кожен PO лягає у свою колонку за paymentDate:
   *   - null або < from            → overdue (протерміновані)
   *   - from..to (20-денне вікно)  → byDate[YYYY-MM-DD]
   *   - > to                        → planned (планові)
   * PO, до яких борг не дійшов, вважаються оплаченими (неприв'язаними платежами/поверненнями)
   * і не показуються. Залишок боргу понад суму відкритих PO (коригування без PO або взагалі
   * без PO) → overdue. Сума по рядку завжди = payable (= |balance|).
   *
   * Кредитний ліміт (максимум по PURCHASE-договорах постачальника) віднімається
   * від сумарного боргу з НАЙПІЗНІШИХ (planned → останні дати → overdue) — тобто
   * протерміновані зменшуються останніми. Якщо ліміт ≥ борг → постачальник пропускається.
   */
  async getSchedule(orgId: string, from: string, to: string): Promise<SupplierPaymentScheduleDto> {
    const { allocations } = await this.computeScheduleAllocations(orgId, from, to);

    // Список дат вікна (YYYY-MM-DD) для колонок.
    const fromDate = new Date(from + 'T00:00:00.000Z');
    const toDate = new Date(to + 'T23:59:59.999Z');
    const dates: string[] = [];
    for (let d = new Date(fromDate); d <= toDate; d.setUTCDate(d.getUTCDate() + 1)) {
      dates.push(d.toISOString().slice(0, 10));
    }

    // Агрегуємо per-PO алокації helper-а у бакети шахматки. Оскільки і тут, і у
    // getScheduleDocuments джерело — ОДИН computeScheduleAllocations, суми клітинок і
    // сума документів у панелі збігаються за конструкцією (немає sibling-drift).
    const rowBySupplier = new Map<
      string,
      { supplierName: string; overdue: number; planned: number; byDate: Record<string, number> }
    >();
    for (const a of allocations) {
      if (a.allocated <= 0.005) continue;
      let row = rowBySupplier.get(a.supplierId);
      if (!row) {
        row = { supplierName: a.supplierName, overdue: 0, planned: 0, byDate: {} };
        rowBySupplier.set(a.supplierId, row);
      }
      if (a.bucket === 'overdue') row.overdue += a.allocated;
      else if (a.bucket === 'planned') row.planned += a.allocated;
      else row.byDate[a.bucket] = (row.byDate[a.bucket] ?? 0) + a.allocated;
    }

    const suppliers = Array.from(rowBySupplier.entries())
      .map(([supplierId, r]) => {
        let byDateSum = 0;
        for (const d in r.byDate) byDateSum += r.byDate[d];
        return {
          supplierId,
          supplierName: r.supplierName,
          overdue: r.overdue,
          planned: r.planned,
          byDate: r.byDate,
          total: r.overdue + r.planned + byDateSum,
        };
      })
      .filter(r => r.total > 0.005)
      .sort((a, b) => b.total - a.total);

    // Підсумковий рядок: один прохід накопичує скалярні totals + суми по датах.
    const totalsByDate: Record<string, number> = {};
    let totalsOverdue = 0;
    let totalsPlanned = 0;
    let totalsGrand = 0;
    for (const r of suppliers) {
      totalsOverdue += r.overdue;
      totalsPlanned += r.planned;
      totalsGrand += r.total;
      for (const d in r.byDate) {
        totalsByDate[d] = (totalsByDate[d] ?? 0) + r.byDate[d];
      }
    }
    for (const d in totalsByDate) {
      if (!(totalsByDate[d] > 0)) delete totalsByDate[d];
    }
    const totals = {
      overdue: totalsOverdue,
      planned: totalsPlanned,
      byDate: totalsByDate,
      total: totalsGrand,
    };

    return { dates, suppliers, totals };
  }

  /**
   * Документи (PO), по яких виникає оплата у конкретній клітинці/бакеті шахматки.
   * Reused той самий computeScheduleAllocations → суми ТУТ збігаються з клітинками getSchedule.
   * `target`: конкретна дата byDate АБО бакет overdue/planned. `supplierId` опційний
   * (без нього — усі постачальники, для кліку по рядку «Разом»).
   */
  async getScheduleDocuments(
    orgId: string,
    from: string,
    to: string,
    target: { kind: 'date'; date: string } | { kind: 'overdue' } | { kind: 'planned' },
    supplierId?: string,
  ): Promise<
    Array<{
      poId: string;
      number: string;
      supplierId: string;
      supplierName: string;
      paymentDate: string | null;
      totalAmount: number;
      outstanding: number;
      allocated: number;
    }>
  > {
    const { allocations } = await this.computeScheduleAllocations(orgId, from, to, supplierId);
    const wantBucket = target.kind === 'date' ? target.date : target.kind;
    return allocations
      .filter(a => a.allocated > 0.005 && a.bucket === wantBucket)
      .map(a => ({
        poId: a.poId,
        number: a.number,
        supplierId: a.supplierId,
        supplierName: a.supplierName,
        paymentDate: a.paymentDate,
        totalAmount: a.totalAmount,
        outstanding: a.outstanding,
        allocated: a.allocated,
      }));
    // Порядок збережено з allocations (FIFO: paymentDate asc, nulls first).
  }

  /**
   * ЄДИНЕ ДЖЕРЕЛА ПРАВДИ для графіка оплат: FIFO-налив АВТОРИТЕТНОГО боргу
   * (SettlementAccount.balance) на непогашені RECEIVED/PARTIAL PO + кредит-ліміт,
   * зі збереженням per-PO алокацій. getSchedule сумує їх у бакети, getScheduleDocuments
   * фільтрує по цільовому бакету — тож панель документів завжди збігається з клітинками.
   */
  private async computeScheduleAllocations(
    orgId: string,
    from: string,
    to: string,
    supplierId?: string,
  ): Promise<{
    allocations: Array<{
      supplierId: string;
      supplierName: string;
      poId: string;
      number: string;
      paymentDate: string | null;
      totalAmount: number;
      outstanding: number;
      allocated: number;
      bucket: string; // 'overdue' | 'planned' | 'YYYY-MM-DD'
    }>;
  }> {
    // Cross-field guard: без цього from > to тихо перевертає bucket-логіку —
    // всі PO потрапляють у planned/overdue, вікно порожнє, користувач не розуміє чому.
    if (from > to) {
      throw new BadRequestException('Дата "від" не може бути пізнішою за дату "до"');
    }
    const fromDate = new Date(from + 'T00:00:00.000Z');
    const toDate = new Date(to + 'T23:59:59.999Z');
    // Кап на розмір вікна — 100 днів жорсткий upper bound (некоректний ввід роздув би відповідь).
    const windowDays = Math.round((toDate.getTime() - fromDate.getTime()) / 86_400_000);
    if (windowDays > 100) {
      throw new BadRequestException('Вікно графіка не може перевищувати 100 днів');
    }

    const [orders, payableAccounts, contracts] = await Promise.all([
      this.prisma.purchaseOrder.findMany({
        where: {
          orgId,
          deletedAt: null,
          status: { in: [PurchaseOrderStatus.RECEIVED, PurchaseOrderStatus.PARTIAL] },
          // Не показувати борги видалених постачальників (orphan-рядки у шахматці).
          supplier: { deletedAt: null },
          // Drill-down: звузити до одного постачальника (менше даних).
          ...(supplierId ? { supplierId } : {}),
        },
        select: {
          id: true,
          number: true,
          supplierId: true,
          totalAmount: true,
          paymentDate: true,
          supplier: { select: { firstName: true, lastName: true, companyName: true } },
          supplierPayments: {
            where: { deletedAt: null, status: SupplierPaymentStatus.CONFIRMED },
            select: { amount: true },
          },
        },
        // Детермінований порядок для take-cap: найстаріші (за датою оплати) першими.
        orderBy: [{ paymentDate: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }],
        take: 5000,
      }),
      // АВТОРИТЕТНА сума боргу — SettlementAccount з від'ємним балансом (ми винні
      // постачальнику). payable = −balance. Дзеркалить reports.settlements totalCredit
      // (для АКТИВНИХ counterparty типу SUPPLIER/BOTH — див. Bug #600 divergence).
      //
      // Bug #599 — type filter: без `type: { in: SUPPLIER|BOTH }` клієнт з prepayment refund
      // pending (balance<0 на CLIENT-акаунті) потрапляє у ГРАФІК ОПЛАТ ПОСТАЧАЛЬНИКУ як
      // рядок з CLIENT-іменем. Semantic contamination — schedule має відображати лише
      // тих, кому як постачальнику ми винні.
      this.prisma.settlementAccount.findMany({
        where: {
          orgId,
          balance: { lt: 0 },
          counterparty: { deletedAt: null, type: { in: ['SUPPLIER', 'BOTH'] } },
          ...(supplierId ? { counterpartyId: supplierId } : {}),
        },
        select: {
          counterpartyId: true,
          balance: true,
          counterparty: { select: { firstName: true, lastName: true, companyName: true } },
        },
        take: 5000,
      }),
      // Кредит-ліміт з АКТИВНИХ PURCHASE-договорів постачальника.
      this.prisma.counterpartyContract.findMany({
        where: {
          orgId,
          deletedAt: null,
          contractType: 'PURCHASE',
          creditLimit: { not: null },
          ...(supplierId ? { counterpartyId: supplierId } : {}),
        },
        select: { counterpartyId: true, creditLimit: true },
        take: 5000,
      }),
    ]);

    const payableBySupplier = new Map<string, { payable: number; name: string }>();
    for (const a of payableAccounts) {
      payableBySupplier.set(a.counterpartyId, {
        payable: -Number(a.balance),
        name:
          formatPersonName(
            a.counterparty.lastName,
            a.counterparty.firstName,
            a.counterparty.companyName,
          ) || '—',
      });
    }
    const limitBySupplier = new Map<string, number>();
    for (const c of contracts) {
      const lim = c.creditLimit != null ? Number(c.creditLimit) : 0;
      limitBySupplier.set(
        c.counterpartyId,
        Math.max(limitBySupplier.get(c.counterpartyId) ?? 0, lim),
      );
    }

    // Непогашені PO по постачальнику у FIFO-порядку (orders вже відсортовані).
    type OpenPo = {
      poId: string;
      number: string;
      outstanding: number;
      paymentDate: string | null;
    };
    const openPosBySupplier = new Map<string, OpenPo[]>();
    for (const po of orders) {
      if (!payableBySupplier.has(po.supplierId)) continue;
      const paid = po.supplierPayments.reduce((s, p) => s + Number(p.amount), 0);
      const outstanding = Number(po.totalAmount) - paid;
      if (outstanding <= 0) continue;
      const entry: OpenPo = {
        poId: po.id,
        number: po.number,
        outstanding,
        paymentDate: po.paymentDate ? po.paymentDate.toISOString().slice(0, 10) : null,
      };
      const list = openPosBySupplier.get(po.supplierId);
      if (list) list.push(entry);
      else openPosBySupplier.set(po.supplierId, [entry]);
    }

    // Бакет за датою оплати PO.
    const bucketOf = (pd: string | null): string =>
      pd == null || pd < from ? 'overdue' : pd <= to ? pd : 'planned';

    const allocations: Array<{
      supplierId: string;
      supplierName: string;
      poId: string;
      number: string;
      paymentDate: string | null;
      totalAmount: number;
      outstanding: number;
      allocated: number;
      bucket: string;
    }> = [];

    for (const [sid, { payable, name }] of payableBySupplier) {
      const pos = openPosBySupplier.get(sid) ?? [];

      // FIFO-налив АВТОРИТЕТНОГО боргу на PO від найстарішого. Зберігаємо allocated per-PO.
      let remaining = payable;
      const alloc: Array<{
        poId: string;
        number: string;
        paymentDate: string | null;
        totalAmount: number;
        outstanding: number;
        allocated: number;
        bucket: string;
      }> = [];
      for (const po of pos) {
        if (remaining <= 0.005) break;
        const take = Math.min(po.outstanding, remaining);
        remaining -= take;
        alloc.push({
          poId: po.poId,
          number: po.number,
          paymentDate: po.paymentDate,
          totalAmount: po.outstanding, // outstanding — те що реально до оплати
          outstanding: po.outstanding,
          allocated: take,
          bucket: bucketOf(po.paymentDate),
        });
      }
      // Борг понад суму відкритих PO (коригування/повернення без PO) → синтетичний overdue-рядок.
      if (remaining > 0.005) {
        alloc.push({
          poId: '',
          number: '— (борг без документа)',
          paymentDate: null,
          totalAmount: remaining,
          outstanding: remaining,
          allocated: remaining,
          bucket: 'overdue',
        });
      }

      // Кредит-ліміт зменшує allocated з найпізніших PO (planned → дати спадно → overdue),
      // ДЗЕРКАЛИТЬ порядок споживання у попередньому getSchedule (planned → byDate desc → overdue).
      let limit = limitBySupplier.get(sid) ?? 0;
      if (limit > 0) {
        const rank = (b: string): number => (b === 'planned' ? 2 : b === 'overdue' ? 0 : 1);
        // Спочатку planned, потім byDate спадно за датою, потім overdue.
        const order = [...alloc].sort((x, y) => {
          const rx = rank(x.bucket);
          const ry = rank(y.bucket);
          if (rx !== ry) return ry - rx; // planned(2) → byDate(1) → overdue(0)
          if (rx === 1) return x.bucket < y.bucket ? 1 : x.bucket > y.bucket ? -1 : 0; // дати спадно
          return 0;
        });
        for (const a of order) {
          if (limit <= 0) break;
          const eaten = Math.min(a.allocated, limit);
          a.allocated -= eaten;
          limit -= eaten;
        }
      }

      for (const a of alloc) {
        allocations.push({
          supplierId: sid,
          supplierName: name,
          poId: a.poId,
          number: a.number,
          paymentDate: a.paymentDate,
          totalAmount: a.totalAmount,
          outstanding: a.outstanding,
          allocated: a.allocated,
          bucket: a.bucket,
        });
      }
    }

    return { allocations };
  }

  async findOne(orgId: string, id: string): Promise<SupplierPaymentResponseDto> {
    const sp = await this.prisma.supplierPayment.findFirst({
      where: { id, orgId, deletedAt: null },
      include: {
        supplier: { select: { firstName: true, lastName: true, companyName: true } },
        bankAccount: { select: { name: true } },
        cashRegister: { select: { name: true } },
        purchaseOrder: { select: { number: true } },
      },
    });
    if (!sp) throw new NotFoundException('Оплату не знайдено');
    return this.toDto(sp);
  }

  async create(
    orgId: string,
    dto: CreateSupplierPaymentDto,
    userId?: string,
  ): Promise<SupplierPaymentResponseDto> {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    void userId;
    this.assertSourceConsistency(dto.sourceType, dto.bankAccountId, dto.cashRegisterId);

    // Паралельна валідація незалежних FK: постачальник + джерело коштів + PO.
    const [supplier, bankAccount, cashRegister, purchaseOrder] = await Promise.all([
      this.prisma.counterparty.findFirst({
        where: { id: dto.supplierId, orgId, deletedAt: null },
        select: { id: true, type: true },
      }),
      dto.bankAccountId
        ? this.prisma.bankAccount.findFirst({
            where: { id: dto.bankAccountId, orgId, deletedAt: null },
            select: { id: true },
          })
        : Promise.resolve(null),
      dto.cashRegisterId
        ? this.prisma.cashRegister.findFirst({
            where: { id: dto.cashRegisterId, orgId, deletedAt: null },
            select: { id: true },
          })
        : Promise.resolve(null),
      dto.purchaseOrderId
        ? this.prisma.purchaseOrder.findFirst({
            where: { id: dto.purchaseOrderId, orgId, deletedAt: null },
            select: { id: true, supplierId: true },
          })
        : Promise.resolve(null),
    ]);

    if (!supplier) throw new NotFoundException('Постачальника не знайдено');
    if (supplier.type === 'CLIENT') {
      throw new BadRequestException('Контрагент не є постачальником');
    }
    if (dto.bankAccountId && !bankAccount) {
      throw new NotFoundException('Банківський рахунок не знайдено');
    }
    if (dto.cashRegisterId && !cashRegister) {
      throw new NotFoundException('Касу не знайдено');
    }
    if (dto.purchaseOrderId) {
      if (!purchaseOrder) throw new NotFoundException('Замовлення постачальнику не знайдено');
      if (purchaseOrder.supplierId !== dto.supplierId) {
        throw new BadRequestException('Замовлення не належить вказаному постачальнику');
      }
    }

    const number = await this.docNumbers.next(orgId, 'SUPPLIER_PAYMENT');

    const sp = await this.prisma.supplierPayment.create({
      data: {
        orgId,
        supplierId: dto.supplierId,
        purchaseOrderId: dto.purchaseOrderId ?? null,
        sourceType: dto.sourceType,
        bankAccountId: dto.sourceType === PaymentSourceType.BANK_ACCOUNT ? dto.bankAccountId : null,
        cashRegisterId:
          dto.sourceType === PaymentSourceType.CASH_REGISTER ? dto.cashRegisterId : null,
        number,
        amount: dto.amount,
        method: dto.method,
        notes: dto.notes ?? null,
        documentDate: dto.documentDate ? new Date(dto.documentDate) : kyivToday(),
      },
      include: {
        supplier: { select: { firstName: true, lastName: true, companyName: true } },
        bankAccount: { select: { name: true } },
        cashRegister: { select: { name: true } },
        purchaseOrder: { select: { number: true } },
      },
    });

    return this.toDto(sp);
  }

  async update(
    orgId: string,
    id: string,
    dto: UpdateSupplierPaymentDto,
  ): Promise<SupplierPaymentResponseDto> {
    const sp = await this.prisma.supplierPayment.findFirst({
      where: { id, orgId, deletedAt: null },
      select: {
        id: true,
        status: true,
        supplierId: true,
        sourceType: true,
        bankAccountId: true,
        cashRegisterId: true,
        purchaseOrderId: true,
      },
    });
    if (!sp) throw new NotFoundException('Оплату не знайдено');
    if (sp.status !== SupplierPaymentStatus.DRAFT) {
      throw new BadRequestException('Редагування дозволено лише у статусі "Чернетка"');
    }

    const nextSupplierId = dto.supplierId ?? sp.supplierId;
    // Bug #588 — paired FK invariant: якщо supplier змінюється БЕЗ явного нового purchaseOrderId,
    // а існуючий PO належав старому постачальнику, автоматично чистимо `purchaseOrderId`.
    // Дзеркалить UX-логіку `SupplierPaymentCreateModal` (onSelect(supplier) → clear PO pair) —
    // без цього API-only client (Postman/sync/mobile) створює orphan cross-supplier linkage.
    const supplierChanged = dto.supplierId !== undefined && dto.supplierId !== sp.supplierId;
    const shouldClearOrphanPO =
      supplierChanged && dto.purchaseOrderId === undefined && sp.purchaseOrderId !== null;
    const nextSourceType = dto.sourceType ?? sp.sourceType;
    // Ефективні поля джерела після застосування патчу — валідуємо консистентність.
    const nextBankAccountId =
      dto.bankAccountId !== undefined ? dto.bankAccountId : sp.bankAccountId;
    const nextCashRegisterId =
      dto.cashRegisterId !== undefined ? dto.cashRegisterId : sp.cashRegisterId;
    this.assertSourceConsistency(
      nextSourceType,
      nextSourceType === PaymentSourceType.BANK_ACCOUNT
        ? (nextBankAccountId ?? undefined)
        : undefined,
      nextSourceType === PaymentSourceType.CASH_REGISTER
        ? (nextCashRegisterId ?? undefined)
        : undefined,
    );

    const [supplier, bankAccount, cashRegister, purchaseOrder] = await Promise.all([
      dto.supplierId
        ? this.prisma.counterparty.findFirst({
            where: { id: dto.supplierId, orgId, deletedAt: null },
            select: { id: true, type: true },
          })
        : Promise.resolve(null),
      nextSourceType === PaymentSourceType.BANK_ACCOUNT && nextBankAccountId
        ? this.prisma.bankAccount.findFirst({
            where: { id: nextBankAccountId, orgId, deletedAt: null },
            select: { id: true },
          })
        : Promise.resolve(null),
      nextSourceType === PaymentSourceType.CASH_REGISTER && nextCashRegisterId
        ? this.prisma.cashRegister.findFirst({
            where: { id: nextCashRegisterId, orgId, deletedAt: null },
            select: { id: true },
          })
        : Promise.resolve(null),
      dto.purchaseOrderId
        ? this.prisma.purchaseOrder.findFirst({
            where: { id: dto.purchaseOrderId, orgId, deletedAt: null },
            select: { id: true, supplierId: true },
          })
        : Promise.resolve(null),
    ]);

    if (dto.supplierId) {
      if (!supplier) throw new NotFoundException('Постачальника не знайдено');
      if (supplier.type === 'CLIENT')
        throw new BadRequestException('Контрагент не є постачальником');
    }
    if (nextSourceType === PaymentSourceType.BANK_ACCOUNT && nextBankAccountId && !bankAccount) {
      throw new NotFoundException('Банківський рахунок не знайдено');
    }
    if (nextSourceType === PaymentSourceType.CASH_REGISTER && nextCashRegisterId && !cashRegister) {
      throw new NotFoundException('Касу не знайдено');
    }
    if (dto.purchaseOrderId) {
      if (!purchaseOrder) throw new NotFoundException('Замовлення постачальнику не знайдено');
      if (purchaseOrder.supplierId !== nextSupplierId) {
        throw new BadRequestException('Замовлення не належить вказаному постачальнику');
      }
    }

    await this.prisma.supplierPayment.update({
      where: { id, orgId },
      data: {
        ...(dto.supplierId ? { supplierId: dto.supplierId } : {}),
        ...(dto.sourceType ? { sourceType: dto.sourceType } : {}),
        // Джерело перезаписуємо узгоджено з ефективним sourceType.
        bankAccountId:
          nextSourceType === PaymentSourceType.BANK_ACCOUNT ? (nextBankAccountId ?? null) : null,
        cashRegisterId:
          nextSourceType === PaymentSourceType.CASH_REGISTER ? (nextCashRegisterId ?? null) : null,
        ...(dto.purchaseOrderId !== undefined
          ? { purchaseOrderId: dto.purchaseOrderId || null }
          : shouldClearOrphanPO
            ? { purchaseOrderId: null }
            : {}),
        ...(dto.amount !== undefined ? { amount: dto.amount } : {}),
        ...(dto.method !== undefined ? { method: dto.method } : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
        ...(dto.documentDate ? { documentDate: new Date(dto.documentDate) } : {}),
      },
    });

    return this.findOne(orgId, id);
  }

  async confirm(orgId: string, id: string, userId: string): Promise<SupplierPaymentResponseDto> {
    const pre = await this.prisma.supplierPayment.findFirst({
      where: { id, orgId, deletedAt: null },
      select: { status: true, supplierId: true, amount: true },
    });
    if (!pre) throw new NotFoundException('Оплату не знайдено');

    const allowed = SP_TRANSITIONS[pre.status];
    if (!allowed.includes(SupplierPaymentStatus.CONFIRMED)) {
      throw new BadRequestException(`Неможливо провести оплату зі статусу "${pre.status}"`);
    }

    await this.prisma.$transaction(
      async tx => {
        // CAS DRAFT→CONFIRMED ПЕРШИМ (не stale-read!): два concurrent confirm() інакше обидва
        // проходять re-read і дають ПОДВІЙНИЙ SUPPLIER_PAYMENT (борг постачальнику ×2). Дзеркалить
        // stock-documents.transition / completion-acts.confirm. count===0 → інший уже провів.
        const cas = await tx.supplierPayment.updateMany({
          where: { id, orgId, deletedAt: null, status: SupplierPaymentStatus.DRAFT },
          data: { status: SupplierPaymentStatus.CONFIRMED },
        });
        if (cas.count === 0) {
          throw new BadRequestException(
            'Оплату вже проведено або статус змінився — оновіть сторінку',
          );
        }

        // Дані для settlement — з pre-tx знімка (amount/supplierId незмінні у DRAFT).
        // Оплата постачальнику: ми надсилаємо йому кошти → наш борг зменшується.
        // Семантика — SUPPLIER_PAYMENT (BALANCE_SIGN = +1, підіймає від'ємний борг до 0).
        // НЕ PAYMENT (−1) — той для клієнтської оплати (клієнт платить НАМ).
        await this.settlements.createTransaction(
          orgId,
          {
            counterpartyId: pre.supplierId,
            type: 'SUPPLIER_PAYMENT',
            amount: Number(pre.amount),
            documentType: 'SupplierPayment',
            documentId: id,
            createdBy: userId,
          },
          tx,
        );
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    );

    return this.findOne(orgId, id);
  }

  async cancel(orgId: string, id: string): Promise<SupplierPaymentResponseDto> {
    const sp = await this.prisma.supplierPayment.findFirst({
      where: { id, orgId, deletedAt: null },
      select: { id: true, status: true },
    });
    if (!sp) throw new NotFoundException('Оплату не знайдено');

    const allowed = SP_TRANSITIONS[sp.status];
    if (!allowed.includes(SupplierPaymentStatus.CANCELLED)) {
      throw new BadRequestException(`Неможливо скасувати оплату зі статусу "${sp.status}"`);
    }

    await this.prisma.supplierPayment.update({
      where: { id, orgId },
      data: { status: SupplierPaymentStatus.CANCELLED },
    });

    return this.findOne(orgId, id);
  }

  async remove(orgId: string, id: string): Promise<void> {
    const sp = await this.prisma.supplierPayment.findFirst({
      where: { id, orgId, deletedAt: null },
      select: { status: true },
    });
    if (!sp) throw new NotFoundException('Оплату не знайдено');
    if (sp.status === SupplierPaymentStatus.CONFIRMED) {
      throw new BadRequestException('Проведену оплату видалити неможливо');
    }

    await this.prisma.supplierPayment.update({
      where: { id, orgId },
      data: { deletedAt: new Date() },
    });
  }

  /**
   * Гарантує, що заповнене рівно одне джерело коштів відповідно до sourceType:
   * BANK_ACCOUNT → потрібен bankAccountId (без cashRegisterId);
   * CASH_REGISTER → потрібен cashRegisterId (без bankAccountId).
   */
  private assertSourceConsistency(
    sourceType: PaymentSourceType,
    bankAccountId?: string,
    cashRegisterId?: string,
  ): void {
    if (sourceType === PaymentSourceType.BANK_ACCOUNT) {
      if (!bankAccountId) {
        throw new BadRequestException('Для оплати з банку потрібно вказати банківський рахунок');
      }
      if (cashRegisterId) {
        throw new BadRequestException('Не можна одночасно вказувати банківський рахунок і касу');
      }
    } else {
      if (!cashRegisterId) {
        throw new BadRequestException('Для оплати з каси потрібно вказати касу');
      }
      if (bankAccountId) {
        throw new BadRequestException('Не можна одночасно вказувати банківський рахунок і касу');
      }
    }
  }

  private toDto(sp: {
    id: string;
    orgId: string;
    number: string;
    status: SupplierPaymentStatus;
    supplierId: string;
    sourceType: PaymentSourceType;
    bankAccountId: string | null;
    cashRegisterId: string | null;
    purchaseOrderId: string | null;
    amount: Prisma.Decimal | number;
    method: string;
    notes: string | null;
    documentDate: Date | null;
    createdAt: Date;
    updatedAt: Date;
    deletedAt?: Date | null;
    supplier?: {
      firstName: string | null;
      lastName: string | null;
      companyName: string | null;
    } | null;
    bankAccount?: { name: string } | null;
    cashRegister?: { name: string } | null;
    purchaseOrder?: { number: string } | null;
  }): SupplierPaymentResponseDto {
    const sup = sp.supplier;
    const supplierName =
      formatPersonName(sup?.lastName, sup?.firstName, sup?.companyName) || undefined;
    const sourceName =
      sp.sourceType === PaymentSourceType.BANK_ACCOUNT
        ? (sp.bankAccount?.name ?? null)
        : (sp.cashRegister?.name ?? null);
    return {
      id: sp.id,
      orgId: sp.orgId,
      number: sp.number,
      status: sp.status,
      supplierId: sp.supplierId,
      supplierName,
      sourceType: sp.sourceType,
      bankAccountId: sp.bankAccountId ?? null,
      cashRegisterId: sp.cashRegisterId ?? null,
      sourceName,
      purchaseOrderId: sp.purchaseOrderId ?? null,
      purchaseOrderNumber: sp.purchaseOrder?.number ?? null,
      amount: Number(sp.amount),
      method: sp.method,
      notes: sp.notes ?? null,
      documentDate: sp.documentDate ? sp.documentDate.toISOString().slice(0, 10) : null,
      createdAt: sp.createdAt instanceof Date ? sp.createdAt.toISOString() : sp.createdAt,
      updatedAt: sp.updatedAt instanceof Date ? sp.updatedAt.toISOString() : sp.updatedAt,
      deletedAt: sp.deletedAt instanceof Date ? sp.deletedAt.toISOString() : (sp.deletedAt ?? null),
    };
  }

  // ─── Linked Documents ──────────────────────────────────

  async getLinkedDocuments(orgId: string, spId: string) {
    // Preload щоб дістати FK (purchaseOrderId/supplierId/bankAccountId/cashRegisterId).
    // Не знайдено / чужий orgId → порожні секції без throw (дзеркало WorkOrdersService).
    const sp = await this.prisma.supplierPayment.findFirst({
      where: { id: spId, orgId, deletedAt: null },
      select: {
        purchaseOrderId: true,
        supplierId: true,
        bankAccountId: true,
        cashRegisterId: true,
      },
    });
    if (!sp) {
      return { purchaseOrder: [], counterparty: [], account: [] };
    }

    const [purchaseOrder, counterparty, bankAccount, cashRegister] = await Promise.all([
      sp.purchaseOrderId
        ? this.prisma.purchaseOrder.findFirst({
            where: { id: sp.purchaseOrderId, orgId, deletedAt: null },
            select: { id: true, number: true, status: true, totalAmount: true },
          })
        : Promise.resolve(null),
      this.prisma.counterparty.findFirst({
        where: { id: sp.supplierId, orgId, deletedAt: null },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          companyName: true,
          phone: true,
        },
      }),
      sp.bankAccountId
        ? this.prisma.bankAccount.findFirst({
            where: { id: sp.bankAccountId, orgId, deletedAt: null },
            select: { id: true, name: true },
          })
        : Promise.resolve(null),
      sp.cashRegisterId
        ? this.prisma.cashRegister.findFirst({
            where: { id: sp.cashRegisterId, orgId, deletedAt: null },
            select: { id: true, name: true },
          })
        : Promise.resolve(null),
    ]);

    // §13 API Contract: Prisma Decimal → number у DTO.
    const account = bankAccount
      ? [{ id: bankAccount.id, name: bankAccount.name, kind: 'bank' as const }]
      : cashRegister
        ? [{ id: cashRegister.id, name: cashRegister.name, kind: 'cash' as const }]
        : [];

    return {
      purchaseOrder: purchaseOrder
        ? [{ ...purchaseOrder, totalAmount: Number(purchaseOrder.totalAmount) }]
        : [],
      counterparty: counterparty ? [counterparty] : [],
      account,
    };
  }

  async getLinkedCounts(orgId: string, ids: string[]) {
    if (!ids.length) return {};

    // supplier завжди присутній (NOT NULL), account присутній якщо bank або cash заданий.
    const payments = await this.prisma.supplierPayment.findMany({
      where: { id: { in: ids }, orgId, deletedAt: null },
      select: {
        id: true,
        purchaseOrderId: true,
        supplierId: true,
        bankAccountId: true,
        cashRegisterId: true,
      },
    });

    // Bug #A: count має відповідати detail (getLinkedDocuments фільтрує deletedAt:null для
    // PO / контрагента / рахунку). Наявність FK ≠ наявність живого запису: постачальника,
    // банк-рахунок чи касу можна soft-delete-нути поки на них посилається проведена оплата.
    // Без live-перевірки badge показував би «1», а відповідна секція панелі — порожньо.
    const poIds = uniqueDefinedIds(payments.map(p => p.purchaseOrderId));
    const cpIds = uniqueDefinedIds(payments.map(p => p.supplierId));
    const bankIds = uniqueDefinedIds(payments.map(p => p.bankAccountId));
    const cashIds = uniqueDefinedIds(payments.map(p => p.cashRegisterId));
    const [livePo, liveCp, liveBank, liveCash] = await Promise.all([
      poIds.length
        ? this.prisma.purchaseOrder.findMany({
            where: { id: { in: poIds }, orgId, deletedAt: null },
            select: { id: true },
          })
        : Promise.resolve([]),
      cpIds.length
        ? this.prisma.counterparty.findMany({
            where: { id: { in: cpIds }, orgId, deletedAt: null },
            select: { id: true },
          })
        : Promise.resolve([]),
      bankIds.length
        ? this.prisma.bankAccount.findMany({
            where: { id: { in: bankIds }, orgId, deletedAt: null },
            select: { id: true },
          })
        : Promise.resolve([]),
      cashIds.length
        ? this.prisma.cashRegister.findMany({
            where: { id: { in: cashIds }, orgId, deletedAt: null },
            select: { id: true },
          })
        : Promise.resolve([]),
    ]);
    const livePoSet = new Set(livePo.map(x => x.id));
    const liveCpSet = new Set(liveCp.map(x => x.id));
    const liveBankSet = new Set(liveBank.map(x => x.id));
    const liveCashSet = new Set(liveCash.map(x => x.id));

    const result = initCountsMap(ids, ['purchaseOrder', 'counterparty', 'account'] as const);
    payments.forEach(sp => {
      const bucket = result[sp.id];
      if (!bucket) return;
      bucket.purchaseOrder = sp.purchaseOrderId && livePoSet.has(sp.purchaseOrderId) ? 1 : 0;
      bucket.counterparty = sp.supplierId && liveCpSet.has(sp.supplierId) ? 1 : 0;
      const accountLive =
        (sp.bankAccountId && liveBankSet.has(sp.bankAccountId)) ||
        (sp.cashRegisterId && liveCashSet.has(sp.cashRegisterId));
      bucket.account = accountLive ? 1 : 0;
    });
    return result;
  }
}
