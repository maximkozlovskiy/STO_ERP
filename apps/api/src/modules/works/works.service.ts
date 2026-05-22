import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateWorkDto, UpdateWorkDto, WorkQueryDto, WorkResponseDto, PaginatedWorksDto } from './works.dto';

@Injectable()
export class WorksService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(orgId: string, query: WorkQueryDto): Promise<PaginatedWorksDto> {
    const where: any = { orgId, deletedAt: null };
    if (query.categoryId) where.categoryId = query.categoryId;
    if (query.q) where.name = { contains: query.q, mode: 'insensitive' };

    const skip = (query.page - 1) * query.limit;
    const [items, total] = await this.prisma.$transaction([
      this.prisma.work.findMany({
        where,
        include: { category: { select: { name: true } } },
        orderBy: { name: 'asc' },
        skip,
        take: query.limit,
      }),
      this.prisma.work.count({ where }),
    ]);

    return { items: items.map(this.toDto), total, page: query.page, limit: query.limit };
  }

  async findOne(orgId: string, id: string): Promise<WorkResponseDto> {
    const item = await this.prisma.work.findFirst({
      where: { id, orgId, deletedAt: null },
      include: { category: { select: { name: true } } },
    });
    if (!item) throw new NotFoundException('Роботу не знайдено');
    return this.toDto(item);
  }

  async create(orgId: string, dto: CreateWorkDto): Promise<WorkResponseDto> {
    const category = await this.prisma.workCategory.findFirst({
      where: { id: dto.categoryId, orgId, deletedAt: null },
    });
    if (!category) throw new NotFoundException('Категорію не знайдено');

    const item = await this.prisma.work.create({
      data: { orgId, ...dto, price: dto.price },
      include: { category: { select: { name: true } } },
    });
    return this.toDto(item);
  }

  async update(orgId: string, id: string, dto: UpdateWorkDto): Promise<WorkResponseDto> {
    await this.findOne(orgId, id);
    if (dto.categoryId) {
      const category = await this.prisma.workCategory.findFirst({
        where: { id: dto.categoryId, orgId, deletedAt: null },
      });
      if (!category) throw new NotFoundException('Категорію не знайдено');
    }
    const item = await this.prisma.work.update({
      where: { id },
      data: dto,
      include: { category: { select: { name: true } } },
    });
    return this.toDto(item);
  }

  async remove(orgId: string, id: string): Promise<void> {
    await this.findOne(orgId, id);
    await this.prisma.work.update({ where: { id }, data: { deletedAt: new Date() } });
  }

  private toDto(item: any): WorkResponseDto {
    return {
      id: item.id,
      orgId: item.orgId,
      categoryId: item.categoryId,
      categoryName: item.category.name,
      name: item.name,
      normoHours: item.normoHours,
      price: Number(item.price),
      description: item.description ?? null,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  }
}
