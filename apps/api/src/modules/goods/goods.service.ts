import { Injectable, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateGoodDto, UpdateGoodDto, GoodQueryDto, GoodResponseDto, PaginatedGoodsDto } from './goods.dto';
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
    const supplierSelect = { select: { firstName: true, lastName: true, companyName: true } } as const;
    const [items, total] = await this.prisma.$transaction([
      this.prisma.good.findMany({
        where, orderBy: { name: 'asc' }, skip, take: query.limit,
        include: { preferredSupplier: supplierSelect },
      }),
      this.prisma.good.count({ where }),
    ]);

    return { items: items.map(item => this.toDto(item)), total, page: query.page, limit: query.limit };
  }

  async findOne(orgId: string, id: string): Promise<GoodResponseDto> {
    const item = await this.prisma.good.findFirst({
      where: { id, orgId, deletedAt: null },
      include: { preferredSupplier: { select: { firstName: true, lastName: true, companyName: true } } },
    });
    if (!item) throw new NotFoundException('Товар не знайдено');
    return this.toDto(item);
  }

  async create(orgId: string, dto: CreateGoodDto): Promise<GoodResponseDto> {
    if (dto.sku) {
      const existing = await this.prisma.good.findFirst({ where: { orgId, sku: dto.sku, deletedAt: null } });
      if (existing) throw new ConflictException(`Товар з артикулом "${dto.sku}" вже існує`);
    }
    const item = await this.prisma.good.create({
      data: { ...dto, orgId, unit: dto.unit ?? 'шт' },
      include: { preferredSupplier: { select: { firstName: true, lastName: true, companyName: true } } },
    });
    return this.toDto(item);
  }

  async update(orgId: string, id: string, dto: UpdateGoodDto): Promise<GoodResponseDto> {
    await this.findOne(orgId, id);
    if (dto.sku) {
      const existing = await this.prisma.good.findFirst({
        where: { orgId, sku: dto.sku, deletedAt: null, NOT: { id } },
      });
      if (existing) throw new ConflictException(`Товар з артикулом "${dto.sku}" вже існує`);
    }
    const item = await this.prisma.good.update({
      where: { id, orgId }, data: dto,
      include: { preferredSupplier: { select: { firstName: true, lastName: true, companyName: true } } },
    });
    return this.toDto(item);
  }

  async remove(orgId: string, id: string): Promise<void> {
    await this.findOne(orgId, id);
    await this.prisma.good.update({ where: { id, orgId }, data: { deletedAt: new Date() } });
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

  async createBarcode(orgId: string, goodId: string, dto: CreateGoodBarcodeDto): Promise<GoodBarcodeResponseDto> {
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

  private toBarcodeDto(b: {
    id: string; orgId: string; goodId: string; barcode: string; type: string; isPrimary: boolean; createdAt: Date;
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
    id: string; orgId: string; sku: string | null; name: string; unit: string;
    unitId?: string | null; brandId?: string | null;
    purchasePrice: import('@prisma/client').Prisma.Decimal | null; salePrice: import('@prisma/client').Prisma.Decimal; category: string | null;
    barcode: string | null; notes: string | null;
    goodType: import('@prisma/client').GoodType | null;
    preferredSupplierId: string | null;
    preferredSupplier?: { firstName: string | null; lastName: string | null; companyName: string | null } | null;
    createdAt: Date; updatedAt: Date;
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
        ? (item.preferredSupplier.companyName ?? (`${item.preferredSupplier.lastName ?? ''} ${item.preferredSupplier.firstName ?? ''}`.trim() || null))
        : null,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  }
}
