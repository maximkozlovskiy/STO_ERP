import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../redis/cache.service';
import {
  CreateWorkCategoryDto,
  UpdateWorkCategoryDto,
  WorkCategoryResponseDto,
} from './work-categories.dto';

type WorkCategoryRow = {
  id: string;
  orgId: string;
  parentId: string | null;
  name: string;
  code: string | null;
  icon: string | null;
  sortOrder: number;
  isSystem: boolean;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
};

const TTL = 300;
const cacheKey = (orgId: string) => `ref:work-categories:${orgId}`;

@Injectable()
export class WorkCategoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  async findAll(orgId: string): Promise<WorkCategoryResponseDto[]> {
    const cached = await this.cache.get<WorkCategoryResponseDto[]>(cacheKey(orgId));
    if (cached) return cached;

    const all = await this.prisma.workCategory.findMany({
      where: { orgId, deletedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      take: 500,
    });
    const result = this.buildTree(all, null);
    await this.cache.set(cacheKey(orgId), result, TTL);
    return result;
  }

  async findOne(orgId: string, id: string): Promise<WorkCategoryResponseDto> {
    const item = await this.prisma.workCategory.findFirst({
      where: { id, orgId, deletedAt: null },
    });
    if (!item) throw new NotFoundException('Категорію не знайдено');
    return { ...this.toDto(item), children: [] };
  }

  async create(orgId: string, dto: CreateWorkCategoryDto): Promise<WorkCategoryResponseDto> {
    if (dto.parentId) {
      const parent = await this.prisma.workCategory.findFirst({
        where: { id: dto.parentId, orgId, deletedAt: null },
        select: { id: true },
      });
      if (!parent) throw new NotFoundException('Батьківську категорію не знайдено');
    }
    const item = await this.prisma.workCategory.create({ data: { ...dto, orgId } });
    await this.cache.del(cacheKey(orgId));
    return { ...this.toDto(item), children: [] };
  }

  async update(
    orgId: string,
    id: string,
    dto: UpdateWorkCategoryDto,
  ): Promise<WorkCategoryResponseDto> {
    // Parallel tenant guard + optional parent FK check — independent reads (-1 RTT).
    const [existing, parent] = await Promise.all([
      this.prisma.workCategory.findFirst({
        where: { id, orgId, deletedAt: null },
        select: { id: true, isSystem: true },
      }),
      dto.parentId
        ? this.prisma.workCategory.findFirst({
            where: { id: dto.parentId, orgId, deletedAt: null },
            select: { id: true },
          })
        : Promise.resolve(null as { id: string } | null),
    ]);
    if (!existing) throw new NotFoundException('Категорію не знайдено');
    if (dto.parentId && !parent) throw new NotFoundException('Батьківську категорію не знайдено');

    // Bug #319: системні категорії не можна перейменовувати або переносити (зміна назви/parentId).
    // Косметичні поля (sortOrder, icon) дозволяються — це per-org налаштування.
    if (existing.isSystem && (dto.name !== undefined || dto.parentId !== undefined)) {
      throw new BadRequestException('Системну категорію не можна перейменовувати або переносити');
    }

    // Bug #321: defense-in-depth — updateMany з deletedAt: null у where, щоб race
    // між findFirst і update не оновив soft-deleted рядок.
    const result = await this.prisma.workCategory.updateMany({
      where: { id, orgId, deletedAt: null },
      data: dto,
    });
    if (result.count === 0) throw new NotFoundException('Категорію не знайдено');
    const item = await this.prisma.workCategory.findFirstOrThrow({
      where: { id, orgId, deletedAt: null },
    });
    await this.cache.del(cacheKey(orgId));
    return { ...this.toDto(item), children: [] };
  }

  async remove(orgId: string, id: string): Promise<void> {
    // Bug #320: блокувати soft-delete системних категорій (UI ховає кнопку, але
    // backend — авторитет). Без guard curl з валідним JWT може видалити весь
    // системний catalog (71 категорія робіт + 365 категорій товарів).
    const existing = await this.prisma.workCategory.findFirst({
      where: { id, orgId, deletedAt: null },
      select: { id: true, isSystem: true },
    });
    if (!existing) throw new NotFoundException('Категорію не знайдено');
    if (existing.isSystem) {
      throw new BadRequestException('Системну категорію не можна видалити');
    }

    const descendants = await this.getDescendantIds(orgId, id);
    await this.prisma.workCategory.updateMany({
      where: { id: { in: [id, ...descendants] }, orgId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    await this.cache.del(cacheKey(orgId));
  }

  async toggleActive(
    orgId: string,
    id: string,
    isActive: boolean,
  ): Promise<WorkCategoryResponseDto> {
    // Bug #321: defense-in-depth — атомарний updateMany з повним where (id, orgId,
    // deletedAt: null) замість findFirst+update — без race-вікна для soft-deleted рядка.
    const result = await this.prisma.workCategory.updateMany({
      where: { id, orgId, deletedAt: null },
      data: { isActive },
    });
    if (result.count === 0) throw new NotFoundException('Категорію не знайдено');

    // Каскадно застосовуємо до всіх нащадків
    const descendantIds = await this.getDescendantIds(orgId, id);
    if (descendantIds.length > 0) {
      await this.prisma.workCategory.updateMany({
        where: { id: { in: descendantIds }, orgId, deletedAt: null },
        data: { isActive },
      });
    }

    const updated = await this.prisma.workCategory.findFirstOrThrow({
      where: { id, orgId, deletedAt: null },
    });
    await this.cache.del(cacheKey(orgId));
    return { ...this.toDto(updated), children: [] };
  }

  async getLinkedGoodCategories(orgId: string, id: string): Promise<string[]> {
    const links = await this.prisma.workGoodCategoryLink.findMany({
      where: { orgId, workCategoryId: id },
      select: { goodCategoryId: true },
      // OOM guard — links per work category typovo 5-50; cap високий щоб покрити "Універсал".
      take: 500,
    });
    return links.map(l => l.goodCategoryId);
  }

  private async getDescendantIds(orgId: string, parentId: string): Promise<string[]> {
    // Load all org categories once, then walk in memory — avoids N+1 recursion
    const all = await this.prisma.workCategory.findMany({
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

  private buildTree(all: WorkCategoryRow[], parentId: string | null): WorkCategoryResponseDto[] {
    return all
      .filter(item => item.parentId === parentId)
      .map(item => ({
        ...this.toDto(item),
        children: this.buildTree(all, item.id),
      }));
  }

  private toDto(item: WorkCategoryRow): Omit<WorkCategoryResponseDto, 'children'> {
    return {
      id: item.id,
      orgId: item.orgId,
      parentId: item.parentId,
      code: item.code,
      name: item.name,
      icon: item.icon,
      sortOrder: item.sortOrder,
      isSystem: item.isSystem,
      isActive: item.isActive,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  }
}
