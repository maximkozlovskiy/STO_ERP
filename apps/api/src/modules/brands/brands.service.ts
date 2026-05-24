import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { BrandResponseDto, CreateBrandDto, UpdateBrandDto } from './brands.dto';

@Injectable()
export class BrandsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(orgId: string): Promise<BrandResponseDto[]> {
    const items = await this.prisma.brand.findMany({
      where: { orgId, deletedAt: null },
      orderBy: { name: 'asc' },
      take: 1000,
    });
    return items.map(item => this.toDto(item));
  }

  async findOne(orgId: string, id: string): Promise<BrandResponseDto> {
    const item = await this.prisma.brand.findFirst({
      where: { id, orgId, deletedAt: null },
    });
    if (!item) throw new NotFoundException('Бренд не знайдено');
    return this.toDto(item);
  }

  async create(orgId: string, dto: CreateBrandDto): Promise<BrandResponseDto> {
    const existing = await this.prisma.brand.findFirst({
      where: { orgId, name: dto.name, deletedAt: null },
    });
    if (existing) {
      throw new ConflictException('Бренд з такою назвою вже існує');
    }

    const item = await this.prisma.brand.create({
      data: { ...dto, orgId },
    });
    return this.toDto(item);
  }

  async update(orgId: string, id: string, dto: UpdateBrandDto): Promise<BrandResponseDto> {
    const existing = await this.prisma.brand.findFirst({ where: { id, orgId, deletedAt: null } });
    if (!existing) throw new NotFoundException('Бренд не знайдено');

    const duplicate = await this.prisma.brand.findFirst({
      where: { orgId, name: dto.name, NOT: { id }, deletedAt: null },
    });
    if (duplicate) {
      throw new ConflictException('Бренд з такою назвою вже існує');
    }

    const item = await this.prisma.brand.update({
      where: { id, orgId },
      data: dto,
    });
    return this.toDto(item);
  }

  async remove(orgId: string, id: string): Promise<void> {
    const existing = await this.prisma.brand.findFirst({ where: { id, orgId, deletedAt: null } });
    if (!existing) throw new NotFoundException('Бренд не знайдено');
    await this.prisma.brand.update({
      where: { id, orgId },
      data: { deletedAt: new Date() },
    });
  }

  private toDto(item: {
    id: string; orgId: string; name: string; createdAt: Date; updatedAt: Date;
  }): BrandResponseDto {
    return {
      id: item.id, orgId: item.orgId, name: item.name,
      createdAt: item.createdAt, updatedAt: item.updatedAt,
    };
  }
}
