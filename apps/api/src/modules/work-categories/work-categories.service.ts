import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../redis/cache.service';
import {
  CreateWorkCategoryDto,
  UpdateWorkCategoryDto,
  WorkCategoryResponseDto,
} from './work-categories.dto';

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
    await this.findOne(orgId, id);
    if (dto.parentId) {
      const parent = await this.prisma.workCategory.findFirst({
        where: { id: dto.parentId, orgId, deletedAt: null },
      });
      if (!parent) throw new NotFoundException('Батьківську категорію не знайдено');
    }
    const item = await this.prisma.workCategory.update({ where: { id, orgId }, data: dto });
    await this.cache.del(cacheKey(orgId));
    return { ...this.toDto(item), children: [] };
  }

  async remove(orgId: string, id: string): Promise<void> {
    await this.findOne(orgId, id);
    const descendants = await this.getDescendantIds(orgId, id);
    await this.prisma.workCategory.updateMany({
      where: { id: { in: [id, ...descendants] }, orgId },
      data: { deletedAt: new Date() },
    });
    await this.cache.del(cacheKey(orgId));
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

  private buildTree(
    all: Array<{
      id: string;
      orgId: string;
      parentId: string | null;
      name: string;
      icon: string | null;
      sortOrder: number;
      createdAt: Date;
      updatedAt: Date;
    }>,
    parentId: string | null,
  ): WorkCategoryResponseDto[] {
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
    icon: string | null;
    sortOrder: number;
    createdAt: Date;
    updatedAt: Date;
  }): Omit<WorkCategoryResponseDto, 'children'> {
    return {
      id: item.id,
      orgId: item.orgId,
      parentId: item.parentId,
      name: item.name,
      icon: item.icon,
      sortOrder: item.sortOrder,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  }
}
