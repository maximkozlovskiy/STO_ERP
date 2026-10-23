import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { Prisma, PurchaseOrderStatus } from '@prisma/client';

import { kyivToday, addDaysKyiv, dateOnlyRangeFilter } from '../../common/utils/kyiv-date';
import { assertFsmTransition } from '../../common/utils/fsm';
import { safeCoeff } from '../../common/utils/math';
import { money, moneyFromDecimal, sumMoney } from '../../common/utils/money';
import { calculatePagination, buildSortOrderBy } from '../../common/utils/pagination';
import { deduplicateBy } from '../../common/utils/array';
import { assertCounterpartyRole } from '../../common/utils/counterparty-role';
import { uniqueDefinedIds, initCountsMap } from '../../common/utils/linked-counts';
import { err } from '../../common/utils/err';
import { PrismaService } from '../../prisma/prisma.service';
import { formatPersonName, TRANSACTION_TIMEOUT_MS, MAX_QUERY_LIMIT } from '@sto/shared';
import { DocumentNumberService } from '../document-number/document-number.service';
import { InventoryService } from '../inventory/inventory.service';
import { SettlementsService } from '../settlements/settlements.service';
import { PricingService } from '../inventory/pricing.service';
import { SettingsService } from '../settings/settings.service';
import { ExchangeRatesService } from '../exchange-rates/exchange-rates.service';
import { DeliveryTrackingService } from './delivery/delivery-tracking.service';
import { PurchaseListLinkService } from '../purchase-lists/purchase-list-link.service';
import { PurchaseListReceiptService } from '../purchase-lists/purchase-list-receipt.service';
import { SupplierOrderOutboxService } from '../supplier-api/outbox/supplier-order-outbox.service';
import { calcLineVat } from '../../common/utils/vat';
import {
  CreatePurchaseOrderDto,
  UpdatePurchaseOrderDto,
  ReceivePurchaseOrderDto,
  PurchaseOrderResponseDto,
  PaginatedPurchaseOrdersDto,
} from './purchase-orders.dto';

type POStatus = PurchaseOrderStatus;

// Shared shape для всіх PO read paths (findOne/create/update) — попереджає drift
// (sto-review 2026-06-19): кожен новий scalar тут автоматично потрапляє у всі три
// response-и, без ручного дублювання у findOne/create/update include shapes.
const PO_LINE_GOOD_INCLUDE = {
  select: {
    name: true,
    internalCode: true,
    sku: true,
    unit: true,
    unitOfMeasure: { select: { shortName: true, coefficient: true } },
    brand: { select: { name: true } },
  },
} as const satisfies Prisma.GoodDefaultArgs;

// Толеранс для over-receipt guard (Bug #712): quantity/receivedQty — Float у схемі (дробові
// одиниці: літри/кг), тож пряме `>` дало б хибне 400 на IEEE-754-дрейфі (10 отримано за 2 прийоми
// по 3.33 = 9.99…). 1e-6 достатньо, щоб не пропустити реальний надлишок ≥0.001 (мін. крок кількості).
const RECEIVE_QTY_EPSILON = 1e-6;

export const PO_TRANSITIONS: Record<POStatus, POStatus[]> = {
  DRAFT: [PurchaseOrderStatus.ORDERED, PurchaseOrderStatus.CANCELLED],
  ORDERED: [
    PurchaseOrderStatus.PARTIAL,
    PurchaseOrderStatus.RECEIVED,
    PurchaseOrderStatus.CANCELLED,
  ],
  PARTIAL: [PurchaseOrderStatus.RECEIVED, PurchaseOrderStatus.CANCELLED],
  RECEIVED: [],
  CANCELLED: [],
};

// sto-optimize (cycle 3/3): sort-field whitelist hoisted from findAll body — static string-map,
// re-allocated on every list request under polling. Sibling to SP_SORT_FIELDS/INV_SORT_FIELDS/WO_SORT/SD_SORT_FIELDS.
const PO_SORT_FIELDS: Record<string, string> = {
  documentDate: 'documentDate',
  createdAt: 'createdAt',
  totalAmount: 'totalAmount',
  paymentDate: 'paymentDate',
};
// Bug #598 — nullable-fields: PurchaseOrder.paymentDate є nullable → без explicit
// `nulls: 'last'` DESC-sort виносить сотні PO з null paymentDate наверх (Postgres default).
// Set hoisted на module-level разом з whitelist — жодного повторного alloc на request.
const PO_NULLABLE_SORT_FIELDS: ReadonlySet<string> = new Set(['paymentDate']);

const PO_WRITE_INCLUDE = {
  supplier: { select: { firstName: true, lastName: true, companyName: true } },
  warehouse: { select: { name: true } },
  contract: { select: { id: true, number: true } },
  currency: { select: { code: true } },
  lines: {
    where: { deletedAt: null },
    take: 1000,
    include: { good: PO_LINE_GOOD_INCLUDE },
  },
} as const satisfies Prisma.PurchaseOrderInclude;

/**
 * Замовлення, готове до запису: перевірки, номер, ПДВ рядків і курс зроблено ДО транзакції
 * (`prepareCreate`), запис — `createInTx` у транзакції виклику. `create()` і замовлення зі списку
 * купівлі (BR-PL-008) ідуть тим самим шляхом (BR-PO-010).
 */
export interface PreparedPurchaseOrder {
  data: Prisma.PurchaseOrderUncheckedCreateInput;
  lines: Array<{
    goodId: string;
    quantity: number;
    price: number;
    vatRate: number;
    vatAmount: number;
  }>;
  trackingNumber: string | null;
}

@Injectable()
export class PurchaseOrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly settlements: SettlementsService,
    private readonly docNumbers: DocumentNumberService,
    private readonly pricingService: PricingService,
    private readonly settingsService: SettingsService,
    private readonly deliveryTracking: DeliveryTrackingService,
    private readonly exchangeRates: ExchangeRatesService,
    // BR-PO-009/010: позиції списків купівлі — хуки життєвого циклу й розподіл отриманого.
    private readonly purchaseLists: PurchaseListLinkService,
    private readonly purchaseListReceipt: PurchaseListReceiptService,
    // BR-PO-011/012: передача в API постачальника (outbox) і захист скасування відправленого.
    private readonly supplierOutbox: SupplierOrderOutboxService,
  ) {}

  /** Нормалізує введений номер накладної: trim, порожнє → null. */
  private normalizeTracking(raw: string | null | undefined): string | null {
    if (raw == null) return null;
    const t = raw.trim();
    return t === '' ? null : t;
  }

  /**
   * Tenant-guard: усі goodId рядків мусять належати org (Good.id глобально унікальний → інакше
   * cross-tenant FK-injection). Дзеркалить supplier-returns.validateLineRefs. Кидає 404 на чужий/
   * неіснуючий goodId ДО будь-якого запису.
   */
  private async validateLineGoodIds(
    orgId: string,
    lines: Array<{ goodId: string }>,
  ): Promise<void> {
    if (!lines.length) return;
    const goodIds = Array.from(new Set(lines.map(l => l.goodId)));
    const goods = await this.prisma.good.findMany({
      where: { id: { in: goodIds }, orgId, deletedAt: null },
      select: { id: true },
    });
    if (goods.length !== goodIds.length) {
      const found = new Set(goods.map(g => g.id));
      const missing = goodIds.find(gid => !found.has(gid));
      throw new NotFoundException(
        err('err.purchaseOrder.goodNotFound', { missing: String(missing) }),
      );
    }
  }

  /**
   * Delivery-поля PurchaseOrder за нормалізованим ЕН. Непорожній ЕН → трекінг стартує (PENDING);
   * null → трекінг скинуто. Єдине джерело набору полів для create і update (без дублювання).
   */
  private trackingFields(ttn: string | null): {
    trackingNumber: string | null;
    deliveryStatus: import('@prisma/client').DeliveryStatus | null;
    deliveryStatusRaw: null;
    deliveryStatusUpdatedAt: Date | null;
  } {
    return {
      trackingNumber: ttn,
      deliveryStatus: ttn ? 'PENDING' : null,
      deliveryStatusRaw: null,
      deliveryStatusUpdatedAt: ttn ? new Date() : null,
    };
  }

  async findAll(
    orgId: string,
    page = 1,
    limit = 20,
    status?: string,
    q?: string,
    showDeleted = false,
    dateFrom?: string,
    dateTo?: string,
    sortBy?: string,
    sortDir?: 'asc' | 'desc',
    supplierId?: string,
  ): Promise<PaginatedPurchaseOrdersDto> {
    const where: Prisma.PurchaseOrderWhereInput = {
      orgId,
      ...(showDeleted ? {} : { deletedAt: null }),
    };
    if (status) where.status = status as POStatus;
    if (supplierId) where.supplierId = supplierId;
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
    // documentDate - date without time (@db.Date): bounds are calendar dates, no timezone shift.
    const documentDate = dateOnlyRangeFilter(dateFrom, dateTo);
    if (documentDate) where.documentDate = documentDate;

    const { skip, take } = calculatePagination({ page, limit });
    const orderBy = buildSortOrderBy(
      PO_SORT_FIELDS,
      sortBy,
      sortDir,
      'createdAt',
      PO_NULLABLE_SORT_FIELDS,
    );
    const [items, total] = await Promise.all([
      this.prisma.purchaseOrder.findMany({
        where,
        skip,
        take,
        orderBy,
        // Lines omitted from list — loaded on demand via findOne (avoids 1000 rows × 20 POs).
        // contract included so list shows contractNumber (toDto maps it).
        include: {
          supplier: { select: { firstName: true, lastName: true, companyName: true } },
          warehouse: { select: { name: true } },
          contract: { select: { id: true, number: true } },
          currency: { select: { code: true } },
          _count: { select: { lines: { where: { deletedAt: null } } } },
        },
      }),
      this.prisma.purchaseOrder.count({ where }),
    ]);

    // Payables FX (Фаза 5): paidAmount тепер персистентний на PO (інкрементується у
    // supplier-payments.confirm) → outstanding рахується у toDto прямо з po.paidAmount. Раніше був
    // groupBy CONFIRMED SupplierPayment на кожну сторінку — тепер −1 запит.
    return {
      items: items.map(item => this.toDto(item)),
      total,
      page,
      limit: take,
    };
  }

  /**
   * BR-WO-012: `withDeleted` знімає фільтр `deletedAt: null` (orgId лишається) — лише для
   * перегляду документа, позначеного на видалення. Прапорець передає ТІЛЬКИ маршрут `GET :id`;
   * усі внутрішні виклики йдуть без нього й бачать лише невидалені.
   */
  async findOne(
    orgId: string,
    id: string,
    opts: { withDeleted?: boolean } = {},
  ): Promise<PurchaseOrderResponseDto> {
    const po = await this.prisma.purchaseOrder.findFirst({
      where: { id, orgId, ...(opts.withDeleted === true ? {} : { deletedAt: null }) },
      include: {
        supplier: { select: { firstName: true, lastName: true, companyName: true } },
        warehouse: { select: { name: true } },
        contract: { select: { id: true, number: true } },
        currency: { select: { code: true } },
        lines: {
          where: { deletedAt: null },
          include: { good: PO_LINE_GOOD_INCLUDE },
          take: 1000,
        },
      },
    });
    if (!po) throw new NotFoundException(err('err.purchaseOrder.notFound'));
    return this.toDto(po);
  }

  async create(orgId: string, dto: CreatePurchaseOrderDto): Promise<PurchaseOrderResponseDto> {
    const prepared = await this.prepareCreate(orgId, dto);
    const po = await this.prisma.$transaction(tx => this.createInTx(tx, orgId, prepared), {
      timeout: TRANSACTION_TIMEOUT_MS,
    });
    // ЕН вказано при створенні → запускаємо опитування статусу доставки (offline-safe .catch усередині).
    if (prepared.trackingNumber) await this.deliveryTracking.enqueueInitial(orgId, po.id);
    return this.toDto(po);
  }

  /**
   * Перевірки й розрахунки нового замовлення ДО транзакції: постачальник (BR-CP-001), склад,
   * договір, товари рядків організації, номер (DocumentNumberService відкриває власну транзакцію),
   * ПДВ рядків, курс. Записує результат `createInTx`.
   */
  async prepareCreate(orgId: string, dto: CreatePurchaseOrderDto): Promise<PreparedPurchaseOrder> {
    // sto-optimize: tier-merger Promise.all — supplier+warehouse guards паралельні з
    // contract resolution. Раніше contract auto-pick/validate йшов sequential ПІСЛЯ Promise.all,
    // додаючи 1 RTT навіть коли FK guards проходили миттєво. Auto-pick предикат
    // (counterpartyId=dto.supplierId) відомий синхронно з DTO, не потребує результату
    // supplier guard. NotFound/order повідомлень не страждає — всі awaits завершуються
    // ДО throw-блоків, помилки кидаються у тому самому порядку.
    const hasContractId = !!dto.contractId;
    const [supplier, warehouse, contract] = await Promise.all([
      this.prisma.counterparty.findFirst({
        where: { id: dto.supplierId, orgId, deletedAt: null },
        select: { id: true, type: true },
      }),
      this.prisma.warehouse.findFirst({
        where: { id: dto.warehouseId, orgId, deletedAt: null },
        select: { id: true },
      }),
      hasContractId
        ? this.prisma.counterpartyContract.findFirst({
            where: {
              id: dto.contractId as string,
              orgId,
              counterpartyId: dto.supplierId,
              contractType: 'PURCHASE',
              deletedAt: null,
            },
            select: { id: true },
          })
        : this.prisma.counterpartyContract.findFirst({
            where: {
              counterpartyId: dto.supplierId,
              orgId,
              contractType: 'PURCHASE',
              deletedAt: null,
            },
            orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
            select: { id: true },
          }),
    ]);
    if (!supplier) throw new NotFoundException(err('err.purchaseOrder.supplierNotFound'));
    assertCounterpartyRole(supplier.type, 'supplier'); // BR-CP-001
    if (!warehouse) throw new NotFoundException(err('err.purchaseOrder.warehouseNotFound'));
    if (hasContractId && !contract)
      throw new NotFoundException(err('err.purchaseOrder.contractNotFound'));
    const contractId: string | null = hasContractId
      ? (contract as { id: string }).id
      : (contract?.id ?? null);

    const lines = dto.lines ?? [];
    // Tenant-guard goodId рядків (pre-prod audit): Good.id глобально унікальний → без цієї
    // перевірки org A може підсунути goodId org B → на receive createMovement пише рух проти
    // чужого товару (cross-tenant stock-ledger). Дзеркалить supplier-returns.validateLineRefs.
    await this.validateLineGoodIds(orgId, lines);

    const number = await this.docNumbers.next(orgId, 'PURCHASE_ORDER');
    const createTracking = this.normalizeTracking(dto.trackingNumber);

    const { vatMode, vatRate } = await this.settingsService.getDefaultVatRate(orgId);
    const computedLines = lines.map(l => {
      const { vatAmount } = calcLineVat(l.price, l.quantity, vatRate, vatMode);
      return { ...l, vatRate, vatAmount };
    });
    // Bug #777: total = Σ(per-line money(q×price)), а НЕ money(Σ raw). toDto показує
    // бухгалтеру per-line amount = money(q×price); при дробовій кількості (quantity — Float)
    // покрокове округлення рядків розходиться з round-once сумою → документ не б'ється
    // (рядки 5.01, total 5.00). Σ вже-округлених рядків гарантує Σ(lines.amount) === total.
    const totalAmount = sumMoney(computedLines.map(l => money(l.quantity * l.price)));
    const totalVat = sumMoney(computedLines.map(l => l.vatAmount));

    // Мультивалюта (Фаза 3): валюта замовлення — з DTO або базова org; base-сума тоталу по курсу
    // на дату документа (fallbackToLatest — документний потік).
    const documentDate = dto.documentDate ? new Date(dto.documentDate) : kyivToday();
    const currencyId = dto.currencyId ?? (await this.exchangeRates.requireBaseCurrencyId(orgId));
    const conv = currencyId
      ? await this.exchangeRates.resolveBaseConversion(
          orgId,
          currencyId,
          documentDate,
          totalAmount,
          true,
        )
      : { rateUsed: 1, amountBase: totalAmount };

    return {
      data: {
        orgId,
        supplierId: dto.supplierId,
        warehouseId: dto.warehouseId,
        contractId,
        number,
        notes: dto.notes,
        totalAmount,
        totalVat,
        currencyId,
        totalAmountBase: conv.amountBase,
        rateUsed: conv.rateUsed,
        documentDate,
        paymentDate: dto.paymentDate ? new Date(dto.paymentDate) : null,
        // Доставка: якщо ЕН вказано при створенні — статус PENDING, далі опитуємо НП.
        ...this.trackingFields(createTracking),
      },
      lines: computedLines.map(l => ({
        goodId: l.goodId,
        quantity: l.quantity,
        price: l.price,
        vatRate: l.vatRate,
        vatAmount: l.vatAmount,
      })),
      trackingNumber: createTracking,
    };
  }

  /**
   * Запис підготовленого замовлення (`prepareCreate`) у транзакції виклику, без перечитування:
   * виклику, якому треба лише `id`/`number` (замовлення зі списку купівлі, BR-PL-008).
   */
  async insertInTx(
    tx: Prisma.TransactionClient,
    orgId: string,
    prepared: PreparedPurchaseOrder,
  ): Promise<{ id: string; number: string }> {
    const created = await tx.purchaseOrder.create({
      data: prepared.data,
      select: { id: true, number: true },
    });
    if (prepared.lines.length) {
      await tx.purchaseOrderLine.createMany({
        data: prepared.lines.map(l => ({ orgId, purchaseOrderId: created.id, ...l })),
      });
    }
    return created;
  }

  /** Запис підготовленого замовлення (`insertInTx`) і перечитування у формі відповіді. */
  async createInTx(tx: Prisma.TransactionClient, orgId: string, prepared: PreparedPurchaseOrder) {
    const created = await this.insertInTx(tx, orgId, prepared);
    return tx.purchaseOrder.findFirstOrThrow({
      where: { id: created.id, orgId, deletedAt: null },
      include: PO_WRITE_INCLUDE,
    });
  }

  async update(
    orgId: string,
    id: string,
    dto: UpdatePurchaseOrderDto,
  ): Promise<PurchaseOrderResponseDto> {
    // sto-optimize: narrow projection — потрібен лише status (guard) + totalAmount (fallback
    // коли dto.lines не передано) + supplierId (щоб обчислити effectiveSupplierId для
    // contractId-валідації і виявити зміну постачальника, що потребує очищення стейл-контракту).
    const po = await this.prisma.purchaseOrder.findFirst({
      where: { id, orgId, deletedAt: null },
      select: {
        status: true,
        totalAmount: true,
        supplierId: true,
        contractId: true,
        trackingNumber: true,
        // Мультивалюта (Фаза 3): валюта + дата для перерахунку base при зміні тоталу.
        currencyId: true,
        documentDate: true,
        // BR-PL-009: зміна складу чернетки відв'язує позиції списків купівлі іншого складу.
        warehouseId: true,
      },
    });
    if (!po) throw new NotFoundException(err('err.purchaseOrder.notFound'));
    if (po.status !== PurchaseOrderStatus.DRAFT)
      throw new BadRequestException(err('err.purchaseOrder.onlyDraftEditable'));

    // Доставка: обробляємо ЕН лише коли клієнт явно надіслав поле (undefined → не чіпати).
    //  - непорожній новий ЕН (змінився)  → deliveryStatus=PENDING + запустити опитування;
    //  - порожній/null                    → скинути ЕН і статус (poll-guard зупинить job);
    //  - той самий ЕН                     → нічого не міняти (не рестартувати трекінг).
    let trackingUpdate: Record<string, unknown> = {};
    let enqueueTracking = false;
    if (dto.trackingNumber !== undefined) {
      const next = this.normalizeTracking(dto.trackingNumber);
      if (next !== po.trackingNumber) {
        trackingUpdate = this.trackingFields(next);
        enqueueTracking = next !== null; // новий/змінений непорожній ЕН → запускаємо опитування
      }
    }

    // sto-optimize: всі 3 FK guards незалежні (supplier, warehouse, contract) — кожна
    // лише для NotFoundException-перевірки. Раніше sequential — кожен await блокував
    // наступний. Тепер Promise.all з тернарками — економить до 2 RTT при повному
    // оновленні форми (supplier+warehouse+contract разом). Bug review §1.2.
    //
    // Contract resolution:
    //   1. Client explicit contractId (string)  → validate against effective supplier
    //   2. Client explicit null/empty           → clear contractId
    //   3. Supplier changed and client silent   → auto-clear stale contract (would point
    //      to old supplier, creating cross-supplier orphan reference)
    //   4. Otherwise                            → keep existing (Prisma `undefined`)
    const supplierChanged = dto.supplierId !== undefined && dto.supplierId !== po.supplierId;
    const effectiveSupplierId = dto.supplierId ?? po.supplierId;
    const shouldValidateContract = !!dto.contractId;

    const [supplier, warehouse, contract] = await Promise.all([
      dto.supplierId
        ? this.prisma.counterparty.findFirst({
            where: { id: dto.supplierId, orgId, deletedAt: null },
            select: { id: true, type: true },
          })
        : Promise.resolve(null),
      dto.warehouseId
        ? this.prisma.warehouse.findFirst({
            where: { id: dto.warehouseId, orgId, deletedAt: null },
            select: { id: true },
          })
        : Promise.resolve(null),
      shouldValidateContract
        ? this.prisma.counterpartyContract.findFirst({
            where: {
              id: dto.contractId as string,
              orgId,
              counterpartyId: effectiveSupplierId,
              contractType: 'PURCHASE',
              deletedAt: null,
            },
            select: { id: true },
          })
        : Promise.resolve(null),
    ]);

    if (dto.supplierId && !supplier)
      throw new NotFoundException(err('err.purchaseOrder.supplierNotFound'));
    // BR-CP-001: only when the supplier actually changes - a legacy PO stays editable.
    if (supplier && supplierChanged) assertCounterpartyRole(supplier.type, 'supplier');
    if (dto.warehouseId && !warehouse)
      throw new NotFoundException(err('err.purchaseOrder.warehouseNotFound'));
    if (shouldValidateContract && !contract)
      throw new NotFoundException(err('err.purchaseOrder.contractNotFound'));

    const newContractId: string | null | undefined =
      shouldValidateContract && contract
        ? contract.id
        : dto.contractId === null || (supplierChanged && po.contractId)
          ? null
          : undefined;

    const lines = dto.lines;
    // Tenant-guard goodId рядків (pre-prod audit) — див. коментар у create().
    if (lines) await this.validateLineGoodIds(orgId, lines);
    const { vatMode, vatRate } = await this.settingsService.getDefaultVatRate(orgId);
    const computedLines = lines?.map(l => {
      const { vatAmount } = calcLineVat(l.price, l.quantity, vatRate, vatMode);
      return { ...l, vatRate, vatAmount };
    });
    // Bug #777: Σ(per-line money(q×price)) — див. create. Рядки мусять битись із total.
    const totalAmount = computedLines
      ? sumMoney(computedLines.map(l => money(l.quantity * l.price)))
      : moneyFromDecimal(po.totalAmount);
    const totalVat = computedLines ? sumMoney(computedLines.map(l => l.vatAmount)) : undefined;

    // Мультивалюта (Фаза 3): перераховуємо base якщо змінився тотал (нові lines) АБО
    // валюта документа (dto.currencyId !== наявної po.currencyId) — інакше totalAmountBase
    // лишався б порахованим по СТАРІЙ валюті після зміни лише валюти без рядків.
    // ЕФЕКТИВНА валюта — dto.currencyId якщо клієнт міняє її у цьому ж PATCH, інакше наявна.
    const effectiveDate = dto.documentDate ? new Date(dto.documentDate) : po.documentDate;
    const effectiveCurrencyId = dto.currencyId === undefined ? po.currencyId : dto.currencyId;
    const currencyChanged = dto.currencyId !== undefined && dto.currencyId !== po.currencyId;
    const needsRecalc = !!computedLines || currencyChanged;
    const conv = needsRecalc
      ? effectiveCurrencyId
        ? await this.exchangeRates.resolveBaseConversion(
            orgId,
            effectiveCurrencyId,
            effectiveDate ?? new Date(),
            totalAmount,
            true,
          )
        : { rateUsed: 1, amountBase: totalAmount }
      : null;

    const updated = await this.prisma.$transaction(
      async tx => {
        if (computedLines !== undefined) {
          await tx.purchaseOrderLine.updateMany({
            where: { purchaseOrderId: id, orgId },
            data: { deletedAt: new Date() },
          });
          if (computedLines.length) {
            await tx.purchaseOrderLine.createMany({
              data: computedLines.map(l => ({
                orgId,
                purchaseOrderId: id,
                goodId: l.goodId,
                quantity: l.quantity,
                price: l.price,
                vatRate: l.vatRate,
                vatAmount: l.vatAmount,
                ...(l.pricedSalePrice != null ? { pricedSalePrice: l.pricedSalePrice } : {}),
              })),
            });
          }
        }
        // BR-PL-009: рядки чернетки переписано чи змінено склад — позиції списків купівлі
        // звіряються за товаром і складом. До запису самого замовлення: порядок блокувань
        // «позиції → замовлення» той самий, що в прийманні, скасуванні й видаленні.
        const warehouseChanged = !!dto.warehouseId && dto.warehouseId !== po.warehouseId;
        if (computedLines !== undefined || warehouseChanged) {
          await this.purchaseLists.reconcileDraftOrder(
            tx,
            orgId,
            id,
            dto.warehouseId ?? po.warehouseId ?? undefined,
          );
        }
        return tx.purchaseOrder.update({
          where: { id, orgId },
          data: {
            supplierId: dto.supplierId ?? undefined,
            warehouseId: dto.warehouseId ?? undefined,
            contractId: newContractId,
            notes: dto.notes,
            totalAmount,
            // Мультивалюта (TD1): currencyId NOT NULL — не дозволяємо занулити (лише зміна валюти).
            currencyId: dto.currencyId ?? undefined,
            ...(totalVat !== undefined ? { totalVat } : {}),
            ...(conv ? { totalAmountBase: conv.amountBase, rateUsed: conv.rateUsed } : {}),
            documentDate: dto.documentDate ? new Date(dto.documentDate) : undefined,
            ...(dto.paymentDate !== undefined
              ? { paymentDate: dto.paymentDate ? new Date(dto.paymentDate) : null }
              : {}),
            ...trackingUpdate,
          },
          include: {
            supplier: { select: { firstName: true, lastName: true, companyName: true } },
            warehouse: { select: { name: true } },
            contract: { select: { id: true, number: true } },
            currency: { select: { code: true } },
            lines: {
              where: { deletedAt: null },
              take: 1000,
              include: { good: PO_LINE_GOOD_INCLUDE },
            },
          },
        });
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    );

    // Новий/змінений ЕН → запускаємо опитування статусу доставки (offline-safe усередині).
    if (enqueueTracking) await this.deliveryTracking.enqueueInitial(orgId, id);

    return this.toDto(updated);
  }

  async transition(
    orgId: string,
    id: string,
    newStatus: POStatus,
    opts: { force?: boolean } = {},
  ): Promise<PurchaseOrderResponseDto> {
    const queuedForApi = await this.prisma.$transaction(
      async tx => {
        // sto-optimize: status-only projection — assertFsmTransition потребує лише поточний статус.
        const po = await tx.purchaseOrder.findFirst({
          where: { id, orgId, deletedAt: null },
          select: { status: true },
        });
        if (!po) throw new NotFoundException(err('err.purchaseOrder.notFound'));

        assertFsmTransition(PO_TRANSITIONS, po.status, newStatus);

        // BR-PL-010: скасоване замовлення повертає неотримане в позиції списків купівлі. Позиції —
        // ДО рядка замовлення: приймання блокує позиції (розподіл) раніше за замовлення (статус),
        // і зворотний порядок тут давав би deadlock паралельних «Прийняти» і «Скасувати».
        if (newStatus === PurchaseOrderStatus.CANCELLED) {
          // BR-PO-012: замовлення, вже передане постачальнику через API, — лише з force.
          await this.supplierOutbox.assertCancellable(tx, orgId, id, opts.force === true);
          await this.purchaseLists.onOrderClosed(tx, orgId, id);
        }
        // BR-PL-012 (Bug #885): замовлення закрито кнопкою «Отримано» (постачальник більше не
        // привезе) — остача позицій повертається в OPEN так само, як при повному прийманні.
        // Інакше позиції лишались ORDERED на закритому замовленні, а нестача рахувала їхнє
        // недоотримане покриттям.
        if (newStatus === PurchaseOrderStatus.RECEIVED) {
          await this.purchaseLists.onOrderClosed(tx, orgId, id);
        }
        await tx.purchaseOrder.update({ where: { id, orgId }, data: { status: newStatus } });
        // BR-PO-011 / BR-SCON-009: режим «автоматично при «Замовлено»» — outbox у цій же транзакції.
        return newStatus === PurchaseOrderStatus.ORDERED
          ? this.supplierOutbox.onOrderedInTx(tx, orgId, id)
          : false;
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    );
    if (queuedForApi) this.supplierOutbox.afterCommit(orgId, id);
    return this.findOne(orgId, id);
  }

  async receive(
    orgId: string,
    id: string,
    dto: ReceivePurchaseOrderDto,
    userId?: string,
  ): Promise<PurchaseOrderResponseDto> {
    const po = await this.prisma.purchaseOrder.findFirst({
      where: { id, orgId, deletedAt: null },
      include: {
        lines: {
          where: { deletedAt: null },
          take: 1000,
          include: { good: { select: { unitId: true } } },
        },
        // Для авто-обчислення дати оплати (RECEIVED): дата + днів відтермінування договору.
        // deletedAt потрібен щоб уникнути «freeze» відтермінування з архівного договору.
        contract: { select: { paymentDeferDays: true, deletedAt: true } },
      },
    });
    if (!po) throw new NotFoundException(err('err.purchaseOrder.notFound'));
    if (po.status !== PurchaseOrderStatus.ORDERED && po.status !== PurchaseOrderStatus.PARTIAL) {
      throw new BadRequestException(err('err.purchaseOrder.receiveOnlyOrderedOrPartial'));
    }

    // §2.2 Tenant isolation: validate that any unitOfMeasureId override the caller passed
    // belongs to the same orgId (FK alone does not enforce tenant boundaries because UoM
    // model has its own orgId and Prisma FK has no composite (orgId, id) constraint).
    const overrideUomIds = Array.from(
      new Set(
        dto.lines
          .map(l => l.unitOfMeasureId)
          .filter((v): v is string => typeof v === 'string' && v.length > 0),
      ),
    );
    let allowedUomIds: Set<string> = new Set();
    if (overrideUomIds.length) {
      const allowed = await this.prisma.unitOfMeasure.findMany({
        where: { orgId, id: { in: overrideUomIds }, deletedAt: null },
        select: { id: true },
        // Safety cap — bounded by overrideUomIds (PO lines) but cap protects
        // against OOM if a PO ever has >1000 lines with override UoMs.
        take: MAX_QUERY_LIMIT,
      });
      allowedUomIds = new Set(allowed.map(u => u.id));
      const missing = overrideUomIds.filter(id => !allowedUomIds.has(id));
      if (missing.length) {
        throw new BadRequestException(err('err.purchaseOrder.unitNotFoundInOrg'));
      }
    }

    // Dedupe protection on lineId: without this, two recv entries with the same lineId produce
    // double `increment` — Promise.all runs both updates even inside one tx, both accumulate.
    const seen = new Set<string>();
    for (const recv of dto.lines) {
      if (seen.has(recv.lineId)) {
        throw new BadRequestException(err('err.purchaseOrder.receiveLineMustBeUnique'));
      }
      seen.add(recv.lineId);
    }

    const lineById = new Map(po.lines.map(l => [l.id, l]));
    // BR-PO-001: `lineId`, якого немає серед активних рядків ЦЬОГО замовлення (чужий, видалений,
    // вигаданий), — 400 до будь-якого запису. Раніше такий рядок мовчки відкидався з відповіддю 200:
    // комірник бачив «прийнято», а товар не надходив і борг не виникав.
    if (dto.lines.some(recv => !lineById.has(recv.lineId))) {
      throw new BadRequestException(err('err.purchaseOrder.receiveLineNotFound'));
    }

    // sto-optimize: всі лінії незалежні (різні lineId/goodId rows) — паралелимо.
    // Всередині лінії: createMovement і lineUpdate пишуть у різні таблиці → теж паралельно.
    // NB: Prisma всередині $transaction виконує DB-операції послідовно (один pinned connection),
    // тож Promise.all дає лише JS-overhead-economy. receivedAmount акумулюємо через map → reduce
    // (уникаємо shared mutable у async callbacks).
    //
    // sto-optimize (2026-08-30): bucket-by-id Map замість Array.find() у циклі →
    // O(N+M) замість O(N×M). Помітно на PO з 100+ ліній (10_000 порівнянь → 200).
    const activeLines = dto.lines
      .map(recv => ({ recv, line: lineById.get(recv.lineId) }))
      .filter(
        (x): x is { recv: (typeof dto.lines)[0]; line: NonNullable<typeof x.line> } =>
          !!x.line && x.recv.receivedQty > 0,
      );

    // Bug #712 — over-receipt guard (документований інваріант дос'є purchase-order.md §100:
    // «receivedQty не може перевищити line.quantity»). DTO має лише @Min(0), а CAS нижче
    // (updateMany where receivedQty=<очікуване>) захищає ЛИШЕ від concurrent-подвоєння, НЕ від
    // надлишкового прийому одним викликом. Без цього прийом 100 на замовлені 10 проходить →
    // RECEIPT-рух +100 у склад + SUPPLIER_CHARGE ×100·price (роздутий борг постачальнику), а
    // allReceived (receivedQty>=quantity) хибно flip-ає у RECEIVED. Fail-fast 400 до $transaction.
    // QTY_EPSILON — толеранс дробових одиниць (літри/кг) від IEEE-754-дрейфу.
    for (const { recv, line } of activeLines) {
      if (line.receivedQty + recv.receivedQty > line.quantity + RECEIVE_QTY_EPSILON) {
        // remaining — КІЛЬКІСТЬ (літри/кг), не гроші: money() тут був би семантично
        // неправильним (MP-B13). Значення йде лише у текст помилки, тож округлюємо
        // до 2 знаків суто для читабельності.
        const remaining = Math.round(Math.max(0, line.quantity - line.receivedQty) * 100) / 100;
        throw new BadRequestException(
          err('err.purchaseOrder.receiveExceedsLineRemaining', {
            quantity: line.quantity,
            received: line.receivedQty,
            remaining,
          }),
        );
      }
    }

    // money(): receivedAmount живить SUPPLIER_CHARGE (борг постачальнику) — грошовий
    // результат перед createTransaction має бути квантований до копійки (не float-дрейф).
    const receivedAmount = money(
      activeLines.reduce(
        (sum, { recv, line }) => sum + recv.receivedQty * moneyFromDecimal(line.price),
        0,
      ),
    );

    await this.prisma.$transaction(
      async tx => {
        // CAS per-line (не просто stale-read!): без цього два concurrent receive() з однаковим
        // payload обидва проходять і дають ПОДВІЙНИЙ SUPPLIER_CHARGE (борг постачальнику ×2) +
        // подвійне оприбуткування (Σ-інваріант зростає). Re-read статусу — лише fast-fail на 4xx;
        // атомарність дає updateMany з очікуваним receivedQty у where (PO підтримує ЧАСТКОВІ
        // прийоми, тож CAS на статусі як у stock-doc не підходить — CAS на дельту рядка).
        const fresh = await tx.purchaseOrder.findFirst({
          where: { id, orgId, deletedAt: null },
          select: { status: true },
        });
        if (!fresh) throw new NotFoundException(err('err.purchaseOrder.notFound'));
        if (fresh.status !== po.status) {
          throw new BadRequestException(
            err('err.purchaseOrder.statusChangedRetry', {
              status: fresh.status,
            }),
          );
        }

        // КРОК 0 — BR-PL-011: наряди, під які резервуватиметься отримане, блокуються ДО змін
        // залишку — порядок блокувань «наряд → склад», як у переходах наряду.
        await this.purchaseListReceipt.lockCandidateWorkOrders(
          tx,
          orgId,
          id,
          activeLines.map(({ line }) => line.goodId),
        );

        // КРОК 1 — CAS-оновлення рядків ПЕРШИМ (до руху залишків/боргу). updateMany where
        // receivedQty=<очікуване> — конкурентний дубль уже змінив receivedQty → count=0 → throw
        // → rollback ДО createMovement/SUPPLIER_CHARGE (жодного подвоєння). Послідовно, щоб при
        // count=0 не лишити orphan RECEIPT-руху.
        for (const { recv, line } of activeLines) {
          const resolvedUomId =
            (recv.unitOfMeasureId && allowedUomIds.has(recv.unitOfMeasureId)
              ? recv.unitOfMeasureId
              : null) ??
            line.good?.unitId ??
            null;
          const shouldUpdateLineUom = line.receivedQty === 0 || !!recv.unitOfMeasureId;
          const casResult = await tx.purchaseOrderLine.updateMany({
            where: { id: recv.lineId, orgId, receivedQty: line.receivedQty },
            data: {
              receivedQty: { increment: recv.receivedQty },
              ...(shouldUpdateLineUom ? { unitOfMeasureId: resolvedUomId } : {}),
            },
          });
          if (casResult.count === 0) {
            throw new BadRequestException(err('err.purchaseOrder.receiveAlreadyProcessed'));
          }
        }

        // КРОК 2 — рух залишків (RECEIPT) після успішного CAS усіх рядків. Різні (goodId,
        // warehouse) rows → незалежні, паралелимо (Prisma серіалізує у tx, але економія JS).
        await Promise.all(
          activeLines.map(({ recv, line }) => {
            const resolvedUomId =
              (recv.unitOfMeasureId && allowedUomIds.has(recv.unitOfMeasureId)
                ? recv.unitOfMeasureId
                : null) ??
              line.good?.unitId ??
              null;
            return this.inventory.createMovement(
              orgId,
              {
                goodId: line.goodId,
                warehouseId: po.warehouseId,
                type: 'RECEIPT',
                quantity: recv.receivedQty,
                price: Number(line.price),
                documentType: 'PurchaseOrder',
                documentId: id,
                // BR-PO-009: партія прив'язана до рядка замовлення.
                purchaseOrderLineId: line.id,
                createdBy: userId,
                unitOfMeasureId: resolvedUomId,
              },
              tx,
            );
          }),
        );

        // BR-PL-011: отримане розподіляється між позиціями списків купівлі й резервується під
        // їхні наряди — після RECEIPT (залишок уже на складі) і до боргу постачальнику.
        await this.purchaseListReceipt.allocateOnReceipt(
          tx,
          orgId,
          { id, warehouseId: po.warehouseId },
          activeLines.map(({ recv, line }) => ({
            goodId: line.goodId,
            quantity: recv.receivedQty,
          })),
          userId,
        );

        if (receivedAmount > 0) {
          await this.settlements.createTransaction(
            orgId,
            {
              counterpartyId: po.supplierId,
              // SUPPLIER_CHARGE (−1): отримали товар → МИ винні постачальнику (balance↓).
              // НЕ CHARGE — той дає +1 (клієнтська семантика «нам винні»).
              type: 'SUPPLIER_CHARGE',
              amount: receivedAmount,
              // Мультивалюта (Фаза 3): борг постачальнику у base по курсу на дату ПРИЙОМУ (кожен
              // частковий прийом — свій курс на свою дату; FX-різниці поза scope). Без валюти → base.
              currencyId: po.currencyId ?? undefined,
              date: kyivToday(),
              fallbackToLatest: true,
              documentType: 'PurchaseOrder',
              documentId: id,
              createdBy: userId,
            },
            tx,
          );
        }

        const updatedLines = await tx.purchaseOrderLine.findMany({
          where: { purchaseOrderId: id, orgId, deletedAt: null },
          take: 1000,
        });
        const allReceived = updatedLines.every(l => l.receivedQty >= l.quantity);
        const anyReceived = updatedLines.some(l => l.receivedQty > 0);
        const newStatus = allReceived
          ? PurchaseOrderStatus.RECEIVED
          : anyReceived
            ? PurchaseOrderStatus.PARTIAL
            : po.status;

        // Авто-заповнення планової дати оплати при повному отриманні (RECEIVED),
        // якщо поле ще порожнє і АКТИВНИЙ (не soft-deleted) договір має відтермінування:
        // paymentDate = сьогодні + paymentDeferDays. Ручне значення не перезаписуємо.
        // Prisma не фільтрує relation include за deletedAt автоматично → перевіряємо явно,
        // інакше «фризимо» відтермінування з архівного договору.
        const defer =
          po.contract && po.contract.deletedAt == null ? po.contract.paymentDeferDays : null;
        const shouldSetPaymentDate =
          newStatus === PurchaseOrderStatus.RECEIVED && !po.paymentDate && defer != null;
        await tx.purchaseOrder.update({
          where: { id, orgId },
          data: {
            status: newStatus,
            ...(shouldSetPaymentDate ? { paymentDate: addDaysKyiv(kyivToday(), defer) } : {}),
          },
        });
        // BR-PL-012: замовлення прийнято повністю — недоотримане за позиціями повертається в OPEN.
        if (newStatus === PurchaseOrderStatus.RECEIVED) {
          await this.purchaseLists.onOrderClosed(tx, orgId, id);
        }
      },
      { timeout: 30_000 }, // large PO (hundreds of lines) × createMovement with batch tracking
    );
    return this.findOne(orgId, id);
  }

  async remove(orgId: string, id: string, force = false): Promise<void> {
    // Narrow tenant guard — потрібен лише `status` для DRAFT check.
    const po = await this.prisma.purchaseOrder.findFirst({
      where: { id, orgId, deletedAt: null },
      select: { status: true },
    });
    if (!po) throw new NotFoundException(err('err.purchaseOrder.notFound'));
    if (po.status !== PurchaseOrderStatus.DRAFT)
      throw new BadRequestException(err('err.purchaseOrder.onlyDraftDeletable'));
    // Race-safe updateMany з повним compound where (id+orgId+deletedAt:null) і статусом DRAFT.
    // BR-PL-010: у тій самій транзакції позиції списків купівлі повертаються в OPEN.
    await this.prisma.$transaction(
      async tx => {
        // Позиції — до рядка замовлення (порядок блокувань той самий, що в update і transition);
        // замовлення вже не DRAFT → CAS нижче кидає, і повернення позицій відкочується.
        await this.supplierOutbox.assertCancellable(tx, orgId, id, force);
        await this.purchaseLists.onOrderClosed(tx, orgId, id);
        const res = await tx.purchaseOrder.updateMany({
          where: { id, orgId, deletedAt: null, status: PurchaseOrderStatus.DRAFT },
          data: { deletedAt: new Date() },
        });
        if (res.count === 0) {
          throw new BadRequestException(err('err.purchaseOrder.onlyDraftDeletable'));
        }
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    );
  }

  async applyPricing(
    orgId: string,
    poId: string,
    ruleId?: string,
  ): Promise<{
    updated: number;
    details: {
      goodId: string;
      goodName: string;
      costPrice: number;
      oldSalePrice: number;
      newSalePrice: number;
    }[];
  }> {
    // Perf: select narrow projection for pricing — Brand record entirely unused (only brandId
    // scalar read), Good's heavy columns (description, barcodes, customFields) likewise unused.
    const po = await this.prisma.purchaseOrder.findFirst({
      where: { id: poId, orgId, deletedAt: null },
      select: {
        id: true,
        number: true,
        status: true,
        supplierId: true,
        lines: {
          where: { deletedAt: null },
          select: {
            id: true,
            goodId: true,
            price: true,
            good: {
              select: {
                id: true,
                name: true,
                salePrice: true,
                category: true,
                goodCategoryId: true,
                goodType: true,
                brandId: true,
              },
            },
          },
        },
      },
    });
    if (!po) throw new NotFoundException(err('err.purchaseOrder.notFound'));
    // Defense-in-depth: розцінювати можна лише отримані товари (UI рендерить кнопку
    // тільки для RECEIVED/PARTIAL, але клієнт міг бути обійдений)
    if (po.status !== PurchaseOrderStatus.RECEIVED && po.status !== PurchaseOrderStatus.PARTIAL) {
      throw new BadRequestException(err('err.purchaseOrder.priceOnlyReceived'));
    }

    // Prefetch active rules once to avoid N+1 (each line previously fetched rules in a loop
    // and called a separate $transaction without timeout).
    const pricingCtx = await this.pricingService.getPricingContext(
      orgId,
      po.lines.map(l => l.goodId),
      ruleId ? { onlyRuleId: ruleId } : {},
    );

    type Plan = {
      lineId: string;
      goodId: string;
      goodName: string;
      costPrice: number;
      oldSalePrice: number;
      newSalePrice: number;
      ruleName: string | null;
    };
    const plan: Plan[] = [];

    for (const line of po.lines) {
      if (!line.good) continue;
      const costPrice = Number(line.price);
      const oldSalePrice = Number(line.good.salePrice);
      const { price: newSalePrice, ruleName } = this.pricingService.resolveRule(
        pricingCtx,
        line.good,
        costPrice,
        po.supplierId ?? undefined,
      );
      // Bug #832: обране правило розцінює лише СВОЇ рядки. Рядок поза його областю (товар не у
      // списку правила, інший бренд чи категорія; правило вимкнене) лишається як був — інакше
      // «немає правила → ціна = собівартість» мовчки знімало б націнку з решти товарів закупівлі.
      if (ruleId && ruleName === null) continue;
      plan.push({
        lineId: line.id,
        goodId: line.goodId,
        goodName: line.good.name,
        costPrice,
        oldSalePrice,
        newSalePrice,
        ruleName,
      });
    }

    if (plan.length === 0) return { updated: 0, details: [] };

    // Deduplicate by goodId for Good.salePrice update (last-write-wins for duplicate goodId rows).
    const dedupedPlan = deduplicateBy(
      plan.filter(u => Math.abs(u.newSalePrice - u.oldSalePrice) >= 0.001),
      u => u.goodId,
    );

    const CHUNK = 100;

    if (dedupedPlan.length > 0) {
      for (let i = 0; i < dedupedPlan.length; i += CHUNK) {
        const chunk = dedupedPlan.slice(i, i + CHUNK);
        await this.prisma.$transaction(
          async tx => {
            await Promise.all(
              chunk.map(u =>
                tx.good.updateMany({
                  where: { id: u.goodId, orgId, deletedAt: null },
                  data: { salePrice: u.newSalePrice },
                }),
              ),
            );
            await tx.priceHistory.createMany({
              data: chunk.map(u => ({
                orgId,
                goodId: u.goodId,
                oldPrice: u.oldSalePrice,
                newPrice: u.newSalePrice,
                costPrice: u.costPrice,
                reason: `PO pricing: ${po.number}`,
              })),
            });
          },
          { timeout: 10_000 },
        );
      }
    }

    for (let i = 0; i < plan.length; i += CHUNK) {
      const chunk = plan.slice(i, i + CHUNK);
      await this.prisma.$transaction(
        async tx => {
          await Promise.all(
            chunk.map(u =>
              tx.purchaseOrderLine.update({
                where: { id: u.lineId, orgId },
                data: { pricedSalePrice: u.newSalePrice, pricingRuleName: u.ruleName },
              }),
            ),
          );
        },
        { timeout: 10_000 },
      );
    }

    await this.prisma.purchaseOrder.updateMany({
      where: { id: poId, orgId },
      data: { pricedAt: new Date() },
    });

    return { updated: plan.filter(u => u.ruleName !== null).length, details: plan };
  }

  private toDto(po: {
    id: string;
    orgId: string;
    number: string;
    status: PurchaseOrderStatus;
    supplierId: string;
    warehouseId: string;
    contractId?: string | null;
    totalAmount: import('@prisma/client').Prisma.Decimal;
    totalVat?: import('@prisma/client').Prisma.Decimal | null;
    currencyId?: string | null;
    totalAmountBase?: import('@prisma/client').Prisma.Decimal | null;
    rateUsed?: import('@prisma/client').Prisma.Decimal | null;
    currency?: { code: string } | null;
    paidAmount?: import('@prisma/client').Prisma.Decimal | null;
    paidAt?: Date | null;
    notes: string | null;
    documentDate?: Date | null;
    paymentDate?: Date | null;
    pricedAt?: Date | null;
    trackingNumber?: string | null;
    deliveryStatus?: import('@prisma/client').DeliveryStatus | null;
    deliveryStatusRaw?: string | null;
    deliveryStatusUpdatedAt?: Date | null;
    createdAt: Date;
    updatedAt: Date;
    deletedAt?: Date | null;
    supplier: {
      firstName: string | null;
      lastName: string | null;
      companyName: string | null;
    } | null;
    warehouse: { name: string } | null;
    contract?: { id: string; number: string } | null;
    lines?: Array<{
      id: string;
      goodId: string;
      quantity: number;
      price: import('@prisma/client').Prisma.Decimal;
      vatRate?: import('@prisma/client').Prisma.Decimal | null;
      vatAmount?: import('@prisma/client').Prisma.Decimal | null;
      receivedQty: number;
      pricedSalePrice?: import('@prisma/client').Prisma.Decimal | null;
      pricingRuleName?: string | null;
      unitOfMeasureId?: string | null;
      good: {
        name: string;
        internalCode?: string | null;
        sku: string | null;
        unit: string;
        unitOfMeasure: { shortName: string; coefficient: number } | null;
        brand?: { name: string } | null;
      } | null;
    }>;
    _count?: { lines: number };
  }): PurchaseOrderResponseDto {
    const sup = po.supplier;
    const supplierName =
      formatPersonName(sup?.lastName, sup?.firstName, sup?.companyName) || undefined;
    return {
      id: po.id,
      orgId: po.orgId,
      number: po.number,
      status: po.status,
      supplierId: po.supplierId,
      supplierName,
      warehouseId: po.warehouseId,
      warehouseName: po.warehouse?.name,
      contractId: po.contractId ?? null,
      contractNumber: po.contract?.number ?? null,
      totalAmount: Number(po.totalAmount),
      totalVat: Number(po.totalVat ?? 0),
      currencyId: po.currencyId ?? null,
      currencyCode: po.currency?.code ?? null,
      totalAmountBase: po.totalAmountBase != null ? Number(po.totalAmountBase) : null,
      rateUsed: po.rateUsed != null ? Number(po.rateUsed) : null,
      // Payables (Фаза 5): сплачено/залишок/повністю сплачено (у валюті PO).
      paidAmount: po.paidAmount != null ? Number(po.paidAmount) : 0,
      outstanding: Math.max(0, Number(po.totalAmount) - Number(po.paidAmount ?? 0)),
      isFullyPaid: po.paidAt != null,
      paidAt: po.paidAt ? po.paidAt.toISOString().slice(0, 10) : null,
      notes: po.notes ?? null,
      documentDate: po.documentDate ? po.documentDate.toISOString().slice(0, 10) : null,
      paymentDate: po.paymentDate ? po.paymentDate.toISOString().slice(0, 10) : null,
      pricedAt: po.pricedAt instanceof Date ? po.pricedAt.toISOString() : (po.pricedAt ?? null),
      trackingNumber: po.trackingNumber ?? null,
      deliveryStatus: po.deliveryStatus ?? null,
      deliveryStatusRaw: po.deliveryStatusRaw ?? null,
      deliveryStatusUpdatedAt: po.deliveryStatusUpdatedAt
        ? po.deliveryStatusUpdatedAt.toISOString()
        : null,
      linesCount: po._count?.lines ?? po.lines?.length ?? 0,
      deletedAt: po.deletedAt instanceof Date ? po.deletedAt.toISOString() : (po.deletedAt ?? null),
      lines: (po.lines ?? []).map(l => ({
        id: l.id,
        goodId: l.goodId,
        goodName: l.good?.name,
        goodSku: l.good?.sku ?? null,
        goodInternalCode: l.good?.internalCode ?? null,
        goodBrandName: l.good?.brand?.name ?? null,
        unit: l.good?.unit,
        unitShortName: l.good?.unitOfMeasure?.shortName ?? l.good?.unit,
        // safeCoeff() catches legacy/seed coefficient=0/NaN/negative — множник display↔base (qty_base = qty * coefficient).
        coefficient: safeCoeff(l.good?.unitOfMeasure?.coefficient),
        quantity: l.quantity,
        price: Number(l.price),
        // обчислення (qty × price), а не читання збереженої колонки → бренд за MP-B13
        amount: money(l.quantity * moneyFromDecimal(l.price)),
        vatRate: Number(l.vatRate ?? 0),
        vatAmount: Number(l.vatAmount ?? 0),
        receivedQty: l.receivedQty,
        pricedSalePrice: l.pricedSalePrice != null ? Number(l.pricedSalePrice) : null,
        pricingRuleName: l.pricingRuleName ?? null,
        unitOfMeasureId: l.unitOfMeasureId ?? null,
      })),
      createdAt: po.createdAt instanceof Date ? po.createdAt.toISOString() : po.createdAt,
      updatedAt: po.updatedAt instanceof Date ? po.updatedAt.toISOString() : po.updatedAt,
    };
  }

  // ─── Linked Documents ──────────────────────────────────

  async getLinkedDocuments(orgId: string, poId: string) {
    // Preload щоб дістати supplierId (для секції counterparty). Не знайдено /
    // чужий orgId → порожні секції без throw (дзеркало WorkOrdersService).
    const po = await this.prisma.purchaseOrder.findFirst({
      where: { id: poId, orgId, deletedAt: null },
      select: { supplierId: true },
    });
    if (!po) {
      return { supplierPayments: [], counterparty: [], purchaseLists: [] };
    }

    // §3.2/§7.1: take: N — захист від OOM при патологічних обсягах.
    const TAKE = 500;
    const [supplierPayments, counterparty, listItems] = await Promise.all([
      this.prisma.supplierPayment.findMany({
        where: { purchaseOrderId: poId, orgId, deletedAt: null },
        select: {
          id: true,
          number: true,
          amount: true,
          method: true,
          status: true,
          documentDate: true,
        },
        orderBy: { createdAt: 'desc' },
        take: TAKE,
      }),
      this.prisma.counterparty.findFirst({
        where: { id: po.supplierId, orgId, deletedAt: null },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          companyName: true,
          phone: true,
        },
      }),
      // Списки купівлі, з позицій яких створено замовлення (BR-PL-008).
      this.prisma.purchaseListItem.findMany({
        where: { purchaseOrderId: poId, orgId, deletedAt: null, list: { deletedAt: null } },
        select: { list: { select: { id: true, number: true, status: true, createdAt: true } } },
        orderBy: { createdAt: 'desc' },
        take: TAKE,
      }),
    ]);

    // §13 API Contract: Prisma Decimal → number у DTO.
    return {
      supplierPayments: supplierPayments.map(sp => ({ ...sp, amount: Number(sp.amount) })),
      counterparty: counterparty ? [counterparty] : [],
      purchaseLists: Array.from(new Map(listItems.map(i => [i.list.id, i.list])).values()),
    };
  }

  async getLinkedCounts(orgId: string, ids: string[]) {
    if (!ids.length) return {};

    const [supplierPayments, orders, listItems] = await Promise.all([
      this.prisma.supplierPayment.groupBy({
        by: ['purchaseOrderId'],
        where: { purchaseOrderId: { in: ids }, orgId, deletedAt: null },
        _count: { id: true },
      }),
      // supplier присутність: 1 findMany на всі id (PO завжди має supplierId → 1).
      this.prisma.purchaseOrder.findMany({
        where: { id: { in: ids }, orgId, deletedAt: null },
        select: { id: true, supplierId: true },
      }),
      this.prisma.purchaseListItem.groupBy({
        by: ['purchaseOrderId', 'listId'],
        where: { purchaseOrderId: { in: ids }, orgId, deletedAt: null, list: { deletedAt: null } },
      }),
    ]);

    // Bug #A: count має відповідати detail. Постачальника можна soft-delete-нути поки
    // на нього посилається RECEIVED-замовлення (delete-guard блокує лише незакриті PO).
    // Без перевірки живого контрагента badge показував би «1», а панель — порожньо.
    const supplierIds = uniqueDefinedIds(orders.map(o => o.supplierId));
    const liveSuppliers = supplierIds.length
      ? await this.prisma.counterparty.findMany({
          where: { id: { in: supplierIds }, orgId, deletedAt: null },
          select: { id: true },
        })
      : [];
    const liveSupplierSet = new Set(liveSuppliers.map(c => c.id));

    const result = initCountsMap(ids, [
      'supplierPayments',
      'counterparty',
      'purchaseLists',
    ] as const);
    supplierPayments.forEach(r => {
      if (r.purchaseOrderId && result[r.purchaseOrderId]) {
        result[r.purchaseOrderId].supplierPayments = r._count.id;
      }
    });
    orders.forEach(po => {
      if (result[po.id]) {
        result[po.id].counterparty = po.supplierId && liveSupplierSet.has(po.supplierId) ? 1 : 0;
      }
    });
    listItems.forEach(r => {
      if (r.purchaseOrderId && result[r.purchaseOrderId])
        result[r.purchaseOrderId].purchaseLists += 1;
    });
    return result;
  }
}
