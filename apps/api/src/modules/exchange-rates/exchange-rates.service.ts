import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CreateExchangeRateDto,
  ExchangeRateResponseDto,
  UpdateExchangeRateDto,
} from './exchange-rates.dto';

// Normalise any ISO-8601 string (including timezone-aware) to a UTC midnight Date
// that matches what Prisma returns for @db.Date columns.
// e.g. '2024-01-15T03:00:00+03:00' → 2024-01-15T00:00:00.000Z (not 2024-01-14)
function parseDateOnly(value: string): Date {
  // Take only the date portion (first 10 chars) and parse as UTC midnight
  const ymd = value.slice(0, 10);
  return new Date(`${ymd}T00:00:00.000Z`);
}

@Injectable()
export class ExchangeRatesService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(
    orgId: string,
    filters?: { currencyId?: string; from?: string; to?: string },
  ): Promise<{ items: ExchangeRateResponseDto[]; total: number }> {
    const where: Record<string, unknown> = { orgId, deletedAt: null };
    if (filters?.currencyId) where['currencyId'] = filters.currencyId;
    if (filters?.from || filters?.to) {
      where['date'] = {
        ...(filters.from ? { gte: new Date(filters.from) } : {}),
        ...(filters.to ? { lte: new Date(filters.to) } : {}),
      };
    }

    const [items, total] = await this.prisma.$transaction([
      this.prisma.exchangeRate.findMany({
        where,
        include: { currency: { select: { code: true, name: true } } },
        orderBy: [{ date: 'desc' }, { currency: { code: 'asc' } }],
        take: 500,
      }),
      this.prisma.exchangeRate.count({ where }),
    ]);
    return { items: items.map(i => this.toDto(i)), total };
  }

  async findOne(orgId: string, id: string): Promise<ExchangeRateResponseDto> {
    const item = await this.prisma.exchangeRate.findFirst({
      where: { id, orgId, deletedAt: null },
      include: { currency: { select: { code: true, name: true } } },
    });
    if (!item) throw new NotFoundException('Курс валюти не знайдено');
    return this.toDto(item);
  }

  async create(orgId: string, dto: CreateExchangeRateDto): Promise<ExchangeRateResponseDto> {
    const date = parseDateOnly(dto.date);
    // Parallel: currency FK validation + existing-row dup check (Bug #152 + merge).
    // Both queries scoped by orgId, independent — collapse у Promise.all (-1 RTT).
    const [currency, anyExisting] = await Promise.all([
      this.prisma.currency.findFirst({
        where: { id: dto.currencyId, orgId, deletedAt: null },
        select: { id: true },
      }),
      this.prisma.exchangeRate.findFirst({
        where: { orgId, currencyId: dto.currencyId, date },
      }),
    ]);
    if (!currency) throw new NotFoundException('Валюту не знайдено');
    if (anyExisting) {
      if (!anyExisting.deletedAt) throw new ConflictException('Курс на цю дату вже існує');
      // Soft-deleted row occupies the unique index — resurrect it
      const restored = await this.prisma.exchangeRate.update({
        where: { id: anyExisting.id },
        data: { rate: dto.rate, coefficient: dto.coefficient ?? 1, deletedAt: null },
        include: { currency: { select: { code: true, name: true } } },
      });
      return this.toDto(restored);
    }

    const item = await this.prisma.exchangeRate.create({
      data: {
        orgId,
        currencyId: dto.currencyId,
        date,
        rate: dto.rate,
        coefficient: dto.coefficient ?? 1,
      },
      include: { currency: { select: { code: true, name: true } } },
    });
    return this.toDto(item);
  }

  async update(
    orgId: string,
    id: string,
    dto: UpdateExchangeRateDto,
  ): Promise<ExchangeRateResponseDto> {
    // Tier merger: tenant guard + optional duplicate-date check у єдиний Promise.all
    // (sto-optimize pattern 2026-05-31). Duplicate read сходиться через NOT: {id} +
    // фіксована currencyId/date з DTO — тенант-safe незалежно від existing.
    // Race-edge: якщо dto.date === existing.date (no calendar change) — фільтруємо
    // duplicate ПІСЛЯ awaits. 2 RTT → 1 RTT.
    const newDate = dto.date !== undefined ? parseDateOnly(dto.date) : null;
    const [existing, duplicate] = await Promise.all([
      this.prisma.exchangeRate.findFirst({
        where: { id, orgId, deletedAt: null },
        select: { currencyId: true, date: true },
      }),
      // Speculative duplicate-check: дата ще не порівняна з existing.date,
      // тому інколи запит виявиться зайвим. На warm-cache це 1 індекс-hit — копійки.
      newDate
        ? this.prisma.exchangeRate.findFirst({
            where: {
              orgId,
              date: newDate,
              NOT: { id },
              deletedAt: null,
            },
            select: { id: true, currencyId: true },
          })
        : Promise.resolve(null),
    ]);
    if (!existing) throw new NotFoundException('Курс валюти не знайдено');

    // Bug #151: зміна дати має поважати унікальність (orgId, currencyId, date).
    // Інакше PATCH на зайняту дату падає на DB P2002 → generic 409 замість
    // локалізованого повідомлення (так само як у create()).
    if (newDate && newDate.getTime() !== new Date(existing.date).setUTCHours(0, 0, 0, 0)) {
      if (duplicate && duplicate.currencyId === existing.currencyId) {
        throw new ConflictException('Курс на цю дату вже існує');
      }
    }

    const updateData: Record<string, unknown> = {};
    if (dto.date !== undefined) updateData['date'] = parseDateOnly(dto.date);
    if (dto.rate !== undefined) updateData['rate'] = dto.rate;
    if (dto.coefficient !== undefined) updateData['coefficient'] = dto.coefficient;

    // Defense-in-depth: updateMany with orgId guard (sto-review pattern 2026-05-30).
    const updated = await this.prisma.exchangeRate.updateMany({
      where: { id, orgId, deletedAt: null },
      data: updateData,
    });
    if (updated.count === 0) throw new NotFoundException('Курс валюти не знайдено');
    const item = await this.prisma.exchangeRate.findFirstOrThrow({
      where: { id, orgId },
      include: { currency: { select: { code: true, name: true } } },
    });
    return this.toDto(item);
  }

  async remove(orgId: string, id: string): Promise<void> {
    // Defense-in-depth: atomic soft-delete via updateMany (sto-review pattern 2026-05-30).
    const result = await this.prisma.exchangeRate.updateMany({
      where: { id, orgId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (result.count === 0) throw new NotFoundException('Курс валюти не знайдено');
  }

  private toDto(item: {
    id: string;
    orgId: string;
    currencyId: string;
    date: Date;
    rate: Decimal;
    coefficient: Decimal;
    createdAt: Date;
    updatedAt: Date;
    currency: { code: string; name: string };
  }): ExchangeRateResponseDto {
    return {
      id: item.id,
      orgId: item.orgId,
      currencyId: item.currencyId,
      currencyCode: item.currency.code,
      currencyName: item.currency.name,
      date: item.date.toISOString().split('T')[0],
      rate: Number(item.rate),
      coefficient: Number(item.coefficient),
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  }
}
