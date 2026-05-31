import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CreateGoodDto,
  UpdateGoodDto,
  GoodQueryDto,
  GoodResponseDto,
  PaginatedGoodsDto,
  CreateGoodUoMDto,
  GoodUoMResponseDto,
} from './goods.dto';
import { CreateGoodBarcodeDto, GoodBarcodeResponseDto } from './barcodes.dto';

@Injectable()
export class GoodsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(orgId: string, query: GoodQueryDto): Promise<PaginatedGoodsDto> {
    const where: Prisma.GoodWhereInput = { orgId, deletedAt: null };
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

    const skip = (query.page - 1) * query.limit;
    const supplierSelect = {
      select: { firstName: true, lastName: true, companyName: true },
    } as const;
    const [items, total] = await this.prisma.$transaction([
      this.prisma.good.findMany({
        where,
        orderBy: { name: 'asc' },
        skip,
        take: query.limit,
        include: { preferredSupplier: supplierSelect },
      }),
      this.prisma.good.count({ where }),
    ]);

    return {
      items: items.map(item => this.toDto(item)),
      total,
      page: query.page,
      limit: query.limit,
    };
  }

  async findOne(orgId: string, id: string): Promise<GoodResponseDto> {
    const item = await this.prisma.good.findFirst({
      where: { id, orgId, deletedAt: null },
      include: {
        preferredSupplier: { select: { firstName: true, lastName: true, companyName: true } },
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
      data: { ...dto, orgId, unit: dto.unit ?? 'шт' },
      include: {
        preferredSupplier: { select: { firstName: true, lastName: true, companyName: true } },
      },
    });
    return this.toDto(item);
  }

  async update(orgId: string, id: string, dto: UpdateGoodDto): Promise<GoodResponseDto> {
    // Parallel: tenant guard (findOne) + sku-uniqueness + FK validation — три незалежні precheck-и.
    const [, skuConflict] = await Promise.all([
      this.findOne(orgId, id), // throws NotFoundException якщо відсутній
      dto.sku
        ? this.prisma.good.findFirst({
            where: { orgId, sku: dto.sku, deletedAt: null, NOT: { id } },
            select: { id: true },
          })
        : Promise.resolve(null),
      this.validateFkReferences(orgId, dto),
    ]);
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
    await this.findOne(orgId, id);
    await this.prisma.good.update({ where: { id, orgId }, data: { deletedAt: new Date() } });
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
    dto: { brandId?: string | null; unitId?: string | null; preferredSupplierId?: string | null },
  ): Promise<void> {
    const [brand, unit, supplier] = await Promise.all([
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
    ]);
    if (dto.brandId && !brand) throw new BadRequestException('Бренд не знайдено');
    if (dto.unitId && !unit) throw new BadRequestException('Одиницю виміру не знайдено');
    if (dto.preferredSupplierId && !supplier)
      throw new BadRequestException('Постачальника не знайдено');
  }

  // ─── Barcodes ────────────────────────────────────────────────────────────────

  async getBarcodes(orgId: string, goodId: string): Promise<GoodBarcodeResponseDto[]> {
    await this.findOne(orgId, goodId);
    const barcodes = await this.prisma.goodBarcode.findMany({
      where: { orgId, goodId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return barcodes.map(b => this.toBarcodeDto(b));
  }

  async createBarcode(
    orgId: string,
    goodId: string,
    dto: CreateGoodBarcodeDto,
  ): Promise<GoodBarcodeResponseDto> {
    await this.findOne(orgId, goodId);

    if (!dto.barcode || !dto.barcode.trim()) {
      throw new BadRequestException('Штрихкод не може бути порожнім');
    }

    const existing = await this.prisma.goodBarcode.findFirst({
      where: { orgId, barcode: dto.barcode },
    });
    if (existing) {
      throw new ConflictException('Штрихкод уже використовується');
    }

    const barcode = await this.prisma.goodBarcode.create({
      data: {
        orgId,
        goodId,
        barcode: dto.barcode.trim(),
        type: dto.type ?? 'EAN13',
        isPrimary: dto.isPrimary ?? false,
      },
    });
    return this.toBarcodeDto(barcode);
  }

  async deleteBarcode(orgId: string, goodId: string, barcodeId: string): Promise<void> {
    const barcode = await this.prisma.goodBarcode.findFirst({
      where: { id: barcodeId, orgId, goodId },
    });
    if (!barcode) throw new NotFoundException('Штрихкод не знайдено');

    await this.prisma.goodBarcode.delete({ where: { id: barcodeId } });
  }

  // ─── Good UoM ──────────────────────────────────────────────────────────────

  async getUoMs(orgId: string, goodId: string): Promise<GoodUoMResponseDto[]> {
    const good = await this.prisma.good.findFirst({
      where: { id: goodId, orgId, deletedAt: null },
    });
    if (!good) throw new NotFoundException('Товар не знайдено');
    const uoms = await this.prisma.goodUoM.findMany({
      where: { orgId, goodId },
      include: { unitOfMeasure: true },
      orderBy: { isDefault: 'desc' },
    });
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

    const existing = await this.prisma.goodUoM.findFirst({
      where: { orgId, goodId, unitOfMeasureId: dto.unitOfMeasureId },
    });
    if (existing) throw new ConflictException('Ця одиниця виміру вже додана до товару');

    const count = await this.prisma.goodUoM.count({ where: { orgId, goodId } });
    const isFirst = count === 0;

    let uom;
    try {
      uom = await this.prisma.$transaction(
        async tx => {
          const created = await tx.goodUoM.create({
            data: { orgId, goodId, unitOfMeasureId: dto.unitOfMeasureId, isDefault: isFirst },
            include: { unitOfMeasure: true },
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
        { timeout: 5_000 },
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
    // before mutating any UoM rows for it (admin could otherwise mutate a deleted Good).
    await this.findOne(orgId, goodId);

    const uom = await this.prisma.goodUoM.findFirst({
      where: { id: uomId, orgId, goodId },
      include: { unitOfMeasure: true },
    });
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
    await this.findOne(orgId, goodId);

    const uom = await this.prisma.goodUoM.findFirst({ where: { id: uomId, orgId, goodId } });
    if (!uom) throw new NotFoundException('Запис одиниці виміру не знайдено');

    const total = await this.prisma.goodUoM.count({ where: { orgId, goodId } });
    if (total === 1) throw new BadRequestException('Не можна видалити єдину одиницю виміру');

    await this.prisma.$transaction(
      async tx => {
        await tx.goodUoM.delete({ where: { id: uomId } });
        if (uom.isDefault) {
          const next = await tx.goodUoM.findFirst({
            where: { orgId, goodId },
            include: { unitOfMeasure: true },
            orderBy: { createdAt: 'asc' },
          });
          if (next) {
            await tx.goodUoM.update({ where: { id: next.id }, data: { isDefault: true } });
            // Bug #224: defense-in-depth — updateMany with orgId+deletedAt guard.
            await tx.good.updateMany({
              where: { id: goodId, orgId, deletedAt: null },
              data: { unitId: next.unitOfMeasureId, unit: next.unitOfMeasure.shortName },
            });
          }
        }
      },
      { timeout: 5_000 },
    );
  }

  private toUoMDto(u: {
    id: string;
    unitOfMeasureId: string;
    isDefault: boolean;
    unitOfMeasure: { name: string; shortName: string; coefficient: number };
  }): GoodUoMResponseDto {
    return {
      id: u.id,
      unitOfMeasureId: u.unitOfMeasureId,
      unitName: u.unitOfMeasure.name,
      unitShortName: u.unitOfMeasure.shortName,
      coefficient: u.unitOfMeasure.coefficient,
      isDefault: u.isDefault,
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
      barcode: item.barcode ?? null,
      notes: item.notes ?? null,
      goodType: item.goodType ?? null,
      preferredSupplierId: item.preferredSupplierId ?? null,
      preferredSupplierName: item.preferredSupplier
        ? (item.preferredSupplier.companyName ??
          (`${item.preferredSupplier.lastName ?? ''} ${item.preferredSupplier.firstName ?? ''}`.trim() ||
            null))
        : null,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  }
}
