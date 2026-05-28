import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateCurrencyDto, CurrencyResponseDto, UpdateCurrencyDto } from './currencies.dto';

@Injectable()
export class CurrenciesService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(orgId: string): Promise<{ items: CurrencyResponseDto[]; total: number }> {
    const [items, total] = await this.prisma.$transaction([
      this.prisma.currency.findMany({
        where: { orgId, deletedAt: null },
        orderBy: { name: 'asc' },
        take: 500,
      }),
      this.prisma.currency.count({ where: { orgId, deletedAt: null } }),
    ]);
    return { items: items.map(i => this.toDto(i)), total };
  }

  async findOne(orgId: string, id: string): Promise<CurrencyResponseDto> {
    const item = await this.prisma.currency.findFirst({ where: { id, orgId, deletedAt: null } });
    if (!item) throw new NotFoundException('Валюту не знайдено');
    return this.toDto(item);
  }

  async create(orgId: string, dto: CreateCurrencyDto): Promise<CurrencyResponseDto> {
    // Single query: fetch any row (active or soft-deleted) with the same unique key.
    // Handles both the active-duplicate check and the resurrection case (Bug #152) in one round-trip.
    const anyExisting = await this.prisma.currency.findFirst({
      where: { orgId, code: dto.code },
    });
    if (anyExisting) {
      if (!anyExisting.deletedAt) {
        throw new ConflictException(`Валюта з кодом "${dto.code}" вже існує`);
      }
      // Soft-deleted row occupies the unique index — resurrect it
      const restored = await this.prisma.currency.update({
        where: { id: anyExisting.id },
        data: { ...dto, deletedAt: null },
      });
      return this.toDto(restored);
    }

    const item = await this.prisma.currency.create({ data: { ...dto, orgId } });
    return this.toDto(item);
  }

  async update(orgId: string, id: string, dto: UpdateCurrencyDto): Promise<CurrencyResponseDto> {
    const existing = await this.prisma.currency.findFirst({ where: { id, orgId, deletedAt: null } });
    if (!existing) throw new NotFoundException('Валюту не знайдено');

    if (dto.code && dto.code !== existing.code) {
      const duplicate = await this.prisma.currency.findFirst({
        where: { orgId, code: dto.code, NOT: { id }, deletedAt: null },
      });
      if (duplicate) throw new ConflictException(`Валюта з кодом "${dto.code}" вже існує`);
    }

    const item = await this.prisma.currency.update({ where: { id }, data: dto });
    return this.toDto(item);
  }

  async remove(orgId: string, id: string): Promise<void> {
    const existing = await this.prisma.currency.findFirst({ where: { id, orgId, deletedAt: null } });
    if (!existing) throw new NotFoundException('Валюту не знайдено');
    await this.prisma.currency.update({ where: { id }, data: { deletedAt: new Date() } });
  }

  private toDto(item: {
    id: string; orgId: string; name: string; fullName: string | null;
    internationalName: string | null; code: string; symbol: string | null;
    createdAt: Date; updatedAt: Date;
  }): CurrencyResponseDto {
    return {
      id: item.id, orgId: item.orgId, name: item.name,
      fullName: item.fullName, internationalName: item.internationalName,
      code: item.code, symbol: item.symbol,
      createdAt: item.createdAt, updatedAt: item.updatedAt,
    };
  }
}
