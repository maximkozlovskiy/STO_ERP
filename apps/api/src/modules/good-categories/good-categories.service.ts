import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { TRANSACTION_TIMEOUT_MS } from '@sto/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../redis/cache.service';
import {
  CreateGoodCategoryDto,
  UpdateGoodCategoryDto,
  GoodCategoryResponseDto,
} from './good-categories.dto';

const TTL = 300;
const cacheKey = (orgId: string) => `ref:good-categories:${orgId}`;

@Injectable()
export class GoodCategoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  async findAll(orgId: string): Promise<GoodCategoryResponseDto[]> {
    const cached = await this.cache.get<GoodCategoryResponseDto[]>(cacheKey(orgId));
    if (cached) return cached;

    const all = await this.prisma.goodCategory.findMany({
      where: { orgId, deletedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      take: 1000,
    });
    const result = this.buildTree(all, null);
    await this.cache.set(cacheKey(orgId), result, TTL);
    return result;
  }

  async findOne(orgId: string, id: string): Promise<GoodCategoryResponseDto> {
    const item = await this.prisma.goodCategory.findFirst({
      where: { id, orgId, deletedAt: null },
    });
    if (!item) throw new NotFoundException('Категорію товарів не знайдено');
    return { ...this.toDto(item), children: [] };
  }

  async create(orgId: string, dto: CreateGoodCategoryDto): Promise<GoodCategoryResponseDto> {
    if (dto.parentId) {
      const parent = await this.prisma.goodCategory.findFirst({
        where: { id: dto.parentId, orgId, deletedAt: null },
        select: { id: true },
      });
      if (!parent) throw new NotFoundException('Батьківську категорію не знайдено');
    }
    const item = await this.prisma.goodCategory.create({
      data: { ...dto, orgId, isSystem: false },
    });
    await this.cache.del(cacheKey(orgId));
    return { ...this.toDto(item), children: [] };
  }

  async update(
    orgId: string,
    id: string,
    dto: UpdateGoodCategoryDto,
  ): Promise<GoodCategoryResponseDto> {
    const [existing, parent] = await Promise.all([
      this.prisma.goodCategory.findFirst({
        where: { id, orgId, deletedAt: null },
        select: { id: true, isSystem: true },
      }),
      dto.parentId
        ? this.prisma.goodCategory.findFirst({
            where: { id: dto.parentId, orgId, deletedAt: null },
            select: { id: true },
          })
        : Promise.resolve(null as { id: string } | null),
    ]);
    if (!existing) throw new NotFoundException('Категорію товарів не знайдено');
    if (dto.parentId && !parent) throw new NotFoundException('Батьківську категорію не знайдено');

    // Bug #319: системні категорії не можна перейменовувати або переносити.
    // Косметичні поля (sortOrder) дозволяються.
    if (existing.isSystem && (dto.name !== undefined || dto.parentId !== undefined)) {
      throw new BadRequestException('Системну категорію не можна перейменовувати або переносити');
    }

    // Bug #321: defense-in-depth — updateMany з deletedAt: null у where.
    const result = await this.prisma.goodCategory.updateMany({
      where: { id, orgId, deletedAt: null },
      data: dto,
    });
    if (result.count === 0) throw new NotFoundException('Категорію товарів не знайдено');
    const item = await this.prisma.goodCategory.findFirstOrThrow({
      where: { id, orgId, deletedAt: null },
    });
    await this.cache.del(cacheKey(orgId));
    return { ...this.toDto(item), children: [] };
  }

  async remove(orgId: string, id: string): Promise<void> {
    // Bug #320: блокувати soft-delete системних категорій (UI ховає кнопку,
    // але backend — авторитет).
    const item = await this.prisma.goodCategory.findFirst({
      where: { id, orgId, deletedAt: null },
      select: { id: true, isSystem: true },
    });
    if (!item) throw new NotFoundException('Категорію товарів не знайдено');
    if (item.isSystem) {
      throw new BadRequestException('Системну категорію не можна видалити');
    }

    const descendants = await this.getDescendantIds(orgId, id);
    const allIds = [id, ...descendants];

    // Перенести товари цих категорій в null (без категорії)
    // sto-review: interactive $transaction із явним timeout — для категорій з великою
    // кількістю товарів (універсал, мастила). Array form не підтримує timeout option.
    await this.prisma.$transaction(
      async tx => {
        await tx.good.updateMany({
          where: { orgId, goodCategoryId: { in: allIds }, deletedAt: null },
          data: { goodCategoryId: null },
        });
        await tx.goodCategory.updateMany({
          where: { id: { in: allIds }, orgId, deletedAt: null },
          data: { deletedAt: new Date() },
        });
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    );

    await this.cache.del(cacheKey(orgId));
  }

  async toggleActive(
    orgId: string,
    id: string,
    isActive: boolean,
  ): Promise<GoodCategoryResponseDto> {
    // Bug #321: defense-in-depth — атомарний updateMany з повним where.
    const result = await this.prisma.goodCategory.updateMany({
      where: { id, orgId, deletedAt: null },
      data: { isActive },
    });
    if (result.count === 0) throw new NotFoundException('Категорію товарів не знайдено');

    // Каскадно застосовуємо до всіх нащадків
    const descendantIds = await this.getDescendantIds(orgId, id);
    if (descendantIds.length > 0) {
      await this.prisma.goodCategory.updateMany({
        where: { id: { in: descendantIds }, orgId, deletedAt: null },
        data: { isActive },
      });
    }

    const updated = await this.prisma.goodCategory.findFirstOrThrow({
      where: { id, orgId, deletedAt: null },
    });
    await this.cache.del(cacheKey(orgId));
    return { ...this.toDto(updated), children: [] };
  }

  async getLinkedWorkCategories(orgId: string, id: string): Promise<string[]> {
    const links = await this.prisma.workGoodCategoryLink.findMany({
      where: { orgId, goodCategoryId: id },
      select: { workCategoryId: true },
      // OOM guard — links per category typovo 5-50; cap високий щоб покрити "Універсал".
      take: 500,
    });
    return links.map(l => l.workCategoryId);
  }

  private async getDescendantIds(orgId: string, parentId: string): Promise<string[]> {
    const all = await this.prisma.goodCategory.findMany({
      where: { orgId, deletedAt: null },
      select: { id: true, parentId: true },
      take: 2000,
    });
    const childrenByParent = new Map<string, string[]>();
    for (const c of all) {
      if (!c.parentId) continue;
      const arr = childrenByParent.get(c.parentId) ?? [];
      arr.push(c.id);
      childrenByParent.set(c.parentId, arr);
    }
    const result: string[] = [];
    const stack = [parentId];
    while (stack.length) {
      const id = stack.pop()!;
      const children = childrenByParent.get(id) ?? [];
      result.push(...children);
      stack.push(...children);
    }
    return result;
  }

  private buildTree(
    all: Array<{
      id: string;
      orgId: string;
      parentId: string | null;
      name: string;
      code: string | null;
      isSystem: boolean;
      isActive: boolean;
      sortOrder: number;
      createdAt: Date;
      updatedAt: Date;
    }>,
    parentId: string | null,
  ): GoodCategoryResponseDto[] {
    return all
      .filter(item => item.parentId === parentId)
      .map(item => ({
        ...this.toDto(item),
        children: this.buildTree(all, item.id),
      }));
  }

  private toDto(item: {
    id: string;
    orgId: string;
    parentId: string | null;
    name: string;
    code: string | null;
    isSystem: boolean;
    isActive: boolean;
    sortOrder: number;
    createdAt: Date;
    updatedAt: Date;
  }): Omit<GoodCategoryResponseDto, 'children'> {
    return {
      id: item.id,
      orgId: item.orgId,
      parentId: item.parentId,
      code: item.code,
      name: item.name,
      isSystem: item.isSystem,
      isActive: item.isActive,
      sortOrder: item.sortOrder,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  }
}
