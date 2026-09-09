import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CreateWorkOrderTemplateDto,
  UpdateWorkOrderTemplateDto,
  WorkOrderTemplateResponseDto,
  WorkOrderTemplatesListDto,
  TemplateLineDto,
  TemplatePartDto,
} from './work-order-templates.dto';

@Injectable()
export class WorkOrderTemplatesService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(orgId: string): Promise<WorkOrderTemplatesListDto> {
    const [items, total] = await Promise.all([
      this.prisma.workOrderTemplate.findMany({
        where: { orgId, deletedAt: null },
        orderBy: { name: 'asc' },
        take: 200,
      }),
      this.prisma.workOrderTemplate.count({ where: { orgId, deletedAt: null } }),
    ]);
    return { items: items.map(this.toDto), total };
  }

  async findOne(orgId: string, id: string): Promise<WorkOrderTemplateResponseDto> {
    const t = await this.prisma.workOrderTemplate.findFirst({
      where: { id, orgId, deletedAt: null },
    });
    if (!t) throw new NotFoundException('Шаблон не знайдено');
    return this.toDto(t);
  }

  async create(
    orgId: string,
    dto: CreateWorkOrderTemplateDto,
  ): Promise<WorkOrderTemplateResponseDto> {
    const t = await this.prisma.workOrderTemplate.create({
      data: {
        orgId,
        name: dto.name,
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- каст потрібен tsc для Prisma InputJsonValue (ESLint хибно вважає зайвим)
        lines: (dto.lines ?? []) as object[],
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- каст потрібен tsc для Prisma InputJsonValue
        parts: (dto.parts ?? []) as object[],
      },
    });
    return this.toDto(t);
  }

  async update(
    orgId: string,
    id: string,
    dto: UpdateWorkOrderTemplateDto,
  ): Promise<WorkOrderTemplateResponseDto> {
    // 1-RTT pattern: updateMany з тенант-where замість findOne+update.
    // updateMany повертає { count } — 0 означає 404 (не знайдено в межах orgId).
    // findFirstOrThrow безпечний, але потребує окремої findFirst → ця оптимізація
    // зливає guard + update в один UPDATE statement.
    const updated = await this.prisma.workOrderTemplate.updateMany({
      where: { id, orgId, deletedAt: null },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- каст потрібен tsc для Prisma InputJsonValue
        ...(dto.lines !== undefined && { lines: dto.lines as object[] }),
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- каст потрібен tsc для Prisma InputJsonValue
        ...(dto.parts !== undefined && { parts: dto.parts as object[] }),
      },
    });
    if (updated.count === 0) throw new NotFoundException('Шаблон не знайдено');
    // Read back: updateMany не повертає updated row, тому findFirst після update.
    // 2 RTT total (замість 3 з findOne+update+toDto) — ще можна було б використати
    // raw UPDATE...RETURNING, але Prisma не підтримує RETURNING через safe API.
    const t = await this.prisma.workOrderTemplate.findFirst({
      where: { id, orgId, deletedAt: null },
    });
    if (!t) throw new NotFoundException('Шаблон не знайдено');
    return this.toDto(t);
  }

  async remove(orgId: string, id: string): Promise<void> {
    // Same 1-RTT pattern as update — updateMany з orgId guard, count===0 → 404.
    const updated = await this.prisma.workOrderTemplate.updateMany({
      where: { id, orgId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (updated.count === 0) throw new NotFoundException('Шаблон не знайдено');
  }

  private toDto(t: {
    id: string;
    orgId: string;
    name: string;
    lines: unknown;
    parts: unknown;
    createdAt: Date;
    updatedAt: Date;
  }): WorkOrderTemplateResponseDto {
    return {
      id: t.id,
      orgId: t.orgId,
      name: t.name,
      lines: (t.lines as TemplateLineDto[]) ?? [],
      parts: (t.parts as TemplatePartDto[]) ?? [],
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
    };
  }
}
