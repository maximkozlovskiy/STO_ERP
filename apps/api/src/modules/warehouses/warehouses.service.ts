import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { WarehouseType, Prisma } from '@prisma/client';
import { TRANSACTION_TIMEOUT_MS } from '@sto/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../redis/cache.service';
import { CreateWarehouseDto, UpdateWarehouseDto, WarehouseResponseDto } from './warehouses.dto';

const TTL = 300;
const cacheKey = (orgId: string, branchId?: string) =>
  `ref:warehouses:${orgId}${branchId ? `:${branchId}` : ''}`;

@Injectable()
export class WarehousesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  async findAll(
    orgId: string,
    branchId?: string,
    showDeleted = false,
  ): Promise<WarehouseResponseDto[]> {
    const key = cacheKey(orgId, branchId);
    if (!showDeleted) {
      const cached = await this.cache.get<WarehouseResponseDto[]>(key);
      if (cached) return cached;
    }

    const items = await this.prisma.warehouse.findMany({
      where: {
        orgId,
        ...(!showDeleted ? { deletedAt: null } : {}),
        ...(branchId ? { branchId } : {}),
      },
      orderBy: [{ isMain: 'desc' }, { name: 'asc' }],
      take: 500,
    });
    const result = items.map(item => this.toDto(item));
    if (!showDeleted) await this.cache.set(key, result, TTL);
    return result;
  }

  async findOne(orgId: string, id: string): Promise<WarehouseResponseDto> {
    const item = await this.prisma.warehouse.findFirst({ where: { id, orgId, deletedAt: null } });
    if (!item) throw new NotFoundException('Склад не знайдено');
    return this.toDto(item);
  }

  async create(orgId: string, dto: CreateWarehouseDto): Promise<WarehouseResponseDto> {
    // sto-optimize: narrow FK guard — full GarageBranch row read лише для existence.
    const branch = await this.prisma.garageBranch.findFirst({
      where: { id: dto.branchId, orgId, deletedAt: null },
      select: { id: true },
    });
    if (!branch) throw new NotFoundException('Філію не знайдено');
    try {
      const item = await this.prisma.$transaction(
        async tx => {
          if (dto.isMain) {
            await tx.warehouse.updateMany({
              where: { orgId, deletedAt: null },
              data: { isMain: false },
            });
          }
          return tx.warehouse.create({ data: { ...dto, orgId } });
        },
        { timeout: TRANSACTION_TIMEOUT_MS },
      );
      await this.cache.delPattern(`ref:warehouses:${orgId}*`);
      return this.toDto(item);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException(
          'Лише один склад може бути основним у організації. Спробуйте ще раз.',
        );
      }
      throw e;
    }
  }

  async update(orgId: string, id: string, dto: UpdateWarehouseDto): Promise<WarehouseResponseDto> {
    // sto-optimize: narrow tenant guard — findOne returns full DTO лише для existence,
    // що марно тут (tx нижче повертає updated DTO). select:{id} зменшує wire payload.
    const guard = await this.prisma.warehouse.findFirst({
      where: { id, orgId, deletedAt: null },
      select: { id: true },
    });
    if (!guard) throw new NotFoundException('Склад не знайдено');
    try {
      const item = await this.prisma.$transaction(
        async tx => {
          if (dto.isMain) {
            await tx.warehouse.updateMany({
              where: { orgId, deletedAt: null, id: { not: id } },
              data: { isMain: false },
            });
          }
          return tx.warehouse.update({ where: { id, orgId }, data: dto });
        },
        { timeout: TRANSACTION_TIMEOUT_MS },
      );
      await this.cache.delPattern(`ref:warehouses:${orgId}*`);
      return this.toDto(item);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException(
          'Лише один склад може бути основним у організації. Спробуйте ще раз.',
        );
      }
      throw e;
    }
  }

  async remove(orgId: string, id: string): Promise<void> {
    // Bug #355: якщо видаляємо `isMain=true` склад → auto-promote найстарший
    // активний sibling як новий `isMain`. Інакше invariant «у org є головний
    // склад» силентно порушується → downstream warehouse-selection повертає
    // випадковий склад (orderBy [isMain:desc, name:asc] стає [false, name]).
    // Patern Bug #351 (CounterpartyContract).
    const existing = await this.prisma.warehouse.findFirst({
      where: { id, orgId, deletedAt: null },
      select: { id: true, isMain: true },
    });
    if (!existing) throw new NotFoundException('Склад не знайдено');

    await this.prisma.$transaction(
      async tx => {
        await tx.warehouse.updateMany({
          where: { id, orgId, deletedAt: null },
          data: { deletedAt: new Date() },
        });
        if (existing.isMain) {
          const next = await tx.warehouse.findFirst({
            where: { orgId, deletedAt: null, id: { not: id } },
            orderBy: { createdAt: 'asc' },
            select: { id: true },
          });
          if (next) {
            await tx.warehouse.updateMany({
              where: { id: next.id, orgId, deletedAt: null },
              data: { isMain: true },
            });
          }
        }
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    );
    await this.cache.delPattern(`ref:warehouses:${orgId}*`);
  }

  private toDto(w: {
    id: string;
    orgId: string;
    branchId: string;
    name: string;
    type: string;
    isMain: boolean;
    createdAt: Date;
    updatedAt: Date;
    deletedAt?: Date | null;
  }): WarehouseResponseDto {
    return {
      id: w.id,
      orgId: w.orgId,
      branchId: w.branchId,
      name: w.name,
      type: w.type as WarehouseType,
      isMain: w.isMain,
      createdAt: w.createdAt instanceof Date ? w.createdAt.toISOString() : w.createdAt,
      updatedAt: w.updatedAt instanceof Date ? w.updatedAt.toISOString() : w.updatedAt,
      deletedAt: w.deletedAt instanceof Date ? w.deletedAt.toISOString() : w.deletedAt,
    };
  }
}
