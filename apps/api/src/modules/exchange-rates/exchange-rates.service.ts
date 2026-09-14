import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '../../prisma/prisma.service';
import { convertToBase } from '../../common/utils/currency';
import { kyivYmd } from '../../common/utils/kyiv-date';
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

    const [items, total] = await Promise.all([
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

  /**
   * Курс валюти на дату — найближчий запис із date ≤ вказаної (для мультивалютної конвертації
   * amountBase). null якщо курсу немає жодного ≤ date. date нормалізується до UTC-півночі (@db.Date).
   */
  async getRateAsOf(
    orgId: string,
    currencyId: string,
    date: Date,
    fallbackToLatest = false,
  ): Promise<{ rate: number; coefficient: number } | null> {
    // Kyiv-доба, не UTC: курси НБУ зберігаються під Kyiv-датою (nbu-fetch), а `date` тут — інстант
    // операції (new Date()). UTC-зріз давав би минулий день у вікні 00:00–03:00 Kyiv (EEST) →
    // хибний rate або спурйозна 400 «немає курсу». kyivYmd вирівнює lookup із записом (DST-aware).
    const asOf = new Date(`${kyivYmd(date)}T00:00:00.000Z`);
    const row = await this.prisma.exchangeRate.findFirst({
      where: { orgId, currencyId, deletedAt: null, date: { lte: asOf } },
      orderBy: { date: 'desc' },
      select: { rate: true, coefficient: true },
    });
    if (row) return { rate: Number(row.rate), coefficient: Number(row.coefficient) };
    // Фаза 3 (opt-in): документні потоки допускають fallback на ОСТАННІЙ наявний курс (будь-яка дата),
    // якщо на/до дати події курсу немає. Каса/Payment (strict) НЕ передають fallbackToLatest → 400.
    if (fallbackToLatest) {
      const latest = await this.prisma.exchangeRate.findFirst({
        where: { orgId, currencyId, deletedAt: null },
        orderBy: { date: 'desc' },
        select: { rate: true, coefficient: true },
      });
      if (latest) return { rate: Number(latest.rate), coefficient: Number(latest.coefficient) };
    }
    return null;
  }

  /**
   * Резолвить пару (rateUsed, amountBase) для суми у заданій валюті на дату.
   * Базова валюта org (OrganisationSettings.currency за кодом) → {rateUsed:1, amountBase:amount}.
   * Інакше — курс на дату (getRateAsOf); якщо курсу немає → 400 (НЕ тихо rate=1: це спотворило б
   * base-облік). Спільна точка мультивалютної конвертації для всіх грошових агрегатів.
   */
  /** Базова валюта org (за OrganisationSettings.currency code) → {id?, code}. code завжди (default UAH). */
  async getBaseCurrency(orgId: string): Promise<{ id: string | null; code: string }> {
    const settings = await this.prisma.organisationSettings.findFirst({
      where: { orgId },
      select: { currency: true },
    });
    const code = settings?.currency ?? 'UAH';
    const cur = await this.prisma.currency.findFirst({
      where: { orgId, code, deletedAt: null },
      select: { id: true },
    });
    return { id: cur?.id ?? null, code };
  }

  /**
   * Чи однакова валюта двох сторін (оплата ↔ документ). NULL трактується як БАЗОВА валюта org
   * (історичні документи / джерело без валюти) → NULL ≡ base. Резолв base-id лениво: лише коли
   * a≠b і треба з'ясувати чи одна зі сторін = base. ЄДИНЕ джерело правди для крос-валютного guard-а
   * (Фаза 3-5): payments/invoices/supplier-payments валідують валюту оплати проти валюти документа.
   */
  async sameCurrency(orgId: string, a: string | null, b: string | null): Promise<boolean> {
    if (a === b) return true;
    const baseId = (await this.getBaseCurrency(orgId)).id;
    const norm = (v: string | null) => v ?? baseId;
    return norm(a) === norm(b);
  }

  async resolveBaseConversion(
    orgId: string,
    currencyId: string,
    date: Date,
    amount: number,
    fallbackToLatest = false,
  ): Promise<{ rateUsed: number; amountBase: number }> {
    const [currency, settings] = await Promise.all([
      this.prisma.currency.findFirst({
        where: { id: currencyId, orgId, deletedAt: null },
        select: { code: true },
      }),
      this.prisma.organisationSettings.findFirst({
        where: { orgId },
        select: { currency: true },
      }),
    ]);
    if (!currency) throw new NotFoundException('Валюту не знайдено');
    const baseCode = settings?.currency ?? 'UAH';
    // Базова валюта — без конвертації (rate=1). Порівнюємо за кодом (base зберігається кодом).
    if (currency.code === baseCode) {
      return { rateUsed: 1, amountBase: amount };
    }
    const asOf = await this.getRateAsOf(orgId, currencyId, date, fallbackToLatest);
    if (!asOf) {
      throw new BadRequestException(
        `Немає курсу валюти ${currency.code} на ${kyivYmd(date)} — додайте курс у НДІ → Курси валют`,
      );
    }
    return {
      rateUsed: asOf.rate,
      amountBase: convertToBase(amount, asOf.rate, asOf.coefficient),
    };
  }

  async create(orgId: string, dto: CreateExchangeRateDto): Promise<ExchangeRateResponseDto> {
    const date = parseDateOnly(dto.date);
    // Parallel: currency FK validation + existing-row dup check — both scoped by orgId,
    // independent reads — collapse у Promise.all (-1 RTT).
    const [currency, anyExisting] = await Promise.all([
      this.prisma.currency.findFirst({
        where: { id: dto.currencyId, orgId, deletedAt: null },
        select: { id: true },
      }),
      // sto-optimize: only id + deletedAt consumed (resurrect-vs-conflict branch).
      this.prisma.exchangeRate.findFirst({
        where: { orgId, currencyId: dto.currencyId, date },
        select: { id: true, deletedAt: true },
      }),
    ]);
    if (!currency) throw new NotFoundException('Валюту не знайдено');
    if (anyExisting) {
      if (!anyExisting.deletedAt) throw new ConflictException('Курс на цю дату вже існує');
      // Soft-deleted row occupies the unique index — resurrect it
      const restored = await this.prisma.exchangeRate.update({
        where: { id: anyExisting.id, orgId },
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

    // Date change must respect the unique index (orgId, currencyId, date): without this
    // check a PATCH on an occupied date hits DB P2002 → generic 409 instead of a
    // localized message (same invariant as create()).
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
      createdAt: item.createdAt instanceof Date ? item.createdAt.toISOString() : item.createdAt,
      updatedAt: item.updatedAt instanceof Date ? item.updatedAt.toISOString() : item.updatedAt,
    };
  }
}
