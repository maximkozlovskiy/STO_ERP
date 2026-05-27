import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { WarehouseType, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateWarehouseDto, UpdateWarehouseDto, WarehouseResponseDto } from './warehouses.dto';

@Injectable()
export class WarehousesService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(orgId: string, branchId?: string): Promise<WarehouseResponseDto[]> {
    const items = await this.prisma.warehouse.findMany({
      where: { orgId, deletedAt: null, ...(branchId ? { branchId } : {}) },
      // isMain first so dropdowns/auto-select prefer the canonical warehouse,
      // then alphabetical for stable UX.
      orderBy: [{ isMain: 'desc' }, { name: 'asc' }],
      take: 100,
    });
    return items.map(item => this.toDto(item));
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
      const item = await this.prisma.$transaction(async (tx) => {
        if (dto.isMain) {
          await tx.warehouse.updateMany({ where: { orgId, deletedAt: null }, data: { isMain: false } });
        }
        return tx.warehouse.create({ data: { ...dto, orgId } });
      }, { timeout: 5_000 }); // Bug #141: explicit timeout — updateMany + create (parity with #130/#132/#138)
      return this.toDto(item);
    } catch (e) {
      // Partial unique index `warehouses_orgId_isMain_unique` enforces single-main invariant.
      // The service-layer updateMany covers the common case, but a parallel
      // transaction may race past it; surface a clear 409 instead of opaque 500.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('Лише один склад може бути основним у організації. Спробуйте ще раз.');
      }
      throw e;
    }
  }

  async update(orgId: string, id: string, dto: UpdateWarehouseDto): Promise<WarehouseResponseDto> {
    await this.findOne(orgId, id);
    try {
      const item = await this.prisma.$transaction(async (tx) => {
        if (dto.isMain) {
          await tx.warehouse.updateMany({ where: { orgId, deletedAt: null, id: { not: id } }, data: { isMain: false } });
        }
        return tx.warehouse.update({ where: { id, orgId }, data: dto });
      }, { timeout: 5_000 }); // Bug #141: explicit timeout — updateMany + update (parity with #130/#132/#138)
      return this.toDto(item);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('Лише один склад може бути основним у організації. Спробуйте ще раз.');
      }
      throw e;
    }
  }

  async remove(orgId: string, id: string): Promise<void> {
    await this.findOne(orgId, id);
    await this.prisma.warehouse.update({ where: { id, orgId }, data: { deletedAt: new Date() } });
  }

  private toDto(w: { id: string; orgId: string; branchId: string; name: string; type: string; isMain: boolean; createdAt: Date; updatedAt: Date }): WarehouseResponseDto {
    return { id: w.id, orgId: w.orgId, branchId: w.branchId, name: w.name, type: w.type as WarehouseType, isMain: w.isMain, createdAt: w.createdAt, updatedAt: w.updatedAt };
  }
}
