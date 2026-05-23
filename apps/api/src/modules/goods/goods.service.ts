import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateGoodDto, UpdateGoodDto, GoodQueryDto, GoodResponseDto, PaginatedGoodsDto } from './goods.dto';

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
    const [items, total] = await this.prisma.$transaction([
      this.prisma.good.findMany({ where, orderBy: { name: 'asc' }, skip, take: query.limit }),
      this.prisma.good.count({ where }),
    ]);

    return { items: items.map(this.toDto), total, page: query.page, limit: query.limit };
  }

  async findOne(orgId: string, id: string): Promise<GoodResponseDto> {
    const item = await this.prisma.good.findFirst({ where: { id, orgId, deletedAt: null } });
    if (!item) throw new NotFoundException('Товар не знайдено');
    return this.toDto(item);
  }

  async create(orgId: string, dto: CreateGoodDto): Promise<GoodResponseDto> {
    if (dto.sku) {
      const existing = await this.prisma.good.findFirst({ where: { orgId, sku: dto.sku, deletedAt: null } });
      if (existing) throw new ConflictException(`Товар з артикулом "${dto.sku}" вже існує`);
    }
    const item = await this.prisma.good.create({
      data: { orgId, ...dto, unit: dto.unit ?? 'шт' },
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
    const item = await this.prisma.good.update({ where: { id, orgId }, data: dto });
    return this.toDto(item);
  }

  async remove(orgId: string, id: string): Promise<void> {
    await this.prisma.good.update({ where: { id, orgId }, data: { deletedAt: new Date() } });
  }

  private toDto(item: any): GoodResponseDto {
    return {
      id: item.id,
      orgId: item.orgId,
      sku: item.sku ?? null,
      name: item.name,
      unit: item.unit,
      purchasePrice: item.purchasePrice != null ? Number(item.purchasePrice) : null,
      salePrice: Number(item.salePrice),
      category: item.category ?? null,
      barcode: item.barcode ?? null,
      notes: item.notes ?? null,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  }
}
