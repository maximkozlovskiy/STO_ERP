import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CreateWorkDto,
  UpdateWorkDto,
  WorkQueryDto,
  WorkResponseDto,
  PaginatedWorksDto,
} from './works.dto';

@Injectable()
export class WorksService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(orgId: string, query: WorkQueryDto): Promise<PaginatedWorksDto> {
    const where: Prisma.WorkWhereInput = {
      orgId,
      ...(query.showDeleted ? {} : { deletedAt: null }),
    };
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

    return {
      items: items.map(item => this.toDto(item)),
      total,
      page: query.page,
      limit: query.limit,
    };
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
      data: { ...dto, orgId, price: dto.price },
      include: { category: { select: { name: true } } },
    });
    return this.toDto(item);
  }

  async update(orgId: string, id: string, dto: UpdateWorkDto): Promise<WorkResponseDto> {
    // Parallel tenant guard + optional category FK check — independent reads (-1 RTT).
    const [existing, category] = await Promise.all([
      this.prisma.work.findFirst({
        where: { id, orgId, deletedAt: null },
        select: { id: true },
      }),
      dto.categoryId
        ? this.prisma.workCategory.findFirst({
            where: { id: dto.categoryId, orgId, deletedAt: null },
            select: { id: true },
          })
        : Promise.resolve(null as { id: string } | null),
    ]);
    if (!existing) throw new NotFoundException('Роботу не знайдено');
    if (dto.categoryId && !category) throw new NotFoundException('Категорію не знайдено');

    const item = await this.prisma.work.update({
      where: { id, orgId },
      data: dto,
      include: { category: { select: { name: true } } },
    });
    return this.toDto(item);
  }

  async findCategoryByName(orgId: string, name: string): Promise<{ id: string } | null> {
    return this.prisma.workCategory.findFirst({
      where: { orgId, name: { equals: name, mode: 'insensitive' }, deletedAt: null },
      select: { id: true },
    });
  }

  async remove(orgId: string, id: string): Promise<void> {
    await this.findOne(orgId, id);
    await this.prisma.work.update({ where: { id, orgId }, data: { deletedAt: new Date() } });
  }

  async restore(orgId: string, id: string): Promise<WorkResponseDto> {
    const existing = await this.prisma.work.findFirst({
      where: { id, orgId, NOT: { deletedAt: null } },
      include: { category: { select: { name: true } } },
    });
    if (!existing) throw new NotFoundException('Видалену роботу не знайдено');
    const item = await this.prisma.work.update({
      where: { id, orgId },
      data: { deletedAt: null },
      include: { category: { select: { name: true } } },
    });
    return this.toDto(item);
  }

  private toDto(item: {
    id: string;
    orgId: string;
    categoryId: string;
    name: string;
    normoHours: number;
    price: import('@prisma/client').Prisma.Decimal;
    description: string | null;
    isWarranty: boolean;
    deletedAt?: Date | null;
    createdAt: Date;
    updatedAt: Date;
    category: { name: string };
  }): WorkResponseDto {
    return {
      id: item.id,
      orgId: item.orgId,
      categoryId: item.categoryId,
      categoryName: item.category.name,
      name: item.name,
      normoHours: item.normoHours,
      price: Number(item.price),
      description: item.description ?? null,
      isWarranty: item.isWarranty,
      deletedAt: item.deletedAt ?? null,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  }
}
