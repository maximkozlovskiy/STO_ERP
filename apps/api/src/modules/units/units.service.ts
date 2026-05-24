import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateUnitDto, UpdateUnitDto, UnitResponseDto } from './units.dto';

@Injectable()
export class UnitsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(orgId: string): Promise<UnitResponseDto[]> {
    const items = await this.prisma.unitOfMeasure.findMany({
      where: { orgId, deletedAt: null },
      orderBy: { shortName: 'asc' },
      take: 1000,
    });
    return items.map(item => this.toDto(item));
  }

  async findOne(orgId: string, id: string): Promise<UnitResponseDto> {
    const item = await this.prisma.unitOfMeasure.findFirst({
      where: { id, orgId, deletedAt: null },
    });
    if (!item) throw new NotFoundException('Одиниця вимірю не знайдена');
    return this.toDto(item);
  }

  async create(orgId: string, dto: CreateUnitDto): Promise<UnitResponseDto> {
    const existing = await this.prisma.unitOfMeasure.findFirst({
      where: { orgId, shortName: dto.shortName, deletedAt: null },
    });
    if (existing) {
      throw new ConflictException('Одиниця з такою скороченою назвою вже існує');
    }

    const item = await this.prisma.unitOfMeasure.create({
      data: { ...dto, orgId },
    });
    return this.toDto(item);
  }

  async update(orgId: string, id: string, dto: UpdateUnitDto): Promise<UnitResponseDto> {
    const existing = await this.prisma.unitOfMeasure.findFirst({ where: { id, orgId, deletedAt: null } });
    if (!existing) throw new NotFoundException('Одиниця вимірю не знайдена');

    if (existing.shortName !== dto.shortName) {
      const duplicate = await this.prisma.unitOfMeasure.findFirst({
        where: { orgId, shortName: dto.shortName, deletedAt: null, NOT: { id } },
      });
      if (duplicate) {
        throw new ConflictException('Одиниця з такою скороченою назвою вже існує');
      }
    }

    const item = await this.prisma.unitOfMeasure.update({
      where: { id, orgId },
      data: dto,
    });
    return this.toDto(item);
  }

  async remove(orgId: string, id: string): Promise<void> {
    const existing = await this.prisma.unitOfMeasure.findFirst({ where: { id, orgId, deletedAt: null } });
    if (!existing) throw new NotFoundException('Одиниця вимірю не знайдена');
    await this.prisma.unitOfMeasure.update({
      where: { id, orgId },
      data: { deletedAt: new Date() },
    });
  }

  private toDto(item: {
    id: string; orgId: string; name: string; shortName: string; isSystem: boolean; createdAt: Date; updatedAt: Date;
  }): UnitResponseDto {
    return {
      id: item.id, orgId: item.orgId, name: item.name,
      shortName: item.shortName, isSystem: item.isSystem,
      createdAt: item.createdAt, updatedAt: item.updatedAt,
    };
  }
}
