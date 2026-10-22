import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { translateError, WARRANTY_EXPIRING_DAYS, type WarrantyState } from '@sto/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { addDaysKyiv } from '../../common/utils/kyiv-date';
import { searchContains } from '../../common/utils/like-pattern';
import { calculatePagination } from '../../common/utils/pagination';
import { getLocale } from '../../common/tenant/tenant-context';
import {
  CreateWarrantyDto,
  ClaimWarrantyDto,
  WarrantyResponseDto,
  WarrantyListDto,
  WarrantyListQueryDto,
  WarrantyListItemDto,
  PaginatedWarrantiesDto,
} from './warranties.dto';

/**
 * Межі стану гарантії (BR-WAR-002) на момент запиту: `now` і поріг «закінчується» — `now` +
 * `WARRANTY_EXPIRING_DAYS` календарних днів за Києвом. Одні межі для обчислення `state` у рядку і
 * для фільтра `?state=` у базі — інакше рядок із міткою «закінчується» не потрапляв би у фільтр.
 */
export interface WarrantyStateBounds {
  now: Date;
  expiringUntil: Date;
}

export function warrantyStateBounds(now = new Date()): WarrantyStateBounds {
  return { now, expiringUntil: addDaysKyiv(now, WARRANTY_EXPIRING_DAYS) };
}

export function warrantyState(
  w: { claimedAt: Date | null; expiresAt: Date },
  { now, expiringUntil }: WarrantyStateBounds,
): WarrantyState {
  if (w.claimedAt) return 'CLAIMED';
  if (w.expiresAt.getTime() <= now.getTime()) return 'EXPIRED';
  if (w.expiresAt.getTime() <= expiringUntil.getTime()) return 'EXPIRING';
  return 'ACTIVE';
}

/** Умова Prisma для одного стану — дзеркало `warrantyState`. */
export function warrantyStateWhere(
  state: WarrantyState,
  { now, expiringUntil }: WarrantyStateBounds,
): Prisma.WarrantyWhereInput {
  switch (state) {
    case 'CLAIMED':
      return { claimedAt: { not: null } };
    case 'EXPIRED':
      return { claimedAt: null, expiresAt: { lte: now } };
    case 'EXPIRING':
      return { claimedAt: null, expiresAt: { gt: now, lte: expiringUntil } };
    case 'ACTIVE':
      return { claimedAt: null, expiresAt: { gt: expiringUntil } };
    default: {
      const _: never = state;
      return _;
    }
  }
}

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

  /**
   * BR-WAR-001…003: список вкладки «Гарантії». Без видалених гарантій і без гарантій видалених
   * нарядів; стан і фільтр — з одних меж (`warrantyStateBounds`); пошук — номер наряду, клієнт,
   * номер авто наряду.
   */
  async findAll(orgId: string, query: WarrantyListQueryDto): Promise<PaginatedWarrantiesDto> {
    const bounds = warrantyStateBounds();
    const { skip, take } = calculatePagination({ page: query.page, limit: query.limit });
    const and: Prisma.WarrantyWhereInput[] = [];
    if (query.state?.length) {
      and.push({ OR: [...new Set(query.state)].map(s => warrantyStateWhere(s, bounds)) });
    }
    const contains = searchContains(query.q);
    if (contains) {
      and.push({
        OR: [
          { workOrder: { is: { number: contains } } },
          { workOrder: { is: { vehicle: { is: { licensePlate: contains } } } } },
          { counterparty: { is: { companyName: contains } } },
          { counterparty: { is: { lastName: contains } } },
          { counterparty: { is: { firstName: contains } } },
        ],
      });
    }
    const where: Prisma.WarrantyWhereInput = {
      orgId,
      deletedAt: null,
      workOrder: { is: { deletedAt: null } },
      ...(query.id ? { id: query.id } : {}),
      ...(and.length ? { AND: and } : {}),
    };
    const dir = query.sortDir ?? 'asc';
    const primary: Prisma.WarrantyOrderByWithRelationInput =
      query.sortBy === 'createdAt' ? { createdAt: dir } : { expiresAt: dir };
    const [rows, total] = await Promise.all([
      this.prisma.warranty.findMany({
        where,
        include: {
          workOrder: {
            select: {
              number: true,
              vehicle: { select: { make: true, model: true, licensePlate: true } },
            },
          },
          counterparty: { select: { companyName: true, firstName: true, lastName: true } },
        },
        orderBy: [primary, { id: dir }],
        skip,
        take,
      }),
      this.prisma.warranty.count({ where }),
    ]);
    const items: WarrantyListItemDto[] = rows.map(w => {
      const v = w.workOrder?.vehicle;
      return {
        ...this.toDto(w),
        vehicleSummary: v
          ? `${v.make} ${v.model}${v.licensePlate ? ` (${v.licensePlate})` : ''}`
          : null,
        state: warrantyState(w, bounds),
      };
    });
    return { items, total, page: query.page, limit: take };
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
    if (!wo)
      throw new NotFoundException(translateError('err.warranty.workOrderNotFound', getLocale()));
    if (!cp)
      throw new NotFoundException(translateError('err.warranty.counterpartyNotFound', getLocale()));
    if (dto.workOrderLineId && !line)
      throw new NotFoundException(translateError('err.warranty.lineNotFound', getLocale()));
    if (dto.workOrderPartId && !part)
      throw new NotFoundException(translateError('err.warranty.partNotFound', getLocale()));

    // expiresAt must be in the future — past-dated warranties make no business sense
    // and would immediately appear as expired in /warranties/expiring.
    const expiresAt = new Date(dto.expiresAt);
    if (expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException(translateError('err.warranty.endDateFuture', getLocale()));
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

    // Kyiv-calendar date arithmetic: `new Date().setDate(...)` uses the SERVER's local
    // calendar day. On a UTC (or any non-Kyiv) server the warranty end-date drifts by the
    // TZ offset — a WO completed at 23:30 Kyiv would count from the previous UTC day.
    // addDaysKyiv resolves the Kyiv calendar day first, then adds days via UTC arithmetic
    // (DST-safe). warrantyDays comes from OrganisationSettings.defaultWarrantyDays (config,
    // not hardcoded) — passed in by the caller.
    const expiresAt = addDaysKyiv(new Date(), warrantyDays);

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
    if (!cp)
      throw new NotFoundException(translateError('err.warranty.counterpartyNotFound', getLocale()));

    const [items, total] = await Promise.all([
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
    // Kyiv-DST-aware межа (addDaysKyiv), консистентно з autoCreate — сирий setDate давав би
    // server-local зсув на межі доби на UTC-контейнері (гарантія на день раніше/пізніше у вибірці).
    const now = new Date();
    const until = addDaysKyiv(now, days);
    const [items, total] = await Promise.all([
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
    if (!wo)
      throw new NotFoundException(translateError('err.warranty.workOrderNotFound', getLocale()));

    const [items, total] = await Promise.all([
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
        select: { claimedAt: true, expiresAt: true, workOrderId: true },
      }),
      this.prisma.workOrder.findFirst({
        where: { id: dto.claimWoId, orgId, deletedAt: null },
        select: { id: true },
      }),
    ]);
    if (!w) throw new NotFoundException(translateError('err.warranty.notFound', getLocale()));

    // Business rule: a warranty can be claimed exactly once. Re-claiming would silently
    // overwrite the previous claim metadata and break the warranty journal.
    if (w.claimedAt) {
      throw new BadRequestException(translateError('err.warranty.alreadyClaimed', getLocale()));
    }
    // Business rule: cannot claim an expired warranty.
    if (w.expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException(translateError('err.warranty.expired', getLocale()));
    }

    if (!claimWo)
      throw new NotFoundException(
        translateError('err.warranty.claimWorkOrderNotFound', getLocale()),
      );
    // BR-WAR-004: наряд-звернення — новий візит клієнта, не наряд, що видав гарантію. Звернення
    // тим самим нарядом «використало» б гарантію без жодного повторного ремонту (одне на гарантію).
    if (dto.claimWoId === w.workOrderId)
      throw new BadRequestException(translateError('err.warranty.claimSameWorkOrder', getLocale()));

    // BR-WAR-004: перевірки вище — лише швидка відмова. Рішення приймає сам запис: умова
    // `claimedAt: null` і `expiresAt > зараз` у where. Два одночасні звернення обидва проходять
    // перевірки вище (кожне читало гарантію до запису іншого), але `updateMany` друге вже не
    // збігається — `count = 0`, і друге отримує відмову замість мовчки переписати перше.
    const now = new Date();
    const res = await this.prisma.warranty.updateMany({
      where: { id, orgId, deletedAt: null, claimedAt: null, expiresAt: { gt: now } },
      data: { claimedAt: now, claimWoId: dto.claimWoId },
    });
    if (res.count === 0) {
      const cur = await this.prisma.warranty.findFirst({
        where: { id, orgId, deletedAt: null },
        select: { claimedAt: true },
      });
      if (!cur) throw new NotFoundException(translateError('err.warranty.notFound', getLocale()));
      throw new BadRequestException(
        translateError(
          cur.claimedAt ? 'err.warranty.alreadyClaimed' : 'err.warranty.expired',
          getLocale(),
        ),
      );
    }
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
