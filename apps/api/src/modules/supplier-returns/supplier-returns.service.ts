import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { Prisma, SupplierReturnStatus } from '@prisma/client';

import { kyivToday } from '../../common/utils/kyiv-date';
import { roundMoney } from '../../common/utils/math';
import { calculatePagination } from '../../common/utils/pagination';
import { deduplicateBy } from '../../common/utils/array';
import { PrismaService } from '../../prisma/prisma.service';
import { formatPersonName, TRANSACTION_TIMEOUT_MS, MAX_QUERY_LIMIT } from '@sto/shared';
import { DocumentNumberService } from '../document-number/document-number.service';
import { InventoryService } from '../inventory/inventory.service';
import { SettlementsService } from '../settlements/settlements.service';
import {
  CreateSupplierReturnDto,
  UpdateSupplierReturnDto,
  SupplierReturnResponseDto,
  PaginatedSupplierReturnsDto,
} from './supplier-returns.dto';

type SRStatus = SupplierReturnStatus;

const SR_TRANSITIONS: Record<SRStatus, SRStatus[]> = {
  DRAFT: [SupplierReturnStatus.CONFIRMED, SupplierReturnStatus.CANCELLED],
  CONFIRMED: [],
  CANCELLED: [],
};

@Injectable()
export class SupplierReturnsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly settlements: SettlementsService,
    private readonly docNumbers: DocumentNumberService,
  ) {}

  async findAll(
    orgId: string,
    page = 1,
    limit = 20,
    status?: SRStatus,
    q?: string,
    showDeleted = false,
    dateFrom?: string,
    dateTo?: string,
  ): Promise<PaginatedSupplierReturnsDto> {
    const where: Prisma.SupplierReturnWhereInput = {
      orgId,
      ...(showDeleted ? {} : { deletedAt: null }),
    };
    if (status) where.status = status;
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
    const [items, total] = await Promise.all([
      this.prisma.supplierReturn.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        include: {
          supplier: { select: { firstName: true, lastName: true, companyName: true } },
          warehouse: { select: { name: true } },
          _count: { select: { lines: { where: { deletedAt: null } } } },
        },
      }),
      this.prisma.supplierReturn.count({ where }),
    ]);

    return {
      items: items.map(item => this.toDto(item as Parameters<typeof this.toDto>[0])),
      total,
      page,
      limit: take,
    };
  }

  async findOne(orgId: string, id: string): Promise<SupplierReturnResponseDto> {
    const sr = await this.prisma.supplierReturn.findFirst({
      where: { id, orgId, deletedAt: null },
      include: {
        supplier: { select: { firstName: true, lastName: true, companyName: true } },
        warehouse: { select: { name: true } },
        lines: {
          where: { deletedAt: null },
          include: {
            good: {
              select: {
                name: true,
                sku: true,
                unit: true,
                unitOfMeasure: { select: { shortName: true } },
              },
            },
          },
          take: MAX_QUERY_LIMIT,
        },
      },
    });
    if (!sr) throw new NotFoundException('Повернення не знайдено');
    return this.toDto(sr);
  }

  async create(orgId: string, dto: CreateSupplierReturnDto): Promise<SupplierReturnResponseDto> {
    const [supplier, warehouse] = await Promise.all([
      this.prisma.counterparty.findFirst({
        where: { id: dto.supplierId, orgId, deletedAt: null },
        select: { id: true },
      }),
      this.prisma.warehouse.findFirst({
        where: { id: dto.warehouseId, orgId, deletedAt: null },
        select: { id: true },
      }),
    ]);
    if (!supplier) throw new NotFoundException('Постачальника не знайдено');
    if (!warehouse) throw new NotFoundException('Склад не знайдено');

    const lines = dto.lines ?? [];
    const dedupedLines = deduplicateBy(lines, l => l.goodId);

    // cross-tenant FK guard: кожен goodId/unitOfMeasureId з DTO має існувати
    // у цій організації. Сирий Prisma write валідує лише глобальне існування FK,
    // НЕ orgId → FK з чужої org проходить → cross-tenant linkage.
    await this.validateLineRefs(orgId, dedupedLines);

    const number = await this.docNumbers.next(orgId, 'SUPPLIER_RETURN');
    const totalAmount = roundMoney(dedupedLines.reduce((sum, l) => sum + l.quantity * l.price, 0));

    const sr = await this.prisma.supplierReturn.create({
      data: {
        orgId,
        supplierId: dto.supplierId,
        warehouseId: dto.warehouseId,
        number,
        totalAmount,
        notes: dto.notes,
        documentDate: dto.documentDate ? new Date(dto.documentDate) : kyivToday(),
        lines: {
          create: dedupedLines.map(l => ({
            orgId,
            goodId: l.goodId,
            quantity: l.quantity,
            price: l.price,
            unitOfMeasureId: l.unitOfMeasureId ?? null,
          })),
        },
      },
      include: {
        supplier: { select: { firstName: true, lastName: true, companyName: true } },
        warehouse: { select: { name: true } },
        lines: {
          where: { deletedAt: null },
          include: {
            good: {
              select: {
                name: true,
                sku: true,
                unit: true,
                unitOfMeasure: { select: { shortName: true } },
              },
            },
          },
        },
      },
    });

    return this.toDto(sr);
  }

  async update(
    orgId: string,
    id: string,
    dto: UpdateSupplierReturnDto,
  ): Promise<SupplierReturnResponseDto> {
    const sr = await this.prisma.supplierReturn.findFirst({
      where: { id, orgId, deletedAt: null },
      select: { id: true, status: true },
    });
    if (!sr) throw new NotFoundException('Повернення не знайдено');
    if (sr.status !== SupplierReturnStatus.DRAFT) {
      throw new BadRequestException('Редагування дозволено лише у статусі "Чернетка"');
    }

    // Parallel validation: supplier + warehouse (independent queries)
    const [supplier, warehouse] = await Promise.all([
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
    ]);
    if (dto.supplierId && !supplier) throw new NotFoundException('Постачальника не знайдено');
    if (dto.warehouseId && !warehouse) throw new NotFoundException('Склад не знайдено');

    // cross-tenant FK guard for update() — кожен новий goodId/unitOfMeasureId
    // має існувати у цій організації. Валідація ПЕРЕД $transaction (read-only).
    if (dto.lines !== undefined && dto.lines.length > 0) {
      const dedupedForCheck = deduplicateBy(dto.lines, l => l.goodId);
      await this.validateLineRefs(orgId, dedupedForCheck);
    }

    await this.prisma.$transaction(
      async tx => {
        if (dto.lines !== undefined) {
          await tx.supplierReturnLine.updateMany({
            where: { supplierReturnId: id, orgId },
            data: { deletedAt: new Date() },
          });
          const dedupedLines = deduplicateBy(dto.lines, l => l.goodId);
          if (dedupedLines.length > 0) {
            await tx.supplierReturnLine.createMany({
              data: dedupedLines.map(l => ({
                orgId,
                supplierReturnId: id,
                goodId: l.goodId,
                quantity: l.quantity,
                price: l.price,
                unitOfMeasureId: l.unitOfMeasureId ?? null,
              })),
            });
          }
        }

        const lines = await tx.supplierReturnLine.findMany({
          where: { supplierReturnId: id, orgId, deletedAt: null },
          select: { quantity: true, price: true },
          take: MAX_QUERY_LIMIT,
        });
        const totalAmount = roundMoney(
          lines.reduce((sum, l) => sum + l.quantity * Number(l.price), 0),
        );

        await tx.supplierReturn.update({
          where: { id, orgId },
          data: {
            ...(dto.supplierId ? { supplierId: dto.supplierId } : {}),
            ...(dto.warehouseId ? { warehouseId: dto.warehouseId } : {}),
            ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
            ...(dto.documentDate ? { documentDate: new Date(dto.documentDate) } : {}),
            totalAmount,
          },
        });
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    );

    return this.findOne(orgId, id);
  }

  async confirm(orgId: string, id: string, userId: string): Promise<SupplierReturnResponseDto> {
    // Pre-check (cheap) — повертає 404 без відкриття транзакції,
    // якщо повернення не існує або відсутні рядки.
    const pre = await this.prisma.supplierReturn.findFirst({
      where: { id, orgId, deletedAt: null },
      select: {
        status: true,
        _count: { select: { lines: { where: { deletedAt: null } } } },
      },
    });
    if (!pre) throw new NotFoundException('Повернення не знайдено');

    const allowed = SR_TRANSITIONS[pre.status];
    if (!allowed.includes(SupplierReturnStatus.CONFIRMED)) {
      throw new BadRequestException(`Неможливо підтвердити повернення зі статусу "${pre.status}"`);
    }
    if (pre._count.lines === 0) {
      throw new BadRequestException('Повернення не може бути підтверджено без рядків');
    }

    await this.prisma.$transaction(
      async tx => {
        // §4 sto-review: FSM auto-transition у tx → re-read entity всередині tx +
        // перевірка `status === expected`. Без цього два concurrent confirm()
        // дадуть подвійний WRITEOFF + REFUND.
        const sr = await tx.supplierReturn.findFirst({
          where: { id, orgId, deletedAt: null },
          select: {
            status: true,
            supplierId: true,
            warehouseId: true,
            totalAmount: true,
            lines: {
              where: { deletedAt: null },
              select: {
                goodId: true,
                quantity: true,
                price: true,
                unitOfMeasureId: true,
              },
              take: MAX_QUERY_LIMIT,
            },
          },
        });
        if (!sr) throw new NotFoundException('Повернення не знайдено');
        if (sr.status !== SupplierReturnStatus.DRAFT) {
          throw new BadRequestException(
            `Неможливо підтвердити повернення зі статусу "${sr.status}"`,
          );
        }

        await Promise.all(
          sr.lines.map(line =>
            this.inventory.createMovement(
              orgId,
              {
                goodId: line.goodId,
                warehouseId: sr.warehouseId,
                type: 'WRITEOFF',
                // WRITEOFF потребує від'ємну кількість — InventoryService виконує
                // `quantity: { increment: quantityDelta }` (work-orders + stock-documents
                // мають таку саму конвенцію).
                quantity: -line.quantity,
                price: Number(line.price),
                documentType: 'SupplierReturn',
                documentId: id,
                createdBy: userId,
                unitOfMeasureId: line.unitOfMeasureId ?? null,
              },
              tx,
            ),
          ),
        );

        const returnAmount = Number(sr.totalAmount);
        if (returnAmount > 0) {
          // Повернення товару постачальнику: ми відправили йому товар назад → наш борг
          // перед ним зменшується. Семантика — SUPPLIER_REFUND (BALANCE_SIGN = +1,
          // підіймає від'ємний борг до 0). НЕ REFUND (−1) — той збільшив би наш борг.
          await this.settlements.createTransaction(
            orgId,
            {
              counterpartyId: sr.supplierId,
              type: 'SUPPLIER_REFUND',
              amount: returnAmount,
              documentType: 'SupplierReturn',
              documentId: id,
              createdBy: userId,
            },
            tx,
          );
        }

        await tx.supplierReturn.update({
          where: { id, orgId },
          data: { status: SupplierReturnStatus.CONFIRMED },
        });
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    );

    return this.findOne(orgId, id);
  }

  async cancel(orgId: string, id: string): Promise<SupplierReturnResponseDto> {
    const sr = await this.prisma.supplierReturn.findFirst({
      where: { id, orgId, deletedAt: null },
      select: { id: true, status: true },
    });
    if (!sr) throw new NotFoundException('Повернення не знайдено');

    const allowed = SR_TRANSITIONS[sr.status];
    if (!allowed.includes(SupplierReturnStatus.CANCELLED)) {
      throw new BadRequestException(`Неможливо скасувати повернення зі статусу "${sr.status}"`);
    }

    await this.prisma.supplierReturn.update({
      where: { id, orgId },
      data: { status: SupplierReturnStatus.CANCELLED },
    });

    return this.findOne(orgId, id);
  }

  async remove(orgId: string, id: string): Promise<void> {
    const sr = await this.prisma.supplierReturn.findFirst({
      where: { id, orgId, deletedAt: null },
      select: { status: true },
    });
    if (!sr) throw new NotFoundException('Повернення не знайдено');
    if (sr.status !== SupplierReturnStatus.DRAFT) {
      throw new BadRequestException('Видалити можна лише повернення зі статусом "Чернетка"');
    }

    await this.prisma.supplierReturn.update({
      where: { id, orgId },
      data: { deletedAt: new Date() },
    });
  }

  /**
   * Cross-tenant FK guard для рядків повернення.
   * Сирий Prisma write валідує лише глобальне існування FK, НЕ orgId — тому
   * відсутність цього guard дозволяє linkage товарів/одиниць виміру з чужої org.
   * Паралельно перевіряємо batch through Promise.all → 1–2 RTT замість N послідовних.
   */
  private async validateLineRefs(
    orgId: string,
    lines: Array<{ goodId: string; unitOfMeasureId?: string }>,
  ): Promise<void> {
    if (lines.length === 0) return;
    const goodIds = Array.from(new Set(lines.map(l => l.goodId)));
    const uomIds = Array.from(
      new Set(lines.map(l => l.unitOfMeasureId).filter((v): v is string => !!v)),
    );

    const [goods, uoms] = await Promise.all([
      this.prisma.good.findMany({
        where: { id: { in: goodIds }, orgId, deletedAt: null },
        select: { id: true },
      }),
      uomIds.length > 0
        ? this.prisma.unitOfMeasure.findMany({
            where: { id: { in: uomIds }, orgId, deletedAt: null },
            select: { id: true },
          })
        : Promise.resolve([]),
    ]);

    if (goods.length !== goodIds.length) {
      const found = new Set(goods.map(g => g.id));
      const missing = goodIds.filter(id => !found.has(id));
      throw new NotFoundException(`Товар не знайдено: ${missing[0]}`);
    }
    if (uoms.length !== uomIds.length) {
      const found = new Set(uoms.map(u => u.id));
      const missing = uomIds.filter(id => !found.has(id));
      throw new NotFoundException(`Одиницю виміру не знайдено: ${missing[0]}`);
    }
  }

  private toDto(sr: {
    id: string;
    orgId: string;
    number: string;
    status: SupplierReturnStatus;
    supplierId: string;
    warehouseId: string;
    totalAmount: Prisma.Decimal | number;
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
    warehouse?: { name: string } | null;
    lines?: Array<{
      id: string;
      goodId: string;
      quantity: number;
      price: Prisma.Decimal | number;
      unitOfMeasureId?: string | null;
      good?: {
        name: string;
        sku: string | null;
        unit: string;
        unitOfMeasure?: { shortName: string } | null;
      } | null;
    }>;
    _count?: { lines: number };
  }): SupplierReturnResponseDto {
    const sup = sr.supplier;
    const supplierName =
      formatPersonName(sup?.lastName, sup?.firstName, sup?.companyName) || undefined;
    return {
      id: sr.id,
      orgId: sr.orgId,
      number: sr.number,
      status: sr.status,
      supplierId: sr.supplierId,
      supplierName,
      warehouseId: sr.warehouseId,
      warehouseName: sr.warehouse?.name,
      totalAmount: Number(sr.totalAmount),
      notes: sr.notes ?? null,
      documentDate: sr.documentDate ? sr.documentDate.toISOString().slice(0, 10) : null,
      linesCount: sr._count?.lines ?? sr.lines?.length ?? 0,
      deletedAt: sr.deletedAt instanceof Date ? sr.deletedAt.toISOString() : (sr.deletedAt ?? null),
      lines: (sr.lines ?? []).map(l => ({
        id: l.id,
        goodId: l.goodId,
        goodName: l.good?.name,
        goodSku: l.good?.sku ?? null,
        unit: l.good?.unit,
        unitShortName: l.good?.unitOfMeasure?.shortName ?? l.good?.unit,
        quantity: l.quantity,
        price: Number(l.price),
        amount: roundMoney(l.quantity * Number(l.price)),
        unitOfMeasureId: l.unitOfMeasureId ?? null,
      })),
      createdAt: sr.createdAt instanceof Date ? sr.createdAt.toISOString() : sr.createdAt,
      updatedAt: sr.updatedAt instanceof Date ? sr.updatedAt.toISOString() : sr.updatedAt,
    };
  }
}
