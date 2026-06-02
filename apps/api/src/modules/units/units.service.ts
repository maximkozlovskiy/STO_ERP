import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../redis/cache.service';
import { CreateUnitDto, UpdateUnitDto, UnitResponseDto } from './units.dto';

const TTL = 300;
const cacheKey = (orgId: string) => `ref:units:${orgId}`;

@Injectable()
export class UnitsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  async findAll(orgId: string, showDeleted = false): Promise<UnitResponseDto[]> {
    // Only cache the default (active-only) query — showDeleted is management-only
    if (!showDeleted) {
      const cached = await this.cache.get<UnitResponseDto[]>(cacheKey(orgId));
      if (cached) return cached;
    }

    const items = await this.prisma.unitOfMeasure.findMany({
      where: { orgId, ...(showDeleted ? {} : { deletedAt: null }) },
      orderBy: [{ deletedAt: 'asc' }, { shortName: 'asc' }],
      take: 1000,
    });
    const result = items.map(item => this.toDto(item));

    if (!showDeleted) await this.cache.set(cacheKey(orgId), result, TTL);
    return result;
  }

  async restore(orgId: string, id: string): Promise<UnitResponseDto> {
    const existing = await this.prisma.unitOfMeasure.findFirst({
      where: { id, orgId, NOT: { deletedAt: null } },
    });
    if (!existing) throw new NotFoundException('Видалену одиницю виміру не знайдено');
    const item = await this.prisma.unitOfMeasure.update({
      where: { id, orgId },
      data: { deletedAt: null },
    });
    await this.cache.del(cacheKey(orgId));
    return this.toDto(item);
  }

  async findOne(orgId: string, id: string): Promise<UnitResponseDto> {
    const item = await this.prisma.unitOfMeasure.findFirst({
      where: { id, orgId, deletedAt: null },
    });
    if (!item) throw new NotFoundException('Одиниця виміру не знайдена');
    return this.toDto(item);
  }

  async create(orgId: string, dto: CreateUnitDto): Promise<UnitResponseDto> {
    const anyExisting = await this.prisma.unitOfMeasure.findFirst({
      where: { orgId, shortName: dto.shortName },
    });
    if (anyExisting) {
      if (!anyExisting.deletedAt)
        throw new ConflictException('Одиниця з такою скороченою назвою вже існує');
      const restored = await this.prisma.unitOfMeasure.update({
        where: { id: anyExisting.id },
        data: { ...dto, deletedAt: null },
      });
      await this.cache.del(cacheKey(orgId));
      return this.toDto(restored);
    }
    const item = await this.prisma.unitOfMeasure.create({ data: { ...dto, orgId } });
    await this.cache.del(cacheKey(orgId));
    return this.toDto(item);
  }

  async update(orgId: string, id: string, dto: UpdateUnitDto): Promise<UnitResponseDto> {
    const existing = await this.prisma.unitOfMeasure.findFirst({
      where: { id, orgId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Одиниця виміру не знайдена');
    if (dto.shortName && existing.shortName !== dto.shortName) {
      const duplicate = await this.prisma.unitOfMeasure.findFirst({
        where: { orgId, shortName: dto.shortName, deletedAt: null, NOT: { id } },
      });
      if (duplicate) throw new ConflictException('Одиниця з такою скороченою назвою вже існує');
    }
    const item = await this.prisma.unitOfMeasure.update({ where: { id, orgId }, data: dto });
    await this.cache.del(cacheKey(orgId));
    return this.toDto(item);
  }

  async remove(orgId: string, id: string): Promise<void> {
    const existing = await this.prisma.unitOfMeasure.findFirst({
      where: { id, orgId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Одиниця виміру не знайдена');
    await this.prisma.unitOfMeasure.update({
      where: { id, orgId },
      data: { deletedAt: new Date() },
    });
    await this.cache.del(cacheKey(orgId));
  }

  toDto(item: {
    id: string;
    orgId: string;
    name: string;
    shortName: string;
    isSystem: boolean;
    coefficient: number;
    width: number | null;
    height: number | null;
    depth: number | null;
    volume: number | null;
    weight: number | null;
    deletedAt?: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }): UnitResponseDto {
    return {
      id: item.id,
      orgId: item.orgId,
      name: item.name,
      shortName: item.shortName,
      isSystem: item.isSystem,
      coefficient: item.coefficient,
      width: item.width,
      height: item.height,
      depth: item.depth,
      volume: item.volume,
      weight: item.weight,
      deletedAt: item.deletedAt ?? null,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  }
}
