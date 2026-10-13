import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CashOperationReason, ExpenseCategoryType, Prisma } from '@prisma/client';
import { CASH_REASON_RULES, translateError } from '@sto/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../redis/cache.service';
import { getLocale } from '../../common/tenant/tenant-context';
import { cashReasonLabel } from '../cash/cash-reason-labels';
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
// Частковий unique-індекс «один привід — одна стаття в організації» (рукописна міграція
// 20261014100000): Prisma про нього не знає, тож P2002 впізнаємо за назвою індексу або полем.
const DEFAULT_REASON_INDEX = 'expense_categories_default_reason_uq';

interface Row {
  id: string;
  orgId: string;
  parentId: string | null;
  name: string;
  type: ExpenseCategoryType;
  defaultReason?: CashOperationReason | null;
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
    if (anyExisting && !anyExisting.deletedAt)
      throw new ConflictException(translateError('err.expenseCategory.nameExists', getLocale()));

    const defaultReason = dto.defaultReason ?? null;
    if (defaultReason) {
      this.assertReasonMatchesType(defaultReason, type);
      await this.assertReasonFree(orgId, defaultReason, anyExisting?.id);
    }

    if (anyExisting) {
      // Відновлення через створення: привід пишемо явно (заданий або null) — старий привід
      // видаленого рядка за цей час міг дістатись іншій статті.
      await this.writeDefaultReason(orgId, defaultReason, anyExisting.id, () =>
        this.prisma.expenseCategory.update({
          where: { id: anyExisting.id, orgId },
          data: {
            name: dto.name,
            type,
            parentId: dto.parentId ?? null,
            sortOrder: dto.sortOrder ?? 0,
            isActive: true,
            deletedAt: null,
            defaultReason,
          },
        }),
      );
      return this.finish(orgId, anyExisting.id);
    }
    const item = await this.writeDefaultReason(orgId, defaultReason, undefined, () =>
      this.prisma.expenseCategory.create({
        data: {
          orgId,
          name: dto.name,
          type,
          parentId: dto.parentId ?? null,
          sortOrder: dto.sortOrder ?? 0,
          ...(defaultReason ? { defaultReason } : {}),
        },
      }),
    );
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

    // Привід за замовчуванням (BR-CASH-022): `null` знімає, значення — закріплює за цією статтею.
    if (dto.defaultReason) {
      this.assertReasonMatchesType(dto.defaultReason, existing.type);
      await this.assertReasonFree(orgId, dto.defaultReason, id);
    }

    await this.writeDefaultReason(orgId, dto.defaultReason ?? null, id, () =>
      this.prisma.expenseCategory.update({
        where: { id, orgId },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.parentId !== undefined ? { parentId: dto.parentId ?? null } : {}),
          ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
          ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
          ...(dto.defaultReason !== undefined ? { defaultReason: dto.defaultReason } : {}),
        },
      }),
    );
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
      select: { name: true, parentId: true, defaultReason: true },
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
    // BR-CASH-022: поки стаття була видалена, її привід міг дістатись іншій (частковий індекс
    // видалених не тримає). Тоді відновлюємо БЕЗ приводу — він лишається за теперішнім власником.
    const reasonTaken = deleted.defaultReason
      ? await this.findReasonOwner(orgId, deleted.defaultReason, id)
      : null;
    const restoreRow = (dropReason: boolean) =>
      this.prisma.expenseCategory.updateMany({
        where: { id, orgId, NOT: { deletedAt: null } },
        data: {
          deletedAt: null,
          ...(reparentToRoot ? { parentId: null } : {}),
          ...(dropReason ? { defaultReason: null } : {}),
        },
      });
    let result: Prisma.BatchPayload;
    try {
      result = await restoreRow(!!reasonTaken);
    } catch (e: unknown) {
      // Гонка: привід закріпили за іншою статтею між перевіркою і записом — індекс відмовив.
      if (!this.isDefaultReasonConflict(e)) throw e;
      result = await restoreRow(true);
    }
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

  // ── Привід за замовчуванням (BR-CASH-022) ───────────────────────────────────────────────

  /** Напрям приводу ↔ тип статті: внесення — стаття оприбуткування, видача — стаття витрат. */
  private assertReasonMatchesType(reason: CashOperationReason, type: ExpenseCategoryType): void {
    const expected: ExpenseCategoryType =
      CASH_REASON_RULES[reason].direction === 'IN' ? 'INCOME' : 'EXPENSE';
    if (type !== expected) {
      const locale = getLocale();
      throw new BadRequestException(
        translateError('err.expenseCategory.defaultReasonDirection', locale, {
          reason: cashReasonLabel(reason, locale),
        }),
      );
    }
  }

  /** Невидалена стаття організації (крім `exceptId`), за якою вже закріплено привід. */
  private findReasonOwner(
    orgId: string,
    reason: CashOperationReason,
    exceptId?: string,
  ): Promise<{ id: string; name: string } | null> {
    return this.prisma.expenseCategory.findFirst({
      where: {
        orgId,
        defaultReason: reason,
        deletedAt: null,
        ...(exceptId ? { NOT: { id: exceptId } } : {}),
      },
      select: { id: true, name: true },
    });
  }

  private reasonTakenError(reason: CashOperationReason, ownerName: string): ConflictException {
    const locale = getLocale();
    return new ConflictException(
      translateError('err.expenseCategory.defaultReasonTaken', locale, {
        reason: cashReasonLabel(reason, locale),
        name: ownerName,
      }),
    );
  }

  /** Привід закріплений щонайбільше за однією невидаленою статтею: зайнятий → 409 з її назвою. */
  private async assertReasonFree(
    orgId: string,
    reason: CashOperationReason,
    exceptId?: string,
  ): Promise<void> {
    const owner = await this.findReasonOwner(orgId, reason, exceptId);
    if (owner) throw this.reasonTakenError(reason, owner.name);
  }

  private isDefaultReasonConflict(e: unknown): boolean {
    if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== 'P2002') return false;
    const target: unknown = e.meta?.target;
    const text = Array.isArray(target)
      ? target.join(',')
      : typeof target === 'string'
        ? target
        : '';
    return text.includes(DEFAULT_REASON_INDEX) || text.includes('defaultReason');
  }

  /**
   * Запис, що може закріпити привід. Перевірка «привід вільний» стоїть перед записом, але між нею
   * і записом привід може зайняти паралельний запит — тоді відмовляє частковий індекс (P2002), і
   * відповідь та сама: 409 із назвою статті-власника, а не безіменна 500.
   */
  private async writeDefaultReason<T>(
    orgId: string,
    reason: CashOperationReason | null,
    selfId: string | undefined,
    write: () => Promise<T>,
  ): Promise<T> {
    try {
      return await write();
    } catch (e: unknown) {
      if (!reason || !this.isDefaultReasonConflict(e)) throw e;
      const owner = await this.findReasonOwner(orgId, reason, selfId);
      throw this.reasonTakenError(reason, owner?.name ?? '');
    }
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
      defaultReason: item.defaultReason ?? null,
      sortOrder: item.sortOrder,
      isActive: item.isActive,
      deletedAt:
        item.deletedAt instanceof Date ? item.deletedAt.toISOString() : (item.deletedAt ?? null),
      createdAt: item.createdAt instanceof Date ? item.createdAt.toISOString() : item.createdAt,
      updatedAt: item.updatedAt instanceof Date ? item.updatedAt.toISOString() : item.updatedAt,
    };
  }
}
