import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateWarehouseDto, UpdateWarehouseDto, WarehouseResponseDto } from './warehouses.dto';

@Injectable()
export class WarehousesService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(orgId: string, branchId?: string): Promise<WarehouseResponseDto[]> {
    const items = await this.prisma.warehouse.findMany({
      where: { orgId, deletedAt: null, ...(branchId ? { branchId } : {}) },
      orderBy: { name: 'asc' },
    });
    return items.map(this.toDto);
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
    const item = await this.prisma.warehouse.create({ data: { orgId, ...dto } });
    return this.toDto(item);
  }

  async update(orgId: string, id: string, dto: UpdateWarehouseDto): Promise<WarehouseResponseDto> {
    await this.findOne(orgId, id);
    const item = await this.prisma.warehouse.update({ where: { id }, data: dto });
    return this.toDto(item);
  }

  async remove(orgId: string, id: string): Promise<void> {
    await this.findOne(orgId, id);
    await this.prisma.warehouse.update({ where: { id }, data: { deletedAt: new Date() } });
  }

  private toDto(w: { id: string; orgId: string; branchId: string; name: string; type: string; createdAt: Date; updatedAt: Date }): WarehouseResponseDto {
    return { id: w.id, orgId: w.orgId, branchId: w.branchId, name: w.name, type: w.type as any, createdAt: w.createdAt, updatedAt: w.updatedAt };
  }
}
