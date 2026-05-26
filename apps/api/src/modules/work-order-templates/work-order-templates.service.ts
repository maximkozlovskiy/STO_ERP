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
    const t = await this.prisma.workOrderTemplate.findFirst({ where: { id, orgId, deletedAt: null } });
    if (!t) throw new NotFoundException('Шаблон не знайдено');
    return this.toDto(t);
  }

  async create(orgId: string, dto: CreateWorkOrderTemplateDto): Promise<WorkOrderTemplateResponseDto> {
    const t = await this.prisma.workOrderTemplate.create({
      data: {
        orgId,
        name: dto.name,
        lines: (dto.lines ?? []) as object[],
        parts: (dto.parts ?? []) as object[],
      },
    });
    return this.toDto(t);
  }

  async update(orgId: string, id: string, dto: UpdateWorkOrderTemplateDto): Promise<WorkOrderTemplateResponseDto> {
    await this.findOne(orgId, id);
    const t = await this.prisma.workOrderTemplate.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.lines !== undefined && { lines: dto.lines as object[] }),
        ...(dto.parts !== undefined && { parts: dto.parts as object[] }),
      },
    });
    return this.toDto(t);
  }

  async remove(orgId: string, id: string): Promise<void> {
    await this.findOne(orgId, id);
    await this.prisma.workOrderTemplate.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  private toDto(t: {
    id: string; orgId: string; name: string;
    lines: unknown; parts: unknown;
    createdAt: Date; updatedAt: Date;
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
