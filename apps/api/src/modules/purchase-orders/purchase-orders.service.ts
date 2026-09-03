import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { Prisma, PurchaseOrderStatus } from '@prisma/client';

import { kyivToday, addDaysKyiv } from '../../common/utils/kyiv-date';
import { assertFsmTransition } from '../../common/utils/fsm';
import { safeCoeff } from '../../common/utils/math';
import { calculatePagination, buildSortOrderBy } from '../../common/utils/pagination';
import { deduplicateBy } from '../../common/utils/array';
import { PrismaService } from '../../prisma/prisma.service';
import { formatPersonName, TRANSACTION_TIMEOUT_MS, MAX_QUERY_LIMIT } from '@sto/shared';
import { DocumentNumberService } from '../document-number/document-number.service';
import { InventoryService } from '../inventory/inventory.service';
import { SettlementsService } from '../settlements/settlements.service';
import { PricingService } from '../inventory/pricing.service';
import { SettingsService } from '../settings/settings.service';
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

const PO_TRANSITIONS: Record<POStatus, POStatus[]> = {
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

@Injectable()
export class PurchaseOrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly settlements: SettlementsService,
    private readonly docNumbers: DocumentNumberService,
    private readonly pricingService: PricingService,
    private readonly settingsService: SettingsService,
  ) {}

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
  ): Promise<PaginatedPurchaseOrdersDto> {
    const where: Prisma.PurchaseOrderWhereInput = {
      orgId,
      ...(showDeleted ? {} : { deletedAt: null }),
    };
    if (status) where.status = status as POStatus;
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
          _count: { select: { lines: { where: { deletedAt: null } } } },
        },
      }),
      this.prisma.purchaseOrder.count({ where }),
    ]);

    // outstanding по PO поточної сторінки: totalAmount − Σ CONFIRMED SupplierPayment.
    // Один groupBy на сторінку (≤200 PO) — для бейджа «Днів до оплати» у списку купівлі
    // (показується лише де є реальний залишок боргу). Патерн-еталон — getSchedule.
    const poIds = items.map(i => i.id);
    const paidByPo = new Map<string, number>();
    if (poIds.length > 0) {
      const grouped = await this.prisma.supplierPayment.groupBy({
        by: ['purchaseOrderId'],
        where: {
          orgId,
          deletedAt: null,
          status: 'CONFIRMED',
          purchaseOrderId: { in: poIds },
        },
        _sum: { amount: true },
      });
      for (const g of grouped) {
        if (g.purchaseOrderId) paidByPo.set(g.purchaseOrderId, Number(g._sum.amount ?? 0));
      }
    }

    return {
      items: items.map(item => {
        const dto = this.toDto(item as Parameters<typeof this.toDto>[0]);
        dto.outstanding = Math.max(0, dto.totalAmount - (paidByPo.get(item.id) ?? 0));
        return dto;
      }),
      total,
      page,
      limit: take,
    };
  }

  async findOne(orgId: string, id: string): Promise<PurchaseOrderResponseDto> {
    const po = await this.prisma.purchaseOrder.findFirst({
      where: { id, orgId, deletedAt: null },
      include: {
        supplier: { select: { firstName: true, lastName: true, companyName: true } },
        warehouse: { select: { name: true } },
        contract: { select: { id: true, number: true } },
        lines: {
          where: { deletedAt: null },
          include: { good: PO_LINE_GOOD_INCLUDE },
          take: 1000,
        },
      },
    });
    if (!po) throw new NotFoundException('Замовлення не знайдено');
    return this.toDto(po);
  }

  async create(orgId: string, dto: CreatePurchaseOrderDto): Promise<PurchaseOrderResponseDto> {
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
        select: { id: true },
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
    if (!supplier) throw new NotFoundException('Постачальника не знайдено');
    if (!warehouse) throw new NotFoundException('Склад не знайдено');
    if (hasContractId && !contract) throw new NotFoundException('Договір не знайдено');
    const contractId: string | null = hasContractId
      ? (contract as { id: string }).id
      : (contract?.id ?? null);

    const number = await this.docNumbers.next(orgId, 'PURCHASE_ORDER');

    const lines = dto.lines ?? [];
    const { vatMode, vatRate } = await this.settingsService.getDefaultVatRate(orgId);
    const computedLines = lines.map(l => {
      const { vatAmount } = calcLineVat(l.price, l.quantity, vatRate, vatMode);
      return { ...l, vatRate, vatAmount };
    });
    const totalAmount = computedLines.reduce((s, l) => s + l.quantity * l.price, 0);
    const totalVat = computedLines.reduce((s, l) => s + l.vatAmount, 0);

    const po = await this.prisma.$transaction(
      async tx => {
        const created = await tx.purchaseOrder.create({
          data: {
            orgId,
            supplierId: dto.supplierId,
            warehouseId: dto.warehouseId,
            contractId,
            number,
            notes: dto.notes,
            totalAmount,
            totalVat,
            documentDate: dto.documentDate ? new Date(dto.documentDate) : kyivToday(),
            paymentDate: dto.paymentDate ? new Date(dto.paymentDate) : null,
          },
        });
        if (computedLines.length) {
          await tx.purchaseOrderLine.createMany({
            data: computedLines.map(l => ({
              orgId,
              purchaseOrderId: created.id,
              goodId: l.goodId,
              quantity: l.quantity,
              price: l.price,
              vatRate: l.vatRate,
              vatAmount: l.vatAmount,
            })),
          });
        }
        return tx.purchaseOrder.findFirstOrThrow({
          where: { id: created.id, orgId, deletedAt: null },
          include: {
            supplier: { select: { firstName: true, lastName: true, companyName: true } },
            warehouse: { select: { name: true } },
            contract: { select: { id: true, number: true } },
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

    return this.toDto(po);
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
      select: { status: true, totalAmount: true, supplierId: true, contractId: true },
    });
    if (!po) throw new NotFoundException('Замовлення не знайдено');
    if (po.status !== PurchaseOrderStatus.DRAFT)
      throw new BadRequestException('Редагувати можна лише чернетку');

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
            select: { id: true },
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

    if (dto.supplierId && !supplier) throw new NotFoundException('Постачальника не знайдено');
    if (dto.warehouseId && !warehouse) throw new NotFoundException('Склад не знайдено');
    if (shouldValidateContract && !contract) throw new NotFoundException('Договір не знайдено');

    const newContractId: string | null | undefined =
      shouldValidateContract && contract
        ? contract.id
        : dto.contractId === null || (supplierChanged && po.contractId)
          ? null
          : undefined;

    const lines = dto.lines;
    const { vatMode, vatRate } = await this.settingsService.getDefaultVatRate(orgId);
    const computedLines = lines?.map(l => {
      const { vatAmount } = calcLineVat(l.price, l.quantity, vatRate, vatMode);
      return { ...l, vatRate, vatAmount };
    });
    const totalAmount = computedLines
      ? computedLines.reduce((s, l) => s + l.quantity * l.price, 0)
      : Number(po.totalAmount);
    const totalVat = computedLines ? computedLines.reduce((s, l) => s + l.vatAmount, 0) : undefined;

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
        return tx.purchaseOrder.update({
          where: { id, orgId },
          data: {
            supplierId: dto.supplierId ?? undefined,
            warehouseId: dto.warehouseId ?? undefined,
            contractId: newContractId,
            notes: dto.notes,
            totalAmount,
            ...(totalVat !== undefined ? { totalVat } : {}),
            documentDate: dto.documentDate ? new Date(dto.documentDate) : undefined,
            ...(dto.paymentDate !== undefined
              ? { paymentDate: dto.paymentDate ? new Date(dto.paymentDate) : null }
              : {}),
          },
          include: {
            supplier: { select: { firstName: true, lastName: true, companyName: true } },
            warehouse: { select: { name: true } },
            contract: { select: { id: true, number: true } },
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

    return this.toDto(updated);
  }

  async transition(
    orgId: string,
    id: string,
    newStatus: POStatus,
  ): Promise<PurchaseOrderResponseDto> {
    await this.prisma.$transaction(
      async tx => {
        // sto-optimize: status-only projection — assertFsmTransition потребує лише поточний статус.
        const po = await tx.purchaseOrder.findFirst({
          where: { id, orgId, deletedAt: null },
          select: { status: true },
        });
        if (!po) throw new NotFoundException('Замовлення не знайдено');

        assertFsmTransition(PO_TRANSITIONS, po.status as POStatus, newStatus);

        await tx.purchaseOrder.update({ where: { id, orgId }, data: { status: newStatus } });
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    );
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
    if (!po) throw new NotFoundException('Замовлення не знайдено');
    if (po.status !== PurchaseOrderStatus.ORDERED && po.status !== PurchaseOrderStatus.PARTIAL) {
      throw new BadRequestException(
        'Прийом можливий лише для замовлень зі статусом ORDERED або PARTIAL',
      );
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
        throw new BadRequestException('Одиницю виміру не знайдено в межах організації');
      }
    }

    // Dedupe protection on lineId: without this, two recv entries with the same lineId produce
    // double `increment` — Promise.all runs both updates even inside one tx, both accumulate.
    const seen = new Set<string>();
    for (const recv of dto.lines) {
      if (seen.has(recv.lineId)) {
        throw new BadRequestException('Кожен рядок прийому має бути унікальним');
      }
      seen.add(recv.lineId);
    }

    // sto-optimize: всі лінії незалежні (різні lineId/goodId rows) — паралелимо.
    // Всередині лінії: createMovement і lineUpdate пишуть у різні таблиці → теж паралельно.
    // NB: Prisma всередині $transaction виконує DB-операції послідовно (один pinned connection),
    // тож Promise.all дає лише JS-overhead-economy. receivedAmount акумулюємо через map → reduce
    // (уникаємо shared mutable у async callbacks).
    //
    // sto-optimize (2026-08-30): bucket-by-id Map замість Array.find() у циклі →
    // O(N+M) замість O(N×M). Помітно на PO з 100+ ліній (10_000 порівнянь → 200).
    const lineById = new Map(po.lines.map(l => [l.id, l]));
    const activeLines = dto.lines
      .map(recv => ({ recv, line: lineById.get(recv.lineId) }))
      .filter(
        (x): x is { recv: (typeof dto.lines)[0]; line: NonNullable<typeof x.line> } =>
          !!x.line && x.recv.receivedQty > 0,
      );

    const receivedAmount = activeLines.reduce(
      (sum, { recv, line }) => sum + recv.receivedQty * Number(line.price),
      0,
    );

    await this.prisma.$transaction(
      async tx => {
        await Promise.all(
          activeLines.map(({ recv, line }) => {
            // Prefer caller-provided UoM override (already validated against orgId above);
            // fall back to Good.unitId, then null (backward compat with nullable column).
            const resolvedUomId =
              (recv.unitOfMeasureId && allowedUomIds.has(recv.unitOfMeasureId)
                ? recv.unitOfMeasureId
                : null) ??
              line.good?.unitId ??
              null;
            // avoid overwriting an existing PO line UoM on subsequent partial
            // receives. Only persist UoM when (a) this is the first receive (no prior qty),
            // or (b) the caller passed an explicit override — otherwise keep the original.
            const shouldUpdateLineUom = line.receivedQty === 0 || !!recv.unitOfMeasureId;
            return Promise.all([
              this.inventory.createMovement(
                orgId,
                {
                  goodId: line.goodId,
                  warehouseId: po.warehouseId,
                  type: 'RECEIPT',
                  quantity: recv.receivedQty,
                  price: Number(line.price),
                  documentType: 'PurchaseOrder',
                  documentId: id,
                  createdBy: userId,
                  unitOfMeasureId: resolvedUomId,
                },
                tx,
              ),
              tx.purchaseOrderLine.update({
                where: { id: recv.lineId, orgId },
                data: {
                  receivedQty: { increment: recv.receivedQty },
                  ...(shouldUpdateLineUom ? { unitOfMeasureId: resolvedUomId } : {}),
                },
              }),
            ]);
          }),
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
      },
      { timeout: 30_000 }, // large PO (hundreds of lines) × createMovement with batch tracking
    );
    return this.findOne(orgId, id);
  }

  async remove(orgId: string, id: string): Promise<void> {
    // Narrow tenant guard — потрібен лише `status` для DRAFT check.
    const po = await this.prisma.purchaseOrder.findFirst({
      where: { id, orgId, deletedAt: null },
      select: { status: true },
    });
    if (!po) throw new NotFoundException('Замовлення не знайдено');
    if (po.status !== PurchaseOrderStatus.DRAFT)
      throw new BadRequestException('Видалити можна лише чернетку');
    // Race-safe updateMany з повним compound where (id+orgId+deletedAt:null).
    await this.prisma.purchaseOrder.updateMany({
      where: { id, orgId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
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
                goodType: true,
                brandId: true,
              },
            },
          },
        },
      },
    });
    if (!po) throw new NotFoundException('Замовлення не знайдено');
    // Defense-in-depth: розцінювати можна лише отримані товари (UI рендерить кнопку
    // тільки для RECEIVED/PARTIAL, але клієнт міг бути обійдений)
    if (po.status !== PurchaseOrderStatus.RECEIVED && po.status !== PurchaseOrderStatus.PARTIAL) {
      throw new BadRequestException(
        'Розцінити можна лише отримані товари (статус RECEIVED або PARTIAL)',
      );
    }

    // Prefetch active rules once to avoid N+1 (each line previously fetched rules in a loop
    // and called a separate $transaction without timeout).
    const rules = ruleId
      ? await this.pricingService
          .getActiveRulesForOrg(orgId)
          .then(all => all.filter(r => r.id === ruleId))
      : await this.pricingService.getActiveRulesForOrg(orgId);

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
        rules,
        line.goodId,
        line.good.category ?? undefined,
        line.good.goodType ?? undefined,
        line.good.brandId ?? undefined,
        costPrice,
        po.supplierId ?? undefined,
      );
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
                where: { id: u.lineId },
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
    notes: string | null;
    documentDate?: Date | null;
    paymentDate?: Date | null;
    pricedAt?: Date | null;
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
      notes: po.notes ?? null,
      documentDate: po.documentDate ? po.documentDate.toISOString().slice(0, 10) : null,
      paymentDate: po.paymentDate ? po.paymentDate.toISOString().slice(0, 10) : null,
      pricedAt: po.pricedAt instanceof Date ? po.pricedAt.toISOString() : (po.pricedAt ?? null),
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
        // safeCoeff() catches legacy/seed coefficient=0/NaN/negative — frontend uses it as divisor for display↔base conversion.
        coefficient: safeCoeff(l.good?.unitOfMeasure?.coefficient),
        quantity: l.quantity,
        price: Number(l.price),
        amount: l.quantity * Number(l.price),
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
}
