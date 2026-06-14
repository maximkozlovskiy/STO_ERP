import { calculatePagination } from '../../common/utils/pagination';
import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TRANSACTION_TIMEOUT_MS } from '@sto/shared';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CreateGoodDto,
  UpdateGoodDto,
  GoodQueryDto,
  GoodResponseDto,
  PaginatedGoodsDto,
  CreateGoodUoMDto,
  UpdateGoodUoMDto,
  GoodUoMResponseDto,
} from './goods.dto';
import { CreateGoodBarcodeDto, GoodBarcodeResponseDto } from './barcodes.dto';

@Injectable()
export class GoodsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(orgId: string, query: GoodQueryDto): Promise<PaginatedGoodsDto> {
    const where: Prisma.GoodWhereInput = {
      orgId,
      ...(query.showDeleted ? {} : { deletedAt: null }),
    };
    if (query.barcode) {
      where.barcode = query.barcode;
    } else if (query.q) {
      where.OR = [
        { name: { contains: query.q, mode: 'insensitive' } },
        { sku: { contains: query.q, mode: 'insensitive' } },
        { barcode: { contains: query.q, mode: 'insensitive' } },
      ];
    }
    if (query.category) where.category = { contains: query.category, mode: 'insensitive' };
    if (query.goodCategoryIds?.length) where.goodCategoryId = { in: query.goodCategoryIds };
    else if (query.goodCategoryId) where.goodCategoryId = query.goodCategoryId;

    const { skip, take } = calculatePagination({ page: query.page, limit: query.limit });
    const supplierSelect = {
      select: { firstName: true, lastName: true, companyName: true },
    } as const;
    const goodCategorySelect = { select: { id: true, name: true } } as const;
    const [items, total] = await this.prisma.$transaction([
      this.prisma.good.findMany({
        where,
        // Bug #306: показуємо активні (deletedAt=NULL) перед видаленими у showDeleted=true списках.
        // Postgres дефолтно ставить NULL у кінець ASC → ховаємо явним `nulls: 'first'`.
        orderBy: [{ deletedAt: { sort: 'asc', nulls: 'first' } }, { name: 'asc' }],
        skip,
        take,
        include: { preferredSupplier: supplierSelect, goodCategory: goodCategorySelect },
      }),
      this.prisma.good.count({ where }),
    ]);

    return {
      items: items.map(item => this.toDto(item)),
      total,
      page: query.page,
      limit: take,
    };
  }

  async findOne(orgId: string, id: string): Promise<GoodResponseDto> {
    const item = await this.prisma.good.findFirst({
      where: { id, orgId, deletedAt: null },
      include: {
        preferredSupplier: { select: { firstName: true, lastName: true, companyName: true } },
        goodCategory: { select: { id: true, name: true } },
      },
    });
    if (!item) throw new NotFoundException('Товар не знайдено');
    return this.toDto(item);
  }

  async create(orgId: string, dto: CreateGoodDto): Promise<GoodResponseDto> {
    // Parallel: sku-uniqueness check + FK validation — обидва незалежні precheck-и.
    const [existing] = await Promise.all([
      dto.sku
        ? this.prisma.good.findFirst({
            where: { orgId, sku: dto.sku, deletedAt: null },
            select: { id: true },
          })
        : Promise.resolve(null),
      this.validateFkReferences(orgId, dto),
    ]);
    if (dto.sku && existing)
      throw new ConflictException(`Товар з артикулом "${dto.sku}" вже існує`);
    const item = await this.prisma.good.create({
      data: { ...dto, orgId, unit: dto.unit ?? 'шт', salePrice: dto.salePrice ?? 0 },
      include: {
        preferredSupplier: { select: { firstName: true, lastName: true, companyName: true } },
      },
    });
    return this.toDto(item);
  }

  async update(orgId: string, id: string, dto: UpdateGoodDto): Promise<GoodResponseDto> {
    // Parallel: tenant guard (narrow id-only select) + sku-uniqueness + FK validation —
    // три незалежні precheck-и. Narrow вибірку замість this.findOne() (повний DTO + include
    // preferredSupplier + goodCategory) бо нам тільки потрібна existence-перевірка перед update,
    // який сам повертає повний DTO. Економить relations marshaling.
    const [existing, skuConflict] = await Promise.all([
      this.prisma.good.findFirst({
        where: { id, orgId, deletedAt: null },
        select: { id: true },
      }),
      dto.sku
        ? this.prisma.good.findFirst({
            where: { orgId, sku: dto.sku, deletedAt: null, NOT: { id } },
            select: { id: true },
          })
        : Promise.resolve(null),
      this.validateFkReferences(orgId, dto),
    ]);
    if (!existing) throw new NotFoundException('Товар не знайдено');
    if (dto.sku && skuConflict)
      throw new ConflictException(`Товар з артикулом "${dto.sku}" вже існує`);
    const item = await this.prisma.good.update({
      where: { id, orgId },
      data: dto,
      include: {
        preferredSupplier: { select: { firstName: true, lastName: true, companyName: true } },
      },
    });
    return this.toDto(item);
  }

  async remove(orgId: string, id: string): Promise<void> {
    // sto-optimize (2026-05-31 pattern): `findOne + update` 2-RTT → atomic `updateMany`
    // with full compound where (id+orgId+NOT deletedAt) — eliminates the race window
    // between guard and write, and saves one round-trip per delete.
    const result = await this.prisma.good.updateMany({
      where: { id, orgId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (result.count === 0) throw new NotFoundException('Товар не знайдено');
  }

  async restore(orgId: string, id: string): Promise<GoodResponseDto> {
    // Defense-in-depth: atomic updateMany with full compound where (sto-review pattern
    // 2026-05-30). Combines existence + tenant + "currently-deleted" assertion into one
    // statement. include is fetched separately via findFirstOrThrow (updateMany does not
    // support include).
    const result = await this.prisma.good.updateMany({
      where: { id, orgId, NOT: { deletedAt: null } },
      data: { deletedAt: null },
    });
    if (result.count === 0) throw new NotFoundException('Видалений товар не знайдено');
    const item = await this.prisma.good.findFirstOrThrow({
      where: { id, orgId },
      include: {
        preferredSupplier: { select: { firstName: true, lastName: true, companyName: true } },
      },
    });
    return this.toDto(item);
  }

  /**
   * Bug #161: optional FK поля (brandId / unitId / preferredSupplierId) валідуються
   * у межах поточної org ПЕРЕД записом. Без цього:
   *  1) FK з ІНШОЇ org проходить сирий DB constraint → cross-tenant витік (правило #6);
   *  2) неіснуючий ID → P2003 → загальне 400 замість конкретного повідомлення українською.
   * Усталений патерн STO ERP (Bug #90 у invoices/work-orders): findFirst({ id, orgId, deletedAt: null }).
   */
  private async validateFkReferences(
    orgId: string,
    dto: {
      brandId?: string | null;
      unitId?: string | null;
      preferredSupplierId?: string | null;
      goodCategoryId?: string | null;
    },
  ): Promise<void> {
    const [brand, unit, supplier, goodCategory] = await Promise.all([
      dto.brandId
        ? this.prisma.brand.findFirst({
            where: { id: dto.brandId, orgId, deletedAt: null },
            select: { id: true },
          })
        : Promise.resolve(null),
      dto.unitId
        ? this.prisma.unitOfMeasure.findFirst({
            where: { id: dto.unitId, orgId, deletedAt: null },
            select: { id: true },
          })
        : Promise.resolve(null),
      dto.preferredSupplierId
        ? this.prisma.counterparty.findFirst({
            where: { id: dto.preferredSupplierId, orgId, deletedAt: null },
            select: { id: true },
          })
        : Promise.resolve(null),
      // sto-review: goodCategoryId — повторюємо patter Bug #161 для нового FK.
      // Без перевірки cross-tenant ID пройде сирий DB FK constraint (он-prem deploy).
      dto.goodCategoryId
        ? this.prisma.goodCategory.findFirst({
            where: { id: dto.goodCategoryId, orgId, deletedAt: null },
            select: { id: true },
          })
        : Promise.resolve(null),
    ]);
    if (dto.brandId && !brand) throw new BadRequestException('Бренд не знайдено');
    if (dto.unitId && !unit) throw new BadRequestException('Одиницю виміру не знайдено');
    if (dto.preferredSupplierId && !supplier)
      throw new BadRequestException('Постачальника не знайдено');
    if (dto.goodCategoryId && !goodCategory)
      throw new BadRequestException('Категорію товарів не знайдено');
  }

  // ─── Barcodes ────────────────────────────────────────────────────────────────

  async getBarcodes(orgId: string, goodId: string): Promise<GoodBarcodeResponseDto[]> {
    // Same-aggregate parent + child: tenant-safe to parallelize (-1 RTT).
    const [good, barcodes] = await Promise.all([
      this.prisma.good.findFirst({
        where: { id: goodId, orgId, deletedAt: null },
        select: { id: true },
      }),
      this.prisma.goodBarcode.findMany({
        where: { orgId, goodId },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
    ]);
    if (!good) throw new NotFoundException('Товар не знайдено');
    return barcodes.map(b => this.toBarcodeDto(b));
  }

  async createBarcode(
    orgId: string,
    goodId: string,
    dto: CreateGoodBarcodeDto,
  ): Promise<GoodBarcodeResponseDto> {
    if (!dto.barcode || !dto.barcode.trim()) {
      throw new BadRequestException('Штрихкод не може бути порожнім');
    }

    // Parallel: parent-good guard + duplicate-barcode check — independent reads.
    const [good, existing] = await Promise.all([
      this.prisma.good.findFirst({
        where: { id: goodId, orgId, deletedAt: null },
        select: { id: true },
      }),
      this.prisma.goodBarcode.findFirst({
        where: { orgId, barcode: dto.barcode },
        select: { id: true },
      }),
    ]);
    if (!good) throw new NotFoundException('Товар не знайдено');
    if (existing) {
      throw new ConflictException('Штрихкод уже використовується');
    }

    // Bug #356: коли створюється новий isPrimary=true → unset попередні primary
    // у тому ж goodId scope атомарно. Без цього multiple primaries у good.
    const barcode = dto.isPrimary
      ? await this.prisma.$transaction(async tx => {
          await tx.goodBarcode.updateMany({
            where: { orgId, goodId, isPrimary: true },
            data: { isPrimary: false },
          });
          return tx.goodBarcode.create({
            data: {
              orgId,
              goodId,
              barcode: dto.barcode.trim(),
              type: dto.type ?? 'EAN13',
              isPrimary: true,
            },
          });
        })
      : await this.prisma.goodBarcode.create({
          data: {
            orgId,
            goodId,
            barcode: dto.barcode.trim(),
            type: dto.type ?? 'EAN13',
            isPrimary: false,
          },
        });
    return this.toBarcodeDto(barcode);
  }

  async deleteBarcode(orgId: string, goodId: string, barcodeId: string): Promise<void> {
    // Bug #356: якщо видаляємо `isPrimary=true` barcode → auto-promote next active
    // sibling як новий primary. Інакше товар може залишитись без primary barcode,
    // що ламає POS scan-resolution і print-label «головний» convention.
    // Patern Bug #351 (CounterpartyContract auto-promote).
    const existing = await this.prisma.goodBarcode.findFirst({
      where: { id: barcodeId, orgId, goodId },
      select: { id: true, isPrimary: true },
    });
    if (!existing) throw new NotFoundException('Штрихкод не знайдено');

    await this.prisma.$transaction(async tx => {
      // Defense-in-depth: deleteMany with compound where (race-safe).
      await tx.goodBarcode.deleteMany({ where: { id: barcodeId, orgId, goodId } });
      if (existing.isPrimary) {
        const next = await tx.goodBarcode.findFirst({
          where: { orgId, goodId, id: { not: barcodeId } },
          orderBy: { createdAt: 'asc' },
          select: { id: true },
        });
        if (next) {
          await tx.goodBarcode.updateMany({
            where: { id: next.id, orgId, goodId },
            data: { isPrimary: true },
          });
        }
      }
    });
  }

  // ─── Good UoM ──────────────────────────────────────────────────────────────

  async getUoMs(orgId: string, goodId: string): Promise<GoodUoMResponseDto[]> {
    // Same-aggregate parent + child sequential read — collapse у Promise.all (-1 RTT).
    // goodUoM.findMany has orgId+goodId where, so it's tenant-safe even without parent guard.
    const [good, uoms] = await Promise.all([
      this.prisma.good.findFirst({
        where: { id: goodId, orgId, deletedAt: null },
        select: { id: true },
      }),
      this.prisma.goodUoM.findMany({
        where: { orgId, goodId },
        select: {
          id: true,
          unitOfMeasureId: true,
          isDefault: true,
          coefficient: true,
          width: true,
          height: true,
          depth: true,
          volume: true,
          weight: true,
          unitOfMeasure: { select: { name: true, shortName: true } },
        },
        orderBy: { isDefault: 'desc' },
        // Safety cap — typical good has 1-5 UoMs; this prevents OOM if a
        // bulk-import migration ever wires the same good to hundreds of UoMs.
        take: 50,
      }),
    ]);
    if (!good) throw new NotFoundException('Товар не знайдено');
    return uoms.map(u => this.toUoMDto(u));
  }

  async addUoM(orgId: string, goodId: string, dto: CreateGoodUoMDto): Promise<GoodUoMResponseDto> {
    const [good, unit] = await Promise.all([
      this.prisma.good.findFirst({ where: { id: goodId, orgId, deletedAt: null } }),
      this.prisma.unitOfMeasure.findFirst({
        where: { id: dto.unitOfMeasureId, orgId, deletedAt: null },
      }),
    ]);
    if (!good) throw new NotFoundException('Товар не знайдено');
    if (!unit) throw new NotFoundException('Одиницю виміру не знайдено');

    // Parallel: existing-row dup check + count of all UoMs for this good — independent reads.
    const [existing, count] = await Promise.all([
      this.prisma.goodUoM.findFirst({
        where: { orgId, goodId, unitOfMeasureId: dto.unitOfMeasureId },
        select: { id: true },
      }),
      this.prisma.goodUoM.count({ where: { orgId, goodId } }),
    ]);
    if (existing) throw new ConflictException('Ця одиниця виміру вже додана до товару');
    const isFirst = count === 0;

    let uom;
    try {
      uom = await this.prisma.$transaction(
        async tx => {
          const created = await tx.goodUoM.create({
            data: {
              orgId,
              goodId,
              unitOfMeasureId: dto.unitOfMeasureId,
              isDefault: isFirst,
              // If caller provided explicit values — use them; otherwise fall back
              // to UnitOfMeasure template so the per-good coefficient starts with
              // a sensible default (editable afterwards).
              coefficient: dto.coefficient ?? unit.coefficient,
              width: dto.width ?? unit.width,
              height: dto.height ?? unit.height,
              depth: dto.depth ?? unit.depth,
              volume: dto.volume ?? unit.volume,
              weight: dto.weight ?? unit.weight,
            },
            select: {
              id: true,
              unitOfMeasureId: true,
              isDefault: true,
              coefficient: true,
              width: true,
              height: true,
              depth: true,
              volume: true,
              weight: true,
              unitOfMeasure: { select: { name: true, shortName: true } },
            },
          });
          if (isFirst) {
            // Bug #224: defense-in-depth — updateMany with orgId guard so any future
            // refactor that loses the goodId/orgId pre-check cannot cross-tenant write.
            await tx.good.updateMany({
              where: { id: goodId, orgId, deletedAt: null },
              data: { unitId: dto.unitOfMeasureId, unit: unit.shortName },
            });
          }
          return created;
        },
        { timeout: TRANSACTION_TIMEOUT_MS },
      );
    } catch (e) {
      // Bug #225: TOCTOU between `existing`/`count` precheck and `tx.create` —
      // two concurrent identical adds both pass precheck and one hits the
      // (orgId, goodId, unitOfMeasureId) unique constraint. Map P2002 to a
      // friendly Conflict (HTTP 409) instead of leaking Prisma 500.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('Ця одиниця виміру вже додана до товару');
      }
      throw e;
    }

    return this.toUoMDto(uom);
  }

  async setDefaultUoM(orgId: string, goodId: string, uomId: string): Promise<GoodUoMResponseDto> {
    // Bug #223: validate Good itself exists and is not soft-deleted in this org
    // before mutating any UoM rows for it. Parallel parent-guard + child-fetch (-1 RTT).
    const [good, uom] = await Promise.all([
      this.prisma.good.findFirst({
        where: { id: goodId, orgId, deletedAt: null },
        select: { id: true },
      }),
      this.prisma.goodUoM.findFirst({
        where: { id: uomId, orgId, goodId },
        select: {
          id: true,
          unitOfMeasureId: true,
          isDefault: true,
          coefficient: true,
          width: true,
          height: true,
          depth: true,
          volume: true,
          weight: true,
          unitOfMeasure: { select: { name: true, shortName: true } },
        },
      }),
    ]);
    if (!good) throw new NotFoundException('Товар не знайдено');
    if (!uom) throw new NotFoundException('Запис одиниці виміру не знайдено');

    await this.prisma.$transaction([
      this.prisma.goodUoM.updateMany({ where: { orgId, goodId }, data: { isDefault: false } }),
      this.prisma.goodUoM.update({ where: { id: uomId }, data: { isDefault: true } }),
      // Bug #224: defense-in-depth — updateMany with orgId+deletedAt guard.
      this.prisma.good.updateMany({
        where: { id: goodId, orgId, deletedAt: null },
        data: { unitId: uom.unitOfMeasureId, unit: uom.unitOfMeasure.shortName },
      }),
    ]);

    return this.toUoMDto({ ...uom, isDefault: true });
  }

  async removeUoM(orgId: string, goodId: string, uomId: string): Promise<void> {
    // Bug #223: ensure parent Good is in this org and not soft-deleted.
    // Parallel parent-guard + uom-fetch + count (-2 RTT vs sequential).
    const [good, uom, total] = await Promise.all([
      this.prisma.good.findFirst({
        where: { id: goodId, orgId, deletedAt: null },
        select: { id: true },
      }),
      this.prisma.goodUoM.findFirst({
        where: { id: uomId, orgId, goodId },
        select: { id: true, isDefault: true },
      }),
      this.prisma.goodUoM.count({ where: { orgId, goodId } }),
    ]);
    if (!good) throw new NotFoundException('Товар не знайдено');
    if (!uom) throw new NotFoundException('Запис одиниці виміру не знайдено');
    if (total === 1) throw new BadRequestException('Не можна видалити єдину одиницю виміру');

    await this.prisma.$transaction(
      async tx => {
        // Defense-in-depth: atomic deleteMany with compound where (sto-review pattern 2026-05-30)
        // so any future refactor that loses the upstream guard cannot cross-tenant delete.
        await tx.goodUoM.deleteMany({ where: { id: uomId, orgId, goodId } });
        if (uom.isDefault) {
          const next = await tx.goodUoM.findFirst({
            where: { orgId, goodId },
            select: {
              id: true,
              unitOfMeasureId: true,
              unitOfMeasure: { select: { shortName: true } },
            },
            orderBy: { createdAt: 'asc' },
          });
          if (next) {
            // Defense-in-depth: updateMany with compound where (sto-review pattern 2026-05-30).
            await tx.goodUoM.updateMany({
              where: { id: next.id, orgId, goodId },
              data: { isDefault: true },
            });
            // Bug #224: defense-in-depth — updateMany with orgId+deletedAt guard.
            await tx.good.updateMany({
              where: { id: goodId, orgId, deletedAt: null },
              data: { unitId: next.unitOfMeasureId, unit: next.unitOfMeasure.shortName },
            });
          }
        }
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    );
  }

  async updateUoM(
    orgId: string,
    goodId: string,
    uomId: string,
    dto: UpdateGoodUoMDto,
  ): Promise<GoodUoMResponseDto> {
    const [good, uom] = await Promise.all([
      this.prisma.good.findFirst({
        where: { id: goodId, orgId, deletedAt: null },
        select: { id: true },
      }),
      this.prisma.goodUoM.findFirst({
        where: { id: uomId, goodId, orgId },
        select: { id: true },
      }),
    ]);
    if (!good) throw new NotFoundException('Товар не знайдено');
    if (!uom) throw new NotFoundException('Одиницю виміру товару не знайдено');

    const updated = await this.prisma.goodUoM.update({
      where: { id: uomId },
      data: dto,
      select: {
        id: true,
        unitOfMeasureId: true,
        isDefault: true,
        coefficient: true,
        width: true,
        height: true,
        depth: true,
        volume: true,
        weight: true,
        unitOfMeasure: { select: { name: true, shortName: true } },
      },
    });
    return this.toUoMDto(updated);
  }

  private toUoMDto(u: {
    id: string;
    unitOfMeasureId: string;
    isDefault: boolean;
    coefficient: number;
    width?: number | null;
    height?: number | null;
    depth?: number | null;
    volume?: number | null;
    weight?: number | null;
    unitOfMeasure: { name: string; shortName: string };
  }): GoodUoMResponseDto {
    return {
      id: u.id,
      unitOfMeasureId: u.unitOfMeasureId,
      unitName: u.unitOfMeasure.name,
      unitShortName: u.unitOfMeasure.shortName,
      coefficient: u.coefficient,
      isDefault: u.isDefault,
      width: u.width,
      height: u.height,
      depth: u.depth,
      volume: u.volume,
      weight: u.weight,
    };
  }

  private toBarcodeDto(b: {
    id: string;
    orgId: string;
    goodId: string;
    barcode: string;
    type: string;
    isPrimary: boolean;
    createdAt: Date;
  }): GoodBarcodeResponseDto {
    return {
      id: b.id,
      orgId: b.orgId,
      goodId: b.goodId,
      barcode: b.barcode,
      type: b.type,
      isPrimary: b.isPrimary,
      createdAt: b.createdAt,
    };
  }

  private toDto(item: {
    id: string;
    orgId: string;
    sku: string | null;
    name: string;
    unit: string;
    unitId?: string | null;
    brandId?: string | null;
    goodCategoryId?: string | null;
    purchasePrice: import('@prisma/client').Prisma.Decimal | null;
    salePrice: import('@prisma/client').Prisma.Decimal;
    category: string | null;
    barcode: string | null;
    notes: string | null;
    goodType: import('@prisma/client').GoodType | null;
    preferredSupplierId: string | null;
    preferredSupplier?: {
      firstName: string | null;
      lastName: string | null;
      companyName: string | null;
    } | null;
    goodCategory?: { id: string; name: string } | null;
    deletedAt?: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }): GoodResponseDto {
    return {
      id: item.id,
      orgId: item.orgId,
      sku: item.sku ?? null,
      name: item.name,
      unit: item.unit,
      unitId: item.unitId ?? null,
      brandId: item.brandId ?? null,
      purchasePrice: item.purchasePrice != null ? Number(item.purchasePrice) : null,
      salePrice: Number(item.salePrice),
      category: item.category ?? null,
      goodCategoryId: item.goodCategoryId ?? null,
      goodCategoryName: item.goodCategory?.name ?? null,
      barcode: item.barcode ?? null,
      notes: item.notes ?? null,
      goodType: item.goodType ?? null,
      preferredSupplierId: item.preferredSupplierId ?? null,
      preferredSupplierName: item.preferredSupplier
        ? (item.preferredSupplier.companyName ??
          (`${item.preferredSupplier.lastName ?? ''} ${item.preferredSupplier.firstName ?? ''}`.trim() ||
            null))
        : null,
      deletedAt: item.deletedAt ?? null,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  }

  async stockTotals(
    orgId: string,
    goodIds: string[],
  ): Promise<{ goodId: string; totalQuantity: number }[]> {
    if (goodIds.length === 0) return [];
    const rows = await this.prisma.stockItem.groupBy({
      by: ['goodId'],
      where: { orgId, goodId: { in: goodIds }, deletedAt: null },
      _sum: { quantity: true },
    });
    return rows.map(r => ({
      goodId: r.goodId,
      totalQuantity: Number(r._sum.quantity ?? 0),
    }));
  }
}
