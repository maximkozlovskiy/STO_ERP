import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { translateError } from '@sto/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { getLocale } from '../../common/tenant/tenant-context';
import { CacheService } from '../../redis/cache.service';
import {
  CreateGoodStatusDto,
  GoodStatusResponseDto,
  UpdateGoodStatusDto,
} from './good-statuses.dto';

const TTL = 300;
const cacheKey = (orgId: string) => `ref:good-statuses:${orgId}`;
const DEFAULT_COLOR = '#6b7280';

// goodCount рахує лише активні товари: link на soft-deleted товар НЕ інкрементує
// (інакше видалення товару з міткою залишало б лічильник завищеним — паритет Bug #723).
const COUNT_INCLUDE = {
  _count: { select: { links: { where: { good: { deletedAt: null } } } } },
};

/**
 * Довідник кастомних статусів-міток товарів (per-org). Дзеркалить CounterpartyStatusesService:
 * findAll(cache)/restore/findOne/create(resurrect-vs-conflict)/update/remove(soft), tenant-isolated,
 * P2002→409. Додає color + goodCount (_count links).
 */
@Injectable()
export class GoodStatusesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  async findAll(
    orgId: string,
    showDeleted = false,
  ): Promise<{ items: GoodStatusResponseDto[]; total: number }> {
    if (!showDeleted) {
      const cached = await this.cache.get<{ items: GoodStatusResponseDto[]; total: number }>(
        cacheKey(orgId),
      );
      if (cached) return cached;
    }

    const where = { orgId, ...(showDeleted ? {} : { deletedAt: null }) };
    const [items, total] = await Promise.all([
      this.prisma.goodStatus.findMany({
        where,
        include: COUNT_INCLUDE,
        // Активні (deletedAt=NULL) перші у showDeleted-режимі (nulls:'first' — Postgres інакше кладе в кінець).
        orderBy: [{ deletedAt: { sort: 'asc', nulls: 'first' } }, { name: 'asc' }],
        take: 1000,
      }),
      this.prisma.goodStatus.count({ where }),
    ]);
    const result = { items: items.map(item => this.toDto(item)), total };
    if (!showDeleted) await this.cache.set(cacheKey(orgId), result, TTL);
    return result;
  }

  async findOne(orgId: string, id: string): Promise<GoodStatusResponseDto> {
    const item = await this.prisma.goodStatus.findFirst({
      where: { id, orgId, deletedAt: null },
      include: COUNT_INCLUDE,
    });
    if (!item) throw new NotFoundException(translateError('err.goodStatus.notFound', getLocale()));
    return this.toDto(item);
  }

  async create(orgId: string, dto: CreateGoodStatusDto): Promise<GoodStatusResponseDto> {
    const color = dto.color ?? DEFAULT_COLOR;
    const anyExisting = await this.prisma.goodStatus.findFirst({
      where: { orgId, name: dto.name },
      select: { id: true, deletedAt: true },
    });
    if (anyExisting) {
      if (!anyExisting.deletedAt)
        throw new ConflictException(translateError('err.goodStatus.nameExists', getLocale()));
      // Воскрешаємо soft-deleted статус (унікальність @@unique[orgId,name] без partial WHERE).
      await this.prisma.goodStatus.update({
        where: { id: anyExisting.id, orgId },
        data: { name: dto.name, color, deletedAt: null },
      });
      const item = await this.prisma.goodStatus.findFirstOrThrow({
        where: { id: anyExisting.id, orgId },
        include: COUNT_INCLUDE,
      });
      await this.cache.del(cacheKey(orgId));
      return this.toDto(item);
    }

    const item = await this.prisma.goodStatus.create({
      data: { name: dto.name, color, orgId },
      include: COUNT_INCLUDE,
    });
    await this.cache.del(cacheKey(orgId));
    return this.toDto(item);
  }

  async update(
    orgId: string,
    id: string,
    dto: UpdateGoodStatusDto,
  ): Promise<GoodStatusResponseDto> {
    const [existing, duplicate] = await Promise.all([
      this.prisma.goodStatus.findFirst({
        where: { id, orgId, deletedAt: null },
        select: { id: true },
      }),
      this.prisma.goodStatus.findFirst({
        where: { orgId, name: dto.name, NOT: { id }, deletedAt: null },
        select: { id: true },
      }),
    ]);
    if (!existing)
      throw new NotFoundException(translateError('err.goodStatus.notFound', getLocale()));
    if (duplicate)
      throw new ConflictException(translateError('err.goodStatus.nameExists', getLocale()));

    await this.prisma.goodStatus.update({
      where: { id, orgId },
      data: { name: dto.name, ...(dto.color !== undefined ? { color: dto.color } : {}) },
    });
    const item = await this.prisma.goodStatus.findFirstOrThrow({
      where: { id, orgId },
      include: COUNT_INCLUDE,
    });
    await this.cache.del(cacheKey(orgId));
    return this.toDto(item);
  }

  async restore(orgId: string, id: string): Promise<GoodStatusResponseDto> {
    // @@unique[orgId,name] без partial WHERE → активний дубль зробив би restore P2002-500.
    // Явна перевірка → 409 (паритет із CounterpartyStatusesService.restore).
    const deleted = await this.prisma.goodStatus.findFirst({
      where: { id, orgId, NOT: { deletedAt: null } },
      select: { name: true },
    });
    if (!deleted)
      throw new NotFoundException(translateError('err.goodStatus.deletedNotFound', getLocale()));
    const activeDuplicate = await this.prisma.goodStatus.findFirst({
      where: { orgId, name: deleted.name, deletedAt: null, NOT: { id } },
      select: { id: true },
    });
    if (activeDuplicate)
      throw new ConflictException(translateError('err.goodStatus.activeNameExists', getLocale()));
    const result = await this.prisma.goodStatus.updateMany({
      where: { id, orgId, NOT: { deletedAt: null } },
      data: { deletedAt: null },
    });
    if (result.count === 0)
      throw new NotFoundException(translateError('err.goodStatus.deletedNotFound', getLocale()));
    const item = await this.prisma.goodStatus.findFirstOrThrow({
      where: { id, orgId },
      include: COUNT_INCLUDE,
    });
    await this.cache.del(cacheKey(orgId));
    return this.toDto(item);
  }

  /**
   * Скидає кеш довідника — викликається ззовні (GoodsService.assign/unassignStatus),
   * бо assign/unassign змінюють goodCount (_count links), але живуть у goods-модулі.
   */
  async invalidateCache(orgId: string): Promise<void> {
    await this.cache.del(cacheKey(orgId));
  }

  async remove(orgId: string, id: string): Promise<void> {
    // Atomic updateMany з compound where (id+orgId+deletedAt:null) — 1 statement, без race-вікна.
    // Links НЕ чіпаємо: toDto товару фільтрує status.deletedAt:null (restore відновлює
    // призначення); tenant-ізоляція через orgId у WHERE.
    const result = await this.prisma.goodStatus.updateMany({
      where: { id, orgId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (result.count === 0)
      throw new NotFoundException(translateError('err.goodStatus.notFound', getLocale()));
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
  }): GoodStatusResponseDto {
    return {
      id: item.id,
      orgId: item.orgId,
      name: item.name,
      color: item.color,
      goodCount: item._count?.links ?? 0,
      deletedAt:
        item.deletedAt instanceof Date ? item.deletedAt.toISOString() : (item.deletedAt ?? null),
      createdAt: item.createdAt instanceof Date ? item.createdAt.toISOString() : item.createdAt,
      updatedAt: item.updatedAt instanceof Date ? item.updatedAt.toISOString() : item.updatedAt,
    };
  }
}
