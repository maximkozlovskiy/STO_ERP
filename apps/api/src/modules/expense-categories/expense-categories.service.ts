import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ExpenseCategoryType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../redis/cache.service';
import {
  CreateExpenseCategoryDto,
  ExpenseCategoryResponseDto,
  UpdateExpenseCategoryDto,
} from './expense-categories.dto';

const TTL = 300;
const cacheKey = (orgId: string) => `ref:expense-categories:${orgId}`;

interface Row {
  id: string;
  orgId: string;
  parentId: string | null;
  name: string;
  type: ExpenseCategoryType;
  sortOrder: number;
  isActive: boolean;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Довідник «Статті руху коштів» (per-org, ієрархічний). Дзеркалить WorkCategoriesService:
 * findAll→buildTree (один findMany, дерево у памʼяті), create з parent-guard і type=parent.type,
 * remove/toggleActive каскадять на нащадків (getDescendantIds — обхід у памʼяті, без N+1).
 * type immutable після create (гілка дерева одного типу). tenant-isolated, resurrect-vs-409.
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
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        take: 1000,
      }),
      this.prisma.expenseCategory.count({ where }),
    ]);
    // Дерево від коренів (parentId=null). showDeleted → плаский список (діти видалених могли б лишитись
    // «сиротами» у дереві), тож для showDeleted віддаємо плоско (children=[]).
    const result = showDeleted
      ? { items: items.map(i => ({ ...this.toDto(i), children: [] })), total }
      : { items: this.buildTree(items as Row[], null), total };
    if (!showDeleted) await this.cache.set(cacheKey(orgId), result, TTL);
    return result;
  }

  async findOne(orgId: string, id: string): Promise<ExpenseCategoryResponseDto> {
    const item = await this.prisma.expenseCategory.findFirst({
      where: { id, orgId, deletedAt: null },
    });
    if (!item) throw new NotFoundException('Статтю не знайдено');
    return { ...this.toDto(item), children: [] };
  }

  async create(orgId: string, dto: CreateExpenseCategoryDto): Promise<ExpenseCategoryResponseDto> {
    // Тип: явний або від батька (гілка одного типу), інакше дефолт EXPENSE.
    let type: ExpenseCategoryType = dto.type ?? 'EXPENSE';
    if (dto.parentId) {
      const parent = await this.prisma.expenseCategory.findFirst({
        where: { id: dto.parentId, orgId, deletedAt: null },
        select: { type: true },
      });
      if (!parent) throw new NotFoundException('Батьківську статтю не знайдено');
      // Дитина успадковує тип батька — гілка дерева одного типу (EXPENSE/INCOME не змішуються).
      if (dto.type && dto.type !== parent.type) {
        throw new BadRequestException('Тип статті має збігатися з типом батьківської статті');
      }
      type = parent.type;
    }

    // resurrect-vs-409 по (orgId,name) — @@unique включає soft-deleted.
    const anyExisting = await this.prisma.expenseCategory.findFirst({
      where: { orgId, name: dto.name },
      select: { id: true, deletedAt: true },
    });
    if (anyExisting) {
      if (!anyExisting.deletedAt) throw new ConflictException('Стаття з такою назвою вже існує');
      await this.prisma.expenseCategory.update({
        where: { id: anyExisting.id, orgId },
        data: {
          name: dto.name,
          type,
          parentId: dto.parentId ?? null,
          sortOrder: dto.sortOrder ?? 0,
          isActive: true,
          deletedAt: null,
        },
      });
      return this.finish(orgId, anyExisting.id);
    }
    const item = await this.prisma.expenseCategory.create({
      data: {
        orgId,
        name: dto.name,
        type,
        parentId: dto.parentId ?? null,
        sortOrder: dto.sortOrder ?? 0,
      },
    });
    return this.finish(orgId, item.id);
  }

  async update(
    orgId: string,
    id: string,
    dto: UpdateExpenseCategoryDto,
  ): Promise<ExpenseCategoryResponseDto> {
    const existing = await this.prisma.expenseCategory.findFirst({
      where: { id, orgId, deletedAt: null },
      select: { id: true, type: true },
    });
    if (!existing) throw new NotFoundException('Статтю не знайдено');

    if (dto.name) {
      const duplicate = await this.prisma.expenseCategory.findFirst({
        where: { orgId, name: dto.name, NOT: { id }, deletedAt: null },
        select: { id: true },
      });
      if (duplicate) throw new ConflictException('Стаття з такою назвою вже існує');
    }

    // Перенесення гілки: новий батько має існувати, бути того ж типу і НЕ бути нащадком (цикл).
    if (dto.parentId !== undefined && dto.parentId !== null) {
      if (dto.parentId === id) throw new BadRequestException('Стаття не може бути власним батьком');
      const parent = await this.prisma.expenseCategory.findFirst({
        where: { id: dto.parentId, orgId, deletedAt: null },
        select: { type: true },
      });
      if (!parent) throw new NotFoundException('Батьківську статтю не знайдено');
      if (parent.type !== existing.type)
        throw new BadRequestException('Батьківська стаття має бути того ж типу');
      const descendants = await this.getDescendantIds(orgId, id);
      if (descendants.includes(dto.parentId))
        throw new BadRequestException('Не можна перенести статтю у власного нащадка');
    }

    await this.prisma.expenseCategory.update({
      where: { id, orgId },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.parentId !== undefined ? { parentId: dto.parentId ?? null } : {}),
        ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      },
    });
    return this.finish(orgId, id);
  }

  /** Увімк/вимк статтю — каскадно на всіх нащадків (як work-categories). */
  async toggleActive(
    orgId: string,
    id: string,
    isActive: boolean,
  ): Promise<ExpenseCategoryResponseDto> {
    const existing = await this.prisma.expenseCategory.findFirst({
      where: { id, orgId, deletedAt: null },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Статтю не знайдено');
    const descendantIds = await this.getDescendantIds(orgId, id);
    await this.prisma.expenseCategory.updateMany({
      where: { id: { in: [id, ...descendantIds] }, orgId, deletedAt: null },
      data: { isActive },
    });
    return this.finish(orgId, id);
  }

  async restore(orgId: string, id: string): Promise<ExpenseCategoryResponseDto> {
    const deleted = await this.prisma.expenseCategory.findFirst({
      where: { id, orgId, NOT: { deletedAt: null } },
      select: { name: true },
    });
    if (!deleted) throw new NotFoundException('Видалену статтю не знайдено');
    const activeDuplicate = await this.prisma.expenseCategory.findFirst({
      where: { orgId, name: deleted.name, deletedAt: null, NOT: { id } },
      select: { id: true },
    });
    if (activeDuplicate)
      throw new ConflictException(
        'Активна стаття з такою назвою вже існує — відновлення неможливе',
      );
    const result = await this.prisma.expenseCategory.updateMany({
      where: { id, orgId, NOT: { deletedAt: null } },
      data: { deletedAt: null },
    });
    if (result.count === 0) throw new NotFoundException('Видалену статтю не знайдено');
    return this.finish(orgId, id);
  }

  /** Soft-delete статті + каскадно всіх нащадків (як work-categories). */
  async remove(orgId: string, id: string): Promise<void> {
    const existing = await this.prisma.expenseCategory.findFirst({
      where: { id, orgId, deletedAt: null },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Статтю не знайдено');
    const descendants = await this.getDescendantIds(orgId, id);
    await this.prisma.expenseCategory.updateMany({
      where: { id: { in: [id, ...descendants] }, orgId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    await this.cache.del(cacheKey(orgId));
  }

  /** Завантажити рядок після мутації, скинути кеш, повернути DTO (children=[] — окремий вузол). */
  private async finish(orgId: string, id: string): Promise<ExpenseCategoryResponseDto> {
    const item = await this.prisma.expenseCategory.findFirstOrThrow({ where: { id, orgId } });
    await this.cache.del(cacheKey(orgId));
    return { ...this.toDto(item), children: [] };
  }

  /** Усі нащадки (обхід у памʼяті — без N+1). */
  private async getDescendantIds(orgId: string, parentId: string): Promise<string[]> {
    const all = await this.prisma.expenseCategory.findMany({
      where: { orgId, deletedAt: null },
      select: { id: true, parentId: true },
      take: 1000,
    });
    const childrenByParent = new Map<string, string[]>();
    for (const c of all) {
      if (!c.parentId) continue;
      const arr = childrenByParent.get(c.parentId) ?? [];
      arr.push(c.id);
      childrenByParent.set(c.parentId, arr);
    }
    const out: string[] = [];
    const stack = [parentId];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const child of childrenByParent.get(cur) ?? []) {
        out.push(child);
        stack.push(child);
      }
    }
    return out;
  }

  private buildTree(all: Row[], parentId: string | null): ExpenseCategoryResponseDto[] {
    return all
      .filter(item => item.parentId === parentId)
      .map(item => ({ ...this.toDto(item), children: this.buildTree(all, item.id) }));
  }

  private toDto(item: Row): Omit<ExpenseCategoryResponseDto, 'children'> {
    return {
      id: item.id,
      orgId: item.orgId,
      parentId: item.parentId ?? null,
      name: item.name,
      type: item.type,
      sortOrder: item.sortOrder,
      isActive: item.isActive,
      deletedAt:
        item.deletedAt instanceof Date ? item.deletedAt.toISOString() : (item.deletedAt ?? null),
      createdAt: item.createdAt instanceof Date ? item.createdAt.toISOString() : item.createdAt,
      updatedAt: item.updatedAt instanceof Date ? item.updatedAt.toISOString() : item.updatedAt,
    };
  }
}
