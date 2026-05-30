import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { WarehouseType, Prisma } from '@prisma/client';
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

  async findAll(orgId: string, branchId?: string): Promise<WarehouseResponseDto[]> {
    const key = cacheKey(orgId, branchId);
    const cached = await this.cache.get<WarehouseResponseDto[]>(key);
    if (cached) return cached;

    const items = await this.prisma.warehouse.findMany({
      where: { orgId, deletedAt: null, ...(branchId ? { branchId } : {}) },
      orderBy: [{ isMain: 'desc' }, { name: 'asc' }],
      take: 100,
    });
    const result = items.map(item => this.toDto(item));
    await this.cache.set(key, result, TTL);
    return result;
  }

  async findOne(orgId: string, id: string): Promise<WarehouseResponseDto> {
    const item = await this.prisma.warehouse.findFirst({ where: { id, orgId, deletedAt: null } });
    if (!item) throw new NotFoundException('Склад не знайдено');
    return this.toDto(item);
  }

  async create(orgId: string, dto: CreateWarehouseDto): Promise<WarehouseResponseDto> {
    const branch = await this.prisma.garageBranch.findFirst({
      where: { id: dto.branchId, orgId, deletedAt: null },
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
        { timeout: 5_000 },
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
    await this.findOne(orgId, id);
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
        { timeout: 5_000 },
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
    await this.findOne(orgId, id);
    await this.prisma.warehouse.update({ where: { id, orgId }, data: { deletedAt: new Date() } });
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
  }): WarehouseResponseDto {
    return {
      id: w.id,
      orgId: w.orgId,
      branchId: w.branchId,
      name: w.name,
      type: w.type as WarehouseType,
      isMain: w.isMain,
      createdAt: w.createdAt,
      updatedAt: w.updatedAt,
    };
  }
}
