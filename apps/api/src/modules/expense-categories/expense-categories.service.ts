import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../redis/cache.service';
import {
  CreateExpenseCategoryDto,
  ExpenseCategoryResponseDto,
  UpdateExpenseCategoryDto,
} from './expense-categories.dto';

const TTL = 300;
const cacheKey = (orgId: string) => `ref:expense-categories:${orgId}`;

/**
 * Довідник статей витрат (per-org). Дзеркалить GoodStatusesService (без color/count):
 * findAll(cache)/findOne/create(resurrect-vs-409)/update/restore(active-dup 409)/remove(atomic soft-delete),
 * tenant-isolated, P2002→409.
 */
@Injectable()
export class ExpenseCategoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  async findAll(
    orgId: string,
    showDeleted = false,
  ): Promise<{ items: ExpenseCategoryResponseDto[]; total: number }> {
    if (!showDeleted) {
      const cached = await this.cache.get<{ items: ExpenseCategoryResponseDto[]; total: number }>(
        cacheKey(orgId),
      );
      if (cached) return cached;
    }
    const where = { orgId, ...(showDeleted ? {} : { deletedAt: null }) };
    const [items, total] = await Promise.all([
      this.prisma.expenseCategory.findMany({
        where,
        orderBy: [{ deletedAt: { sort: 'asc', nulls: 'first' } }, { name: 'asc' }],
        take: 1000,
      }),
      this.prisma.expenseCategory.count({ where }),
    ]);
    const result = { items: items.map(i => this.toDto(i)), total };
    if (!showDeleted) await this.cache.set(cacheKey(orgId), result, TTL);
    return result;
  }

  async findOne(orgId: string, id: string): Promise<ExpenseCategoryResponseDto> {
    const item = await this.prisma.expenseCategory.findFirst({
      where: { id, orgId, deletedAt: null },
    });
    if (!item) throw new NotFoundException('Статтю витрат не знайдено');
    return this.toDto(item);
  }

  async create(orgId: string, dto: CreateExpenseCategoryDto): Promise<ExpenseCategoryResponseDto> {
    const anyExisting = await this.prisma.expenseCategory.findFirst({
      where: { orgId, name: dto.name },
      select: { id: true, deletedAt: true },
    });
    if (anyExisting) {
      if (!anyExisting.deletedAt)
        throw new ConflictException('Стаття витрат з такою назвою вже існує');
      await this.prisma.expenseCategory.update({
        where: { id: anyExisting.id, orgId },
        data: { name: dto.name, deletedAt: null },
      });
      const item = await this.prisma.expenseCategory.findFirstOrThrow({
        where: { id: anyExisting.id, orgId },
      });
      await this.cache.del(cacheKey(orgId));
      return this.toDto(item);
    }
    const item = await this.prisma.expenseCategory.create({ data: { name: dto.name, orgId } });
    await this.cache.del(cacheKey(orgId));
    return this.toDto(item);
  }

  async update(
    orgId: string,
    id: string,
    dto: UpdateExpenseCategoryDto,
  ): Promise<ExpenseCategoryResponseDto> {
    const [existing, duplicate] = await Promise.all([
      this.prisma.expenseCategory.findFirst({
        where: { id, orgId, deletedAt: null },
        select: { id: true },
      }),
      this.prisma.expenseCategory.findFirst({
        where: { orgId, name: dto.name, NOT: { id }, deletedAt: null },
        select: { id: true },
      }),
    ]);
    if (!existing) throw new NotFoundException('Статтю витрат не знайдено');
    if (duplicate) throw new ConflictException('Стаття витрат з такою назвою вже існує');
    await this.prisma.expenseCategory.update({ where: { id, orgId }, data: { name: dto.name } });
    const item = await this.prisma.expenseCategory.findFirstOrThrow({ where: { id, orgId } });
    await this.cache.del(cacheKey(orgId));
    return this.toDto(item);
  }

  async restore(orgId: string, id: string): Promise<ExpenseCategoryResponseDto> {
    const deleted = await this.prisma.expenseCategory.findFirst({
      where: { id, orgId, NOT: { deletedAt: null } },
      select: { name: true },
    });
    if (!deleted) throw new NotFoundException('Видалену статтю витрат не знайдено');
    const activeDuplicate = await this.prisma.expenseCategory.findFirst({
      where: { orgId, name: deleted.name, deletedAt: null, NOT: { id } },
      select: { id: true },
    });
    if (activeDuplicate)
      throw new ConflictException(
        'Активна стаття витрат з такою назвою вже існує — відновлення неможливе',
      );
    const result = await this.prisma.expenseCategory.updateMany({
      where: { id, orgId, NOT: { deletedAt: null } },
      data: { deletedAt: null },
    });
    if (result.count === 0) throw new NotFoundException('Видалену статтю витрат не знайдено');
    const item = await this.prisma.expenseCategory.findFirstOrThrow({ where: { id, orgId } });
    await this.cache.del(cacheKey(orgId));
    return this.toDto(item);
  }

  async remove(orgId: string, id: string): Promise<void> {
    const result = await this.prisma.expenseCategory.updateMany({
      where: { id, orgId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (result.count === 0) throw new NotFoundException('Статтю витрат не знайдено');
    await this.cache.del(cacheKey(orgId));
  }

  private toDto(item: {
    id: string;
    orgId: string;
    name: string;
    deletedAt?: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }): ExpenseCategoryResponseDto {
    return {
      id: item.id,
      orgId: item.orgId,
      name: item.name,
      deletedAt:
        item.deletedAt instanceof Date ? item.deletedAt.toISOString() : (item.deletedAt ?? null),
      createdAt: item.createdAt instanceof Date ? item.createdAt.toISOString() : item.createdAt,
      updatedAt: item.updatedAt instanceof Date ? item.updatedAt.toISOString() : item.updatedAt,
    };
  }
}
