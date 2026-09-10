import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../redis/cache.service';
import {
  CounterpartyStatusResponseDto,
  CreateCounterpartyStatusDto,
  UpdateCounterpartyStatusDto,
} from './counterparty-statuses.dto';

const TTL = 300;
const cacheKey = (orgId: string) => `ref:counterparty-statuses:${orgId}`;
const DEFAULT_COLOR = '#6b7280';

const COUNT_INCLUDE = { _count: { select: { links: true } } };

/**
 * Довідник кастомних статусів-міток контрагентів (per-org). Дзеркалить BrandsService:
 * findAll(cache)/restore/findOne/create(resurrect-vs-conflict)/update/remove(soft), tenant-isolated,
 * P2002→409. Додає color + counterpartyCount (_count links).
 */
@Injectable()
export class CounterpartyStatusesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  async findAll(
    orgId: string,
    showDeleted = false,
  ): Promise<{ items: CounterpartyStatusResponseDto[]; total: number }> {
    if (!showDeleted) {
      const cached = await this.cache.get<{
        items: CounterpartyStatusResponseDto[];
        total: number;
      }>(cacheKey(orgId));
      if (cached) return cached;
    }

    const where = { orgId, ...(showDeleted ? {} : { deletedAt: null }) };
    const [items, total] = await Promise.all([
      this.prisma.counterpartyStatus.findMany({
        where,
        include: COUNT_INCLUDE,
        // Активні (deletedAt=NULL) перші у showDeleted-режимі (nulls:'first' — Postgres інакше кладе в кінець).
        orderBy: [{ deletedAt: { sort: 'asc', nulls: 'first' } }, { name: 'asc' }],
        take: 1000,
      }),
      this.prisma.counterpartyStatus.count({ where }),
    ]);
    const result = { items: items.map(item => this.toDto(item)), total };
    if (!showDeleted) await this.cache.set(cacheKey(orgId), result, TTL);
    return result;
  }

  async findOne(orgId: string, id: string): Promise<CounterpartyStatusResponseDto> {
    const item = await this.prisma.counterpartyStatus.findFirst({
      where: { id, orgId, deletedAt: null },
      include: COUNT_INCLUDE,
    });
    if (!item) throw new NotFoundException('Статус не знайдено');
    return this.toDto(item);
  }

  async create(
    orgId: string,
    dto: CreateCounterpartyStatusDto,
  ): Promise<CounterpartyStatusResponseDto> {
    const color = dto.color ?? DEFAULT_COLOR;
    const anyExisting = await this.prisma.counterpartyStatus.findFirst({
      where: { orgId, name: dto.name },
      select: { id: true, deletedAt: true },
    });
    if (anyExisting) {
      if (!anyExisting.deletedAt) throw new ConflictException('Статус з такою назвою вже існує');
      // Воскрешаємо soft-deleted статус (унікальність @@unique[orgId,name] без partial WHERE).
      await this.prisma.counterpartyStatus.update({
        where: { id: anyExisting.id, orgId },
        data: { name: dto.name, color, deletedAt: null },
      });
      const item = await this.prisma.counterpartyStatus.findFirstOrThrow({
        where: { id: anyExisting.id, orgId },
        include: COUNT_INCLUDE,
      });
      await this.cache.del(cacheKey(orgId));
      return this.toDto(item);
    }

    const item = await this.prisma.counterpartyStatus.create({
      data: { name: dto.name, color, orgId },
      include: COUNT_INCLUDE,
    });
    await this.cache.del(cacheKey(orgId));
    return this.toDto(item);
  }

  async update(
    orgId: string,
    id: string,
    dto: UpdateCounterpartyStatusDto,
  ): Promise<CounterpartyStatusResponseDto> {
    const [existing, duplicate] = await Promise.all([
      this.prisma.counterpartyStatus.findFirst({
        where: { id, orgId, deletedAt: null },
        select: { id: true },
      }),
      this.prisma.counterpartyStatus.findFirst({
        where: { orgId, name: dto.name, NOT: { id }, deletedAt: null },
        select: { id: true },
      }),
    ]);
    if (!existing) throw new NotFoundException('Статус не знайдено');
    if (duplicate) throw new ConflictException('Статус з такою назвою вже існує');

    await this.prisma.counterpartyStatus.update({
      where: { id, orgId },
      data: { name: dto.name, ...(dto.color !== undefined ? { color: dto.color } : {}) },
    });
    const item = await this.prisma.counterpartyStatus.findFirstOrThrow({
      where: { id, orgId },
      include: COUNT_INCLUDE,
    });
    await this.cache.del(cacheKey(orgId));
    return this.toDto(item);
  }

  async restore(orgId: string, id: string): Promise<CounterpartyStatusResponseDto> {
    // @@unique[orgId,name] без partial WHERE → активний дубль зробив би restore P2002-500.
    // Явна перевірка → 409 (паритет із BrandsService.restore).
    const deleted = await this.prisma.counterpartyStatus.findFirst({
      where: { id, orgId, NOT: { deletedAt: null } },
      select: { name: true },
    });
    if (!deleted) throw new NotFoundException('Видалений статус не знайдено');
    const activeDuplicate = await this.prisma.counterpartyStatus.findFirst({
      where: { orgId, name: deleted.name, deletedAt: null, NOT: { id } },
      select: { id: true },
    });
    if (activeDuplicate)
      throw new ConflictException(
        'Активний статус з такою назвою вже існує — відновлення неможливе',
      );
    const result = await this.prisma.counterpartyStatus.updateMany({
      where: { id, orgId, NOT: { deletedAt: null } },
      data: { deletedAt: null },
    });
    if (result.count === 0) throw new NotFoundException('Видалений статус не знайдено');
    const item = await this.prisma.counterpartyStatus.findFirstOrThrow({
      where: { id, orgId },
      include: COUNT_INCLUDE,
    });
    await this.cache.del(cacheKey(orgId));
    return this.toDto(item);
  }

  /**
   * Скидає кеш довідника — викликається ззовні (CounterpartiesService.assign/unassignStatus),
   * бо assign/unassign змінюють counterpartyCount (_count links), але живуть у counterparties-модулі.
   */
  async invalidateCache(orgId: string): Promise<void> {
    await this.cache.del(cacheKey(orgId));
  }

  async remove(orgId: string, id: string): Promise<void> {
    // Atomic updateMany з compound where (id+orgId+deletedAt:null) — 1 statement, без race-вікна.
    // Links НЕ чіпаємо: toResponseDto контрагента фільтрує status.deletedAt:null (restore відновлює
    // призначення); tenant-ізоляція через orgId у WHERE.
    const result = await this.prisma.counterpartyStatus.updateMany({
      where: { id, orgId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (result.count === 0) throw new NotFoundException('Статус не знайдено');
    await this.cache.del(cacheKey(orgId));
  }

  private toDto(item: {
    id: string;
    orgId: string;
    name: string;
    color: string;
    deletedAt?: Date | null;
    createdAt: Date;
    updatedAt: Date;
    _count?: { links: number };
  }): CounterpartyStatusResponseDto {
    return {
      id: item.id,
      orgId: item.orgId,
      name: item.name,
      color: item.color,
      counterpartyCount: item._count?.links ?? 0,
      deletedAt:
        item.deletedAt instanceof Date ? item.deletedAt.toISOString() : (item.deletedAt ?? null),
      createdAt: item.createdAt instanceof Date ? item.createdAt.toISOString() : item.createdAt,
      updatedAt: item.updatedAt instanceof Date ? item.updatedAt.toISOString() : item.updatedAt,
    };
  }
}
