import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { DocumentType, Prisma, StockDocumentType, StockMovementType } from '@prisma/client';
import { TRANSACTION_TIMEOUT_MS } from '@sto/shared';

import { kyivToday } from '../../common/utils/kyiv-date';
import { calculatePagination } from '../../common/utils/pagination';
import { assertFsmTransition } from '../../common/utils/fsm';
import { safeCoeff } from '../../common/utils/math';
import { PrismaService } from '../../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';
import { DocumentNumberService } from '../document-number/document-number.service';
import {
  CreateStockDocumentDto,
  UpdateStockDocumentDto,
  StockDocumentResponseDto,
  PaginatedStockDocumentsDto,
} from './stock-documents.dto';

const DOC_STATUSES = ['DRAFT', 'CONFIRMED', 'CANCELLED'] as const;
type DocStatus = (typeof DOC_STATUSES)[number];

const DOC_TRANSITIONS: Record<DocStatus, DocStatus[]> = {
  DRAFT: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: [],
  CANCELLED: [],
};

const MOVEMENT_TYPES: Partial<Record<StockDocumentType, StockMovementType>> = {
  WRITEOFF: StockMovementType.WRITEOFF,
  OPENING_BALANCE: StockMovementType.OPENING_BALANCE,
  RECEIPT: StockMovementType.RECEIPT,
};

@Injectable()
export class StockDocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly docNumbers: DocumentNumberService,
  ) {}

  async findAll(
    orgId: string,
    page = 1,
    limit = 20,
    type?: string,
    status?: string,
    showDeleted = false,
    dateFrom?: string,
    dateTo?: string,
    sortBy?: string,
    sortDir?: 'asc' | 'desc',
  ): Promise<PaginatedStockDocumentsDto> {
    const where: Prisma.StockDocumentWhereInput = {
      orgId,
      deletedAt: showDeleted ? undefined : null,
    };
    if (type) where.type = type as StockDocumentType;
    if (status) where.status = status as DocStatus;
    if (dateFrom || dateTo) {
      where.documentDate = {
        ...(dateFrom ? { gte: new Date(dateFrom) } : {}),
        ...(dateTo ? { lte: new Date(dateTo + 'T23:59:59.999Z') } : {}),
      };
    }

    const { skip, take } = calculatePagination({ page, limit });
    const SD_SORT: Record<string, string> = {
      documentDate: 'documentDate',
      createdAt: 'createdAt',
    };
    const sortField = SD_SORT[sortBy ?? ''] ?? 'createdAt';
    const sortOrder = sortDir === 'asc' ? 'asc' : 'desc';
    // Bug review (sto-optimize 2026-06-05): lines не використовуються у table-cells списку,
    // лише `doc.lines.length` у комірці «Позицій». DetailPanel рендериться для ОДНОГО
    // вибраного doc і завантажується lazily через GET /stock-documents/:id (findOne уже
    // включає lines з full include). Винесли `lines` з findAll → economy: 1000 × 20 = 20K
    // line rows на запит → 0; кількість віддаємо через `_count.lines`. linesCount → toDto.
    const [items, total] = await this.prisma.$transaction([
      this.prisma.stockDocument.findMany({
        where,
        skip,
        take,
        orderBy: { [sortField]: sortOrder },
        include: {
          branch: { select: { name: true } },
          warehouse: { select: { name: true } },
          targetWarehouse: { select: { name: true } },
          _count: { select: { lines: { where: { deletedAt: null } } } },
        },
      }),
      this.prisma.stockDocument.count({ where }),
    ]);

    return { items: items.map(d => this.toDto(d)), total, page, limit: take };
  }

  async findOne(orgId: string, id: string): Promise<StockDocumentResponseDto> {
    const doc = await this.prisma.stockDocument.findFirst({
      where: { id, orgId, deletedAt: null },
      include: {
        branch: { select: { name: true } },
        warehouse: { select: { name: true } },
        targetWarehouse: { select: { name: true } },
        lines: {
          where: { deletedAt: null },
          take: 1000,
          include: {
            good: {
              select: {
                name: true,
                sku: true,
                unit: true,
                unitOfMeasure: { select: { shortName: true, coefficient: true } },
              },
            },
          },
        },
      },
    });
    if (!doc) throw new NotFoundException('Документ не знайдено');
    return this.toDto(doc);
  }

  async create(orgId: string, dto: CreateStockDocumentDto): Promise<StockDocumentResponseDto> {
    // Усі 3 FK перевірки можуть йти конкурентно — кожна незалежна.
    // Conditional target warehouse: tернарка зберігає типи й уникає зайвого RTT для TRANSFER.
    // sto-optimize: narrow projection — FK guards використовуються лише для існування 404,
    // решта полів (name/address/syncVersion/etc.) не читаються далі.
    const [branch, warehouse, target] = await Promise.all([
      this.prisma.garageBranch.findFirst({
        where: { id: dto.branchId, orgId, deletedAt: null },
        select: { id: true },
      }),
      this.prisma.warehouse.findFirst({
        where: { id: dto.warehouseId, orgId, deletedAt: null },
        select: { id: true },
      }),
      dto.targetWarehouseId
        ? this.prisma.warehouse.findFirst({
            where: { id: dto.targetWarehouseId, orgId, deletedAt: null },
            select: { id: true },
          })
        : Promise.resolve(null),
    ]);
    if (!branch) throw new NotFoundException('Філію не знайдено');
    if (!warehouse) throw new NotFoundException('Склад не знайдено');

    if (dto.type === 'TRANSFER' && !dto.targetWarehouseId) {
      throw new BadRequestException('Для переміщення потрібен склад призначення');
    }
    if (dto.targetWarehouseId) {
      if (!target) throw new NotFoundException('Склад призначення не знайдено');
      if (dto.targetWarehouseId === dto.warehouseId) {
        throw new BadRequestException('Склад джерела і призначення не можуть збігатись');
      }
    }

    const docTypeMap: Record<string, DocumentType> = {
      WRITEOFF: 'STOCK_WRITEOFF',
      TRANSFER: 'STOCK_TRANSFER',
      OPENING_BALANCE: 'STOCK_OPENING',
      RECEIPT: 'STOCK_RECEIPT',
    };
    const number = await this.docNumbers.next(orgId, docTypeMap[dto.type] ?? 'STOCK_WRITEOFF');

    const lines = dto.lines ?? [];

    const doc = await this.prisma.$transaction(
      async tx => {
        const created = await tx.stockDocument.create({
          data: {
            orgId,
            branchId: dto.branchId,
            warehouseId: dto.warehouseId,
            targetWarehouseId: dto.targetWarehouseId ?? null,
            type: dto.type,
            number,
            notes: dto.notes,
            documentDate: dto.documentDate ? new Date(dto.documentDate) : kyivToday(),
          },
        });
        if (lines.length) {
          await tx.stockDocumentLine.createMany({
            data: lines.map(l => ({
              orgId,
              stockDocumentId: created.id,
              goodId: l.goodId,
              quantity: l.quantity,
              price: l.price ?? null,
            })),
          });
        }
        return tx.stockDocument.findFirstOrThrow({
          where: { id: created.id, orgId, deletedAt: null },
          include: {
            branch: { select: { name: true } },
            warehouse: { select: { name: true } },
            targetWarehouse: { select: { name: true } },
            lines: {
              where: { deletedAt: null },
              take: 1000,
              include: {
                good: {
                  select: {
                    name: true,
                    sku: true,
                    unit: true,
                    unitOfMeasure: { select: { shortName: true, coefficient: true } },
                  },
                },
              },
            },
          },
        });
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    ); // Bug #132: explicit timeout

    return this.toDto(doc);
  }

  async update(
    orgId: string,
    id: string,
    dto: UpdateStockDocumentDto,
  ): Promise<StockDocumentResponseDto> {
    // sto-optimize: status-only projection — guard потребує лише DRAFT перевірку.
    // Раніше тягнуло warehouseId/branchId/notes/documentDate/syncVersion + всі ігноровані колонки.
    const doc = await this.prisma.stockDocument.findFirst({
      where: { id, orgId, deletedAt: null },
      select: { status: true },
    });
    if (!doc) throw new NotFoundException('Документ не знайдено');
    if (doc.status !== 'DRAFT') throw new BadRequestException('Редагувати можна лише чернетку');

    const updated = await this.prisma.$transaction(
      async tx => {
        if (dto.lines !== undefined) {
          await tx.stockDocumentLine.updateMany({
            where: { stockDocumentId: id, orgId },
            data: { deletedAt: new Date() },
          });
          if (dto.lines.length) {
            await tx.stockDocumentLine.createMany({
              data: dto.lines.map(l => ({
                orgId,
                stockDocumentId: id,
                goodId: l.goodId,
                quantity: l.quantity,
                price: l.price ?? null,
              })),
            });
          }
        }
        return tx.stockDocument.update({
          where: { id, orgId },
          data: {
            notes: dto.notes,
            documentDate: dto.documentDate ? new Date(dto.documentDate) : undefined,
          },
          include: {
            branch: { select: { name: true } },
            warehouse: { select: { name: true } },
            targetWarehouse: { select: { name: true } },
            lines: {
              where: { deletedAt: null },
              take: 1000,
              include: {
                good: {
                  select: {
                    name: true,
                    sku: true,
                    unit: true,
                    unitOfMeasure: { select: { shortName: true, coefficient: true } },
                  },
                },
              },
            },
          },
        });
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    ); // Bug #132: explicit timeout

    return this.toDto(updated);
  }

  async transition(
    orgId: string,
    id: string,
    newStatus: DocStatus,
    userId?: string,
  ): Promise<StockDocumentResponseDto> {
    const doc = await this.prisma.stockDocument.findFirst({
      where: { id, orgId, deletedAt: null },
      include: {
        lines: {
          where: { deletedAt: null },
          take: 1000,
          include: { good: { select: { unitId: true } } },
        },
      },
    });
    if (!doc) throw new NotFoundException('Документ не знайдено');

    assertFsmTransition(DOC_TRANSITIONS, doc.status as DocStatus, newStatus);

    if (newStatus === 'CONFIRMED') {
      if (!doc.lines.length) {
        throw new BadRequestException('Документ не може бути підтверджено без позицій');
      }

      await this.prisma.$transaction(
        async tx => {
          const movType = MOVEMENT_TYPES[doc.type];
          if (doc.type !== 'TRANSFER' && !movType)
            throw new BadRequestException(`Непідтримуваний тип документу: ${doc.type}`);

          // sto-optimize: всі лінії незалежні (різні goodId/warehouseId rows) — паралелимо.
          // Всередині кожної лінії: createMovement і UoM-update пишуть у різні таблиці — теж
          // паралельно. Для TRANSFER: writeoff+receipt мають різні warehouseId → race-safe.
          // NB: усередині одного $transaction Prisma виконує DB-операції послідовно над
          // прикріпленим connection, тож Promise.all дає лише JS-рівневий overhead-economy
          // (не справжній паралелізм) — але це безпечно для race-конкуренції stockItem upsert
          // (Postgres serialize ON CONFLICT під тим самим connection).
          await Promise.all(
            doc.lines.map(line => {
              const lineUnitId = line.good?.unitId ?? null;
              // Bug #236: persist resolved UoM — extracted to avoid duplication in both branches.
              // sto-review §2.2: defense-in-depth — include orgId у where (узгоджено з PO.receive
              // де line update теж компаундний where: { id, orgId }).
              const maybeUpdateUom = lineUnitId
                ? tx.stockDocumentLine.update({
                    where: { id: line.id, orgId },
                    data: { unitOfMeasureId: lineUnitId },
                  })
                : Promise.resolve();
              // Shared movement fields — only warehouseId/type/quantity differ per branch.
              const baseArgs = {
                goodId: line.goodId,
                price: line.price ? Number(line.price) : undefined,
                documentType: 'StockDocument' as const,
                documentId: id,
                createdBy: userId,
                unitOfMeasureId: lineUnitId,
              };
              if (doc.type === 'TRANSFER') {
                return Promise.all([
                  this.inventory.createMovement(
                    orgId,
                    {
                      ...baseArgs,
                      warehouseId: doc.warehouseId,
                      type: 'WRITEOFF',
                      quantity: -line.quantity,
                    },
                    tx,
                  ),
                  this.inventory.createMovement(
                    orgId,
                    {
                      ...baseArgs,
                      warehouseId: doc.targetWarehouseId!,
                      type: 'RECEIPT',
                      quantity: line.quantity,
                    },
                    tx,
                  ),
                  maybeUpdateUom,
                ]);
              }
              const quantity = doc.type === 'WRITEOFF' ? -line.quantity : line.quantity;
              return Promise.all([
                this.inventory.createMovement(
                  orgId,
                  { ...baseArgs, warehouseId: doc.warehouseId, type: movType!, quantity },
                  tx,
                ),
                maybeUpdateUom,
              ]);
            }),
          );

          await tx.stockDocument.update({
            where: { id, orgId },
            data: { status: 'CONFIRMED', confirmedAt: new Date(), confirmedBy: userId ?? null },
          });
        },
        { timeout: 15_000 },
      ); // Bug #132: explicit timeout — N rows × createMovement (батч-tracking + StockMovement + upsert stockItem)
    } else {
      await this.prisma.stockDocument.update({ where: { id, orgId }, data: { status: newStatus } });
    }

    return this.findOne(orgId, id);
  }

  async remove(orgId: string, id: string): Promise<void> {
    // Narrow tenant guard — потрібен лише `status` для DRAFT check.
    const doc = await this.prisma.stockDocument.findFirst({
      where: { id, orgId, deletedAt: null },
      select: { status: true },
    });
    if (!doc) throw new NotFoundException('Документ не знайдено');
    if (doc.status !== 'DRAFT') throw new BadRequestException('Видалити можна лише чернетку');
    // Race-safe updateMany з повним compound where (id+orgId+deletedAt:null).
    await this.prisma.stockDocument.updateMany({
      where: { id, orgId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
  }

  private toDto(doc: {
    id: string;
    orgId: string;
    number: string;
    type: string;
    status: string;
    branchId: string;
    warehouseId: string;
    targetWarehouseId: string | null;
    notes: string | null;
    documentDate?: Date | null;
    confirmedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
    deletedAt?: Date | null;
    branch: { name: string } | null;
    warehouse: { name: string } | null;
    targetWarehouse: { name: string } | null;
    // findAll → `_count.lines` тільки; findOne → повний `lines[]`. Обидва опціональні.
    lines?: Array<{
      id: string;
      goodId: string;
      quantity: number;
      price: Prisma.Decimal | null;
      unitOfMeasureId?: string | null;
      good: {
        name: string;
        sku: string | null;
        unit: string;
        unitOfMeasure: { shortName: string; coefficient: number } | null;
      } | null;
    }>;
    _count?: { lines: number };
  }): StockDocumentResponseDto {
    return {
      id: doc.id,
      orgId: doc.orgId,
      number: doc.number,
      type: doc.type,
      status: doc.status,
      branchId: doc.branchId,
      branchName: doc.branch?.name,
      warehouseId: doc.warehouseId,
      warehouseName: doc.warehouse?.name,
      targetWarehouseId: doc.targetWarehouseId ?? null,
      targetWarehouseName: doc.targetWarehouse?.name ?? null,
      notes: doc.notes ?? null,
      confirmedAt: doc.confirmedAt ?? null,
      documentDate: doc.documentDate ? doc.documentDate.toISOString().slice(0, 10) : null,
      lines: (doc.lines ?? []).map(l => ({
        id: l.id,
        goodId: l.goodId,
        goodName: l.good?.name,
        goodSku: l.good?.sku ?? null,
        unit: l.good?.unit,
        unitShortName: l.good?.unitOfMeasure?.shortName ?? l.good?.unit,
        // Bug #316: safeCoeff() ловить legacy/seed coefficient=0/NaN/негативні —
        // фронт використовує coefficient як дільник для display↔base conversion.
        coefficient: safeCoeff(l.good?.unitOfMeasure?.coefficient),
        quantity: l.quantity,
        price: l.price != null ? Number(l.price) : null,
        unitOfMeasureId: l.unitOfMeasureId ?? null,
      })),
      // findAll: lines opted-out, beredemo з `_count`; findOne: lines присутні → fallback.
      linesCount: doc._count?.lines ?? doc.lines?.length ?? 0,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      deletedAt: doc.deletedAt ?? null,
    };
  }
}
