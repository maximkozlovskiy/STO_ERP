import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateWarrantyDto, ClaimWarrantyDto, WarrantyResponseDto, WarrantyListDto } from './warranties.dto';

type WarrantyWithIncludes = {
  id: string;
  orgId: string;
  workOrderId: string;
  workOrderLineId: string | null;
  workOrderPartId: string | null;
  counterpartyId: string;
  expiresAt: Date;
  description: string;
  claimedAt: Date | null;
  claimWoId: string | null;
  createdAt: Date;
  workOrder?: { number: string } | null;
  counterparty?: { companyName: string | null; firstName: string | null; lastName: string | null } | null;
};

@Injectable()
export class WarrantiesService {
  constructor(private readonly prisma: PrismaService) {}

  private toDto(w: WarrantyWithIncludes): WarrantyResponseDto {
    const now = new Date();
    return {
      id: w.id,
      orgId: w.orgId,
      workOrderId: w.workOrderId,
      workOrderLineId: w.workOrderLineId ?? null,
      workOrderPartId: w.workOrderPartId ?? null,
      counterpartyId: w.counterpartyId,
      expiresAt: w.expiresAt.toISOString(),
      description: w.description,
      claimedAt: w.claimedAt?.toISOString() ?? null,
      claimWoId: w.claimWoId ?? null,
      isActive: !w.claimedAt && w.expiresAt > now,
      createdAt: w.createdAt.toISOString(),
      workOrderNumber: w.workOrder?.number,
      counterpartyName: w.counterparty
        ? (w.counterparty.companyName ?? [w.counterparty.lastName, w.counterparty.firstName].filter(Boolean).join(' '))
        : undefined,
    };
  }

  async create(orgId: string, dto: CreateWarrantyDto): Promise<WarrantyResponseDto> {
    const wo = await this.prisma.workOrder.findFirst({ where: { id: dto.workOrderId, orgId, deletedAt: null } });
    if (!wo) throw new NotFoundException('Наряд не знайдено');

    const cp = await this.prisma.counterparty.findFirst({ where: { id: dto.counterpartyId, orgId, deletedAt: null } });
    if (!cp) throw new NotFoundException('Контрагента не знайдено');

    const w = await this.prisma.warranty.create({
      data: {
        orgId,
        workOrderId: dto.workOrderId,
        workOrderLineId: dto.workOrderLineId,
        workOrderPartId: dto.workOrderPartId,
        counterpartyId: dto.counterpartyId,
        expiresAt: new Date(dto.expiresAt),
        description: dto.description ?? '',
      },
      include: {
        workOrder: { select: { number: true } },
        counterparty: { select: { companyName: true, firstName: true, lastName: true } },
      },
    });
    return this.toDto(w);
  }

  async autoCreate(orgId: string, workOrderId: string, warrantyDays: number): Promise<void> {
    // Called after WO COMPLETED — create one warranty covering all work in the WO
    const wo = await this.prisma.workOrder.findFirst({
      where: { id: workOrderId, orgId, deletedAt: null },
      select: { id: true, number: true, counterpartyId: true },
    });
    if (!wo || !wo.counterpartyId) return;

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + warrantyDays);

    // Idempotent: skip if warranty for this WO already exists
    const existing = await this.prisma.warranty.findFirst({
      where: { orgId, workOrderId, deletedAt: null },
    });
    if (existing) return;

    await this.prisma.warranty.create({
      data: {
        orgId,
        workOrderId,
        counterpartyId: wo.counterpartyId,
        expiresAt,
        description: `Гарантія на виконані роботи по наряду №${wo.number}`,
      },
    });
  }

  async findByCounterparty(orgId: string, counterpartyId: string): Promise<WarrantyListDto> {
    const [items, total] = await this.prisma.$transaction([
      this.prisma.warranty.findMany({
        where: { orgId, counterpartyId, deletedAt: null },
        include: {
          workOrder: { select: { number: true } },
          counterparty: { select: { companyName: true, firstName: true, lastName: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
      this.prisma.warranty.count({ where: { orgId, counterpartyId, deletedAt: null } }),
    ]);
    return { items: items.map(w => this.toDto(w)), total };
  }

  async findExpiring(orgId: string, days: number): Promise<WarrantyListDto> {
    const until = new Date();
    until.setDate(until.getDate() + days);
    const now = new Date();
    const [items, total] = await this.prisma.$transaction([
      this.prisma.warranty.findMany({
        where: { orgId, deletedAt: null, claimedAt: null, expiresAt: { gt: now, lte: until } },
        include: {
          workOrder: { select: { number: true } },
          counterparty: { select: { companyName: true, firstName: true, lastName: true } },
        },
        orderBy: { expiresAt: 'asc' },
        take: 200,
      }),
      this.prisma.warranty.count({ where: { orgId, deletedAt: null, claimedAt: null, expiresAt: { gt: now, lte: until } } }),
    ]);
    return { items: items.map(w => this.toDto(w)), total };
  }

  async findByWorkOrder(orgId: string, workOrderId: string): Promise<WarrantyListDto> {
    const [items, total] = await this.prisma.$transaction([
      this.prisma.warranty.findMany({
        where: { orgId, workOrderId, deletedAt: null },
        include: {
          workOrder: { select: { number: true } },
          counterparty: { select: { companyName: true, firstName: true, lastName: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      this.prisma.warranty.count({ where: { orgId, workOrderId, deletedAt: null } }),
    ]);
    return { items: items.map(w => this.toDto(w)), total };
  }

  async claim(orgId: string, id: string, dto: ClaimWarrantyDto): Promise<WarrantyResponseDto> {
    const w = await this.prisma.warranty.findFirst({ where: { id, orgId, deletedAt: null } });
    if (!w) throw new NotFoundException('Гарантію не знайдено');

    // Validate claimWo belongs to same org
    const claimWo = await this.prisma.workOrder.findFirst({ where: { id: dto.claimWoId, orgId, deletedAt: null } });
    if (!claimWo) throw new NotFoundException('Гарантійний наряд не знайдено');

    const updated = await this.prisma.warranty.update({
      where: { id },
      data: { claimedAt: new Date(), claimWoId: dto.claimWoId },
      include: {
        workOrder: { select: { number: true } },
        counterparty: { select: { companyName: true, firstName: true, lastName: true } },
      },
    });
    return this.toDto(updated);
  }
}
