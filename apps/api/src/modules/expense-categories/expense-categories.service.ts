import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ExpenseCategoryType } from '@prisma/client';
import { translateError } from '@sto/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../redis/cache.service';
import { getLocale } from '../../common/tenant/tenant-context';
import {
  CreateExpenseCategoryDto,
  ExpenseCategoryResponseDto,
  UpdateExpenseCategoryDto,
} from './expense-categories.dto';

const TTL = 300;
const cacheKey = (orgId: string) => `ref:expense-categories:${orgId}`;
// Bug #736: макс. глибина дерева — 3 рівні (0..2), як UI (MAX_DEPTH=2). Backend теж мусить
// обмежувати, бо пряме API інакше будує необмежену вкладеність (розходження UI↔API).
const MAX_DEPTH = 2;

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
      : { items: this.buildTree(items, null), total };
    if (!showDeleted) await this.cache.set(cacheKey(orgId), result, TTL);
    return result;
  }

  async findOne(orgId: string, id: string): Promise<ExpenseCategoryResponseDto> {
    const item = await this.prisma.expenseCategory.findFirst({
      where: { id, orgId, deletedAt: null },
    });
    if (!item)
      throw new NotFoundException(translateError('err.expenseCategory.notFound', getLocale()));
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
      if (!parent)
        throw new NotFoundException(
          translateError('err.expenseCategory.parentNotFound', getLocale()),
        );
      // Дитина успадковує тип батька — гілка дерева одного типу (EXPENSE/INCOME не змішуються).
      if (dto.type && dto.type !== parent.type) {
        throw new BadRequestException(
          translateError('err.expenseCategory.typeMismatchParent', getLocale()),
        );
      }
      type = parent.type;
      // Bug #736: нова дитина = глибина батька + 1; не може перевищувати MAX_DEPTH.
      const parentDepth = await this.getDepth(orgId, dto.parentId);
      if (parentDepth + 1 > MAX_DEPTH)
        throw new BadRequestException(translateError('err.expenseCategory.maxDepth', getLocale()));
    }

    // resurrect-vs-409 по (orgId,name) — @@unique включає soft-deleted.
    const anyExisting = await this.prisma.expenseCategory.findFirst({
      where: { orgId, name: dto.name },
      select: { id: true, deletedAt: true },
    });
    if (anyExisting) {
      if (!anyExisting.deletedAt)
        throw new ConflictException(translateError('err.expenseCategory.nameExists', getLocale()));
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
    if (!existing)
      throw new NotFoundException(translateError('err.expenseCategory.notFound', getLocale()));

    if (dto.name) {
      const duplicate = await this.prisma.expenseCategory.findFirst({
        where: { orgId, name: dto.name, NOT: { id }, deletedAt: null },
        select: { id: true },
      });
      if (duplicate)
        throw new ConflictException(translateError('err.expenseCategory.nameExists', getLocale()));
    }

    // Перенесення гілки: новий батько має існувати, бути того ж типу і НЕ бути нащадком (цикл).
    if (dto.parentId !== undefined && dto.parentId !== null) {
      if (dto.parentId === id)
        throw new BadRequestException(translateError('err.expenseCategory.ownParent', getLocale()));
      const parent = await this.prisma.expenseCategory.findFirst({
        where: { id: dto.parentId, orgId, deletedAt: null },
        select: { type: true },
      });
      if (!parent)
        throw new NotFoundException(
          translateError('err.expenseCategory.parentNotFound', getLocale()),
        );
      if (parent.type !== existing.type)
        throw new BadRequestException(
          translateError('err.expenseCategory.parentTypeMismatch', getLocale()),
        );
      // Perf: гілка-перенос потребує трьох метрик дерева (нащадки-цикл, глибина нового
      // батька, висота піддерева). Раніше кожна робила власний findMany(усе дерево) → 3
      // ідентичні full-scan на один update. Тепер один знімок дерева → усі три у памʼяті.
      const tree = await this.loadTree(orgId);
      const descendants = this.descendantsFrom(tree.childrenByParent, id);
      if (descendants.includes(dto.parentId))
        throw new BadRequestException(
          translateError('err.expenseCategory.moveIntoDescendant', getLocale()),
        );
      // Bug #736: після переносу глибина найглибшого нащадка = глибина_нового_батька + 1
      // (сам вузол) + висота_піддерева. Не може перевищувати MAX_DEPTH.
      const parentDepth = this.depthFrom(tree.parentOf, dto.parentId);
      const subtreeHeight = this.subtreeHeightFrom(tree.childrenByParent, id);
      if (parentDepth + 1 + subtreeHeight > MAX_DEPTH)
        throw new BadRequestException(translateError('err.expenseCategory.maxDepth', getLocale()));
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
    if (!existing)
      throw new NotFoundException(translateError('err.expenseCategory.notFound', getLocale()));
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
      select: { name: true, parentId: true },
    });
    if (!deleted)
      throw new NotFoundException(
        translateError('err.expenseCategory.deletedNotFound', getLocale()),
      );
    const activeDuplicate = await this.prisma.expenseCategory.findFirst({
      where: { orgId, name: deleted.name, deletedAt: null, NOT: { id } },
      select: { id: true },
    });
    if (activeDuplicate)
      throw new ConflictException(
        translateError('err.expenseCategory.activeNameExists', getLocale()),
      );
    // Bug #734: якщо батько soft-deleted (каскадне видалення батька забрало й нащадка),
    // відновлення лише цього вузла лишило б його сиротою — parentId вказує на видалений
    // рядок, тож buildTree (від коренів parentId=null) НЕ показав би його ні як корінь,
    // ні під батьком → стаття «зникає» з довідника. Розірваний ланцюг предків → піднімаємо
    // до кореня (детермінований fallback, стаття лишається видимою й керованою).
    let reparentToRoot = false;
    if (deleted.parentId) {
      const parentAlive = await this.prisma.expenseCategory.findFirst({
        where: { id: deleted.parentId, orgId, deletedAt: null },
        select: { id: true },
      });
      if (!parentAlive) reparentToRoot = true;
    }
    const result = await this.prisma.expenseCategory.updateMany({
      where: { id, orgId, NOT: { deletedAt: null } },
      data: { deletedAt: null, ...(reparentToRoot ? { parentId: null } : {}) },
    });
    if (result.count === 0)
      throw new NotFoundException(
        translateError('err.expenseCategory.deletedNotFound', getLocale()),
      );
    return this.finish(orgId, id);
  }

  /** Soft-delete статті + каскадно всіх нащадків (як work-categories). */
  async remove(orgId: string, id: string): Promise<void> {
    const existing = await this.prisma.expenseCategory.findFirst({
      where: { id, orgId, deletedAt: null },
      select: { id: true },
    });
    if (!existing)
      throw new NotFoundException(translateError('err.expenseCategory.notFound', getLocale()));
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

  /**
   * Один знімок живого дерева орг → adjacency-мапи (parentOf, childrenByParent). Дозволяє
   * обчислити глибину / висоту / нащадків у памʼяті БЕЗ повторних full-scan (гілка-перенос у
   * update() потребує всіх трьох одразу — раніше 3 ідентичні findMany).
   */
  private async loadTree(orgId: string): Promise<{
    parentOf: Map<string, string | null>;
    childrenByParent: Map<string, string[]>;
  }> {
    const all = await this.prisma.expenseCategory.findMany({
      where: { orgId, deletedAt: null },
      select: { id: true, parentId: true },
      take: 1000,
    });
    const parentOf = new Map<string, string | null>();
    const childrenByParent = new Map<string, string[]>();
    for (const c of all) {
      parentOf.set(c.id, c.parentId);
      if (!c.parentId) continue;
      const arr = childrenByParent.get(c.parentId) ?? [];
      arr.push(c.id);
      childrenByParent.set(c.parentId, arr);
    }
    return { parentOf, childrenByParent };
  }

  /** Глибина вузла (корінь = 0) — обхід ланцюга батьків у памʼяті. */
  private depthFrom(parentOf: Map<string, string | null>, id: string): number {
    let depth = 0;
    let cur = parentOf.get(id) ?? null;
    // Захист від зациклення (не має статись — цикли блокуються) через ліміт ітерацій.
    while (cur && depth <= 1000) {
      depth += 1;
      cur = parentOf.get(cur) ?? null;
    }
    return depth;
  }

  /** Висота піддерева (кількість рівнів нижче вузла; лист = 0) — обхід у памʼяті. */
  private subtreeHeightFrom(childrenByParent: Map<string, string[]>, id: string): number {
    const walk = (node: string, guard: number): number => {
      if (guard > 1000) return 0;
      const kids = childrenByParent.get(node) ?? [];
      if (kids.length === 0) return 0;
      return 1 + Math.max(...kids.map(k => walk(k, guard + 1)));
    };
    return walk(id, 0);
  }

  /** Усі нащадки (обхід у памʼяті) з готової adjacency-мапи. */
  private descendantsFrom(childrenByParent: Map<string, string[]>, parentId: string): string[] {
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

  /**
   * Глибина вузла у дереві (корінь = 0). Bug #736: guard MAX_DEPTH у create (single-use → один scan).
   */
  private async getDepth(orgId: string, id: string): Promise<number> {
    const { parentOf } = await this.loadTree(orgId);
    return this.depthFrom(parentOf, id);
  }

  /** Усі нащадки (single-use у remove/toggleActive → один scan). */
  private async getDescendantIds(orgId: string, parentId: string): Promise<string[]> {
    const { childrenByParent } = await this.loadTree(orgId);
    return this.descendantsFrom(childrenByParent, parentId);
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
