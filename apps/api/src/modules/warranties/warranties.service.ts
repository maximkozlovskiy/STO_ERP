import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CreateWarrantyDto,
  ClaimWarrantyDto,
  WarrantyResponseDto,
  WarrantyListDto,
} from './warranties.dto';

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
  counterparty?: {
    companyName: string | null;
    firstName: string | null;
    lastName: string | null;
  } | null;
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
        ? (w.counterparty.companyName ??
          [w.counterparty.lastName, w.counterparty.firstName].filter(Boolean).join(' '))
        : undefined,
    };
  }

  async create(orgId: string, dto: CreateWarrantyDto): Promise<WarrantyResponseDto> {
    // Parallel cross-tenant FK validation — all four reads are independent
    // (different tables / different ids). Without this, four sequential RTTs.
    const [wo, cp, line, part] = await Promise.all([
      this.prisma.workOrder.findFirst({
        where: { id: dto.workOrderId, orgId, deletedAt: null },
        select: { id: true },
      }),
      this.prisma.counterparty.findFirst({
        where: { id: dto.counterpartyId, orgId, deletedAt: null },
        select: { id: true },
      }),
      // Tenant FK validation: workOrderLineId/workOrderPartId must belong to the same WO
      // (and therefore same org). Without this, an attacker could attach a warranty to
      // a line/part from a different work order — possibly cross-tenant — through the
      // global UUID FK.
      dto.workOrderLineId
        ? this.prisma.workOrderLine.findFirst({
            where: {
              id: dto.workOrderLineId,
              orgId,
              workOrderId: dto.workOrderId,
              deletedAt: null,
            },
            select: { id: true },
          })
        : Promise.resolve(null),
      dto.workOrderPartId
        ? this.prisma.workOrderPart.findFirst({
            where: {
              id: dto.workOrderPartId,
              orgId,
              workOrderId: dto.workOrderId,
              deletedAt: null,
            },
            select: { id: true },
          })
        : Promise.resolve(null),
    ]);
    if (!wo) throw new NotFoundException('Наряд не знайдено');
    if (!cp) throw new NotFoundException('Контрагента не знайдено');
    if (dto.workOrderLineId && !line) throw new NotFoundException('Рядок наряду не знайдено');
    if (dto.workOrderPartId && !part) throw new NotFoundException('Запчастину наряду не знайдено');

    // expiresAt must be in the future — past-dated warranties make no business sense
    // and would immediately appear as expired in /warranties/expiring.
    const expiresAt = new Date(dto.expiresAt);
    if (expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException('Дата завершення гарантії має бути в майбутньому');
    }

    const w = await this.prisma.warranty.create({
      data: {
        orgId,
        workOrderId: dto.workOrderId,
        workOrderLineId: dto.workOrderLineId,
        workOrderPartId: dto.workOrderPartId,
        counterpartyId: dto.counterpartyId,
        expiresAt,
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
    // Called after WO COMPLETED — create one warranty covering all work in the WO.
    // Perf: WO guard + idempotent existing check мають orgId+workOrderId фільтри (tenant-isolated)
    // і не залежать один від одного → Promise.all (-1 RTT у hot-path post-WO hook).
    const [wo, existing] = await Promise.all([
      this.prisma.workOrder.findFirst({
        where: { id: workOrderId, orgId, deletedAt: null },
        select: { id: true, number: true, counterpartyId: true },
      }),
      // sto-optimize: idempotent guard — only existence matters.
      this.prisma.warranty.findFirst({
        where: { orgId, workOrderId, deletedAt: null },
        select: { id: true },
      }),
    ]);
    if (!wo || !wo.counterpartyId) return;
    if (existing) return; // idempotent

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + warrantyDays);

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
    // Verify counterparty belongs to org BEFORE returning warranties — otherwise a
    // probe with a foreign UUID would always return an empty list (200 OK), letting
    // an attacker enumerate which UUIDs exist by timing/log differences.
    const cp = await this.prisma.counterparty.findFirst({
      where: { id: counterpartyId, orgId, deletedAt: null },
      select: { id: true },
    });
    if (!cp) throw new NotFoundException('Контрагента не знайдено');

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
      this.prisma.warranty.count({
        where: { orgId, deletedAt: null, claimedAt: null, expiresAt: { gt: now, lte: until } },
      }),
    ]);
    return { items: items.map(w => this.toDto(w)), total };
  }

  async findByWorkOrder(orgId: string, workOrderId: string): Promise<WarrantyListDto> {
    const wo = await this.prisma.workOrder.findFirst({
      where: { id: workOrderId, orgId, deletedAt: null },
      select: { id: true },
    });
    if (!wo) throw new NotFoundException('Наряд не знайдено');

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
    // Perf: warranty tenant guard + claimWo FK validation — обидва tenant-isolated,
    // не залежать один від одного → Promise.all (-1 RTT у happy path).
    const [w, claimWo] = await Promise.all([
      // sto-optimize: narrow projection — guard потрібен лише claimedAt + expiresAt.
      // Раніше тягнуло workOrderId/counterpartyId/lineId/partId/durationDays/syncVersion +
      // всі скалярні колонки — все ігнорується далі (updateMany читає id+orgId з where).
      this.prisma.warranty.findFirst({
        where: { id, orgId, deletedAt: null },
        select: { claimedAt: true, expiresAt: true },
      }),
      this.prisma.workOrder.findFirst({
        where: { id: dto.claimWoId, orgId, deletedAt: null },
        select: { id: true },
      }),
    ]);
    if (!w) throw new NotFoundException('Гарантію не знайдено');

    // Business rule: a warranty can be claimed exactly once. Re-claiming would silently
    // overwrite the previous claim metadata and break the warranty journal.
    if (w.claimedAt) {
      throw new BadRequestException('Гарантія вже використана');
    }
    // Business rule: cannot claim an expired warranty.
    if (w.expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException('Термін гарантії минув');
    }

    if (!claimWo) throw new NotFoundException('Гарантійний наряд не знайдено');

    // Defense-in-depth: scope update by orgId (compound where) so a race-window
    // between the findFirst guard and update cannot let a cross-org record be mutated.
    // Prisma requires a compound @@id or @@unique to use multiple keys here — warranty
    // has @@unique([id, orgId]) hint? Use updateMany + findFirstOrThrow для безпеки.
    await this.prisma.warranty.updateMany({
      where: { id, orgId, deletedAt: null },
      data: { claimedAt: new Date(), claimWoId: dto.claimWoId },
    });
    const updated = await this.prisma.warranty.findFirstOrThrow({
      where: { id, orgId },
      include: {
        workOrder: { select: { number: true } },
        counterparty: { select: { companyName: true, firstName: true, lastName: true } },
      },
    });
    return this.toDto(updated);
  }
}
