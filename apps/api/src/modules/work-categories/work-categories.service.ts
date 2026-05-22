import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateWorkCategoryDto, UpdateWorkCategoryDto, WorkCategoryResponseDto } from './work-categories.dto';

@Injectable()
export class WorkCategoriesService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(orgId: string): Promise<WorkCategoryResponseDto[]> {
    const all = await this.prisma.workCategory.findMany({
      where: { orgId, deletedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    return this.buildTree(all, null);
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
    const item = await this.prisma.workCategory.create({ data: { orgId, ...dto } });
    return { ...this.toDto(item), children: [] };
  }

  async update(orgId: string, id: string, dto: UpdateWorkCategoryDto): Promise<WorkCategoryResponseDto> {
    await this.findOne(orgId, id);
    if (dto.parentId) {
      const parent = await this.prisma.workCategory.findFirst({
        where: { id: dto.parentId, orgId, deletedAt: null },
      });
      if (!parent) throw new NotFoundException('Батьківську категорію не знайдено');
    }
    const item = await this.prisma.workCategory.update({ where: { id }, data: dto });
    return { ...this.toDto(item), children: [] };
  }

  async remove(orgId: string, id: string): Promise<void> {
    await this.findOne(orgId, id);
    // Soft-delete the category and all its descendants
    const descendants = await this.getDescendantIds(orgId, id);
    await this.prisma.workCategory.updateMany({
      where: { id: { in: [id, ...descendants] }, orgId },
      data: { deletedAt: new Date() },
    });
  }

  private async getDescendantIds(orgId: string, parentId: string): Promise<string[]> {
    const children = await this.prisma.workCategory.findMany({
      where: { parentId, orgId, deletedAt: null },
      select: { id: true },
    });
    const childIds = children.map((c) => c.id);
    const nested = await Promise.all(childIds.map((id) => this.getDescendantIds(orgId, id)));
    return [...childIds, ...nested.flat()];
  }

  private buildTree(
    all: Array<{ id: string; orgId: string; parentId: string | null; name: string; icon: string | null; sortOrder: number; createdAt: Date; updatedAt: Date }>,
    parentId: string | null,
  ): WorkCategoryResponseDto[] {
    return all
      .filter((item) => item.parentId === parentId)
      .map((item) => ({
        ...this.toDto(item),
        children: this.buildTree(all, item.id),
      }));
  }

  private toDto(item: { id: string; orgId: string; parentId: string | null; name: string; icon: string | null; sortOrder: number; createdAt: Date; updatedAt: Date }): Omit<WorkCategoryResponseDto, 'children'> {
    return {
      id: item.id, orgId: item.orgId, parentId: item.parentId,
      name: item.name, icon: item.icon, sortOrder: item.sortOrder,
      createdAt: item.createdAt, updatedAt: item.updatedAt,
    };
  }
}
