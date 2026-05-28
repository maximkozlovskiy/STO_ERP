import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateExchangeRateDto, ExchangeRateResponseDto, UpdateExchangeRateDto } from './exchange-rates.dto';

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
    const currency = await this.prisma.currency.findFirst({
      where: { id: dto.currencyId, orgId, deletedAt: null },
    });
    if (!currency) throw new NotFoundException('Валюту не знайдено');

    const date = new Date(dto.date);
    const existing = await this.prisma.exchangeRate.findFirst({
      where: { orgId, currencyId: dto.currencyId, date, deletedAt: null },
    });
    if (existing) throw new ConflictException('Курс на цю дату вже існує');

    // Bug #152: DB unique (orgId, currencyId, date) — повний, не partial. Soft-deleted
    // рядок все ще займає ключ → prisma.create впав би на P2002. Якщо такий рядок є —
    // воскрешаємо його (un-delete + оновлення даними), а не створюємо новий.
    const softDeleted = await this.prisma.exchangeRate.findFirst({
      where: { orgId, currencyId: dto.currencyId, date, NOT: { deletedAt: null } },
    });
    if (softDeleted) {
      const restored = await this.prisma.exchangeRate.update({
        where: { id: softDeleted.id },
        data: { rate: dto.rate, coefficient: dto.coefficient ?? 1, deletedAt: null },
        include: { currency: { select: { code: true, name: true } } },
      });
      return this.toDto(restored);
    }

    const item = await this.prisma.exchangeRate.create({
      data: { orgId, currencyId: dto.currencyId, date, rate: dto.rate, coefficient: dto.coefficient ?? 1 },
      include: { currency: { select: { code: true, name: true } } },
    });
    return this.toDto(item);
  }

  async update(orgId: string, id: string, dto: UpdateExchangeRateDto): Promise<ExchangeRateResponseDto> {
    const existing = await this.prisma.exchangeRate.findFirst({
      where: { id, orgId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Курс валюти не знайдено');

    // Bug #151: зміна дати має поважати унікальність (orgId, currencyId, date).
    // Інакше PATCH на зайняту дату падає на DB P2002 → generic 409 замість
    // локалізованого повідомлення (так само як у create()).
    if (dto.date !== undefined) {
      const newDate = new Date(dto.date);
      if (newDate.getTime() !== existing.date.getTime()) {
        const duplicate = await this.prisma.exchangeRate.findFirst({
          where: { orgId, currencyId: existing.currencyId, date: newDate, NOT: { id }, deletedAt: null },
        });
        if (duplicate) throw new ConflictException('Курс на цю дату вже існує');
      }
    }

    const updateData: Record<string, unknown> = {};
    if (dto.date !== undefined) updateData['date'] = new Date(dto.date);
    if (dto.rate !== undefined) updateData['rate'] = dto.rate;
    if (dto.coefficient !== undefined) updateData['coefficient'] = dto.coefficient;

    const item = await this.prisma.exchangeRate.update({
      where: { id },
      data: updateData,
      include: { currency: { select: { code: true, name: true } } },
    });
    return this.toDto(item);
  }

  async remove(orgId: string, id: string): Promise<void> {
    const existing = await this.prisma.exchangeRate.findFirst({ where: { id, orgId, deletedAt: null } });
    if (!existing) throw new NotFoundException('Курс валюти не знайдено');
    await this.prisma.exchangeRate.update({ where: { id }, data: { deletedAt: new Date() } });
  }

  private toDto(item: {
    id: string; orgId: string; currencyId: string; date: Date;
    rate: Decimal; coefficient: Decimal; createdAt: Date; updatedAt: Date;
    currency: { code: string; name: string };
  }): ExchangeRateResponseDto {
    return {
      id: item.id, orgId: item.orgId, currencyId: item.currencyId,
      currencyCode: item.currency.code, currencyName: item.currency.name,
      date: item.date.toISOString().split('T')[0],
      rate: Number(item.rate), coefficient: Number(item.coefficient),
      createdAt: item.createdAt, updatedAt: item.updatedAt,
    };
  }
}
