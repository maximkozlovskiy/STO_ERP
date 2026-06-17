import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type Redis from 'ioredis';
import { VatMode, BatchCostMethod, DocumentType, ResetPeriod } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { REDIS_CLIENT } from '../../redis/redis.module';
import { NbuFetchScheduler } from '../exchange-rates/nbu-fetch.scheduler';
import {
  BranchSettingsResponseDto,
  OrganisationResponseDto,
  OrganisationSettingsResponseDto,
  UiFeatures,
  UI_FEATURES_DEFAULTS,
  UpdateBranchSettingsDto,
  UpdateOrganisationDto,
  UpdateOrganisationSettingsDto,
} from './settings.dto';

const TTL_SECONDS = 300; // 5 minutes
// Bug #520: getWorkHours викликається на КОЖЕН mount CalendarDayGrid (cold cache на нову сесію).
// Окремий TTL=60s бо work-hours можуть бути швидко змінені адміном у settings;
// інвалідація все одно є у updateBranchSettings — TTL це другий рівень захисту.
const WORK_HOURS_TTL_SECONDS = 60;

@Injectable()
export class SettingsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly nbuFetchScheduler: NbuFetchScheduler,
  ) {}

  async getOrganisationSettings(orgId: string): Promise<OrganisationSettingsResponseDto> {
    const cacheKey = `settings:org:${orgId}`;

    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) return JSON.parse(cached) as OrganisationSettingsResponseDto;
    } catch {
      // Redis unavailable — continue without cache (offline-first)
    }

    let settings = await this.prisma.organisationSettings.findUnique({
      where: { orgId },
    });

    if (!settings) {
      // Upsert defaults
      settings = await this.prisma.organisationSettings.upsert({
        where: { orgId },
        create: { orgId },
        update: {},
      });
    }

    const result = this.mapOrgSettings(settings);

    try {
      await this.redis.set(cacheKey, JSON.stringify(result), 'EX', TTL_SECONDS);
    } catch {
      // ignore
    }

    return result;
  }

  async updateOrganisationSettings(
    orgId: string,
    dto: UpdateOrganisationSettingsDto,
  ): Promise<OrganisationSettingsResponseDto> {
    // Validate currency code belongs to this org (tenant-safe + prevents typos).
    if (dto.currency !== undefined) {
      const exists = await this.prisma.currency.findFirst({
        where: { orgId, code: dto.currency, deletedAt: null },
        select: { id: true },
      });
      if (!exists) {
        throw new BadRequestException(`Валюта з кодом "${dto.currency}" не знайдена`);
      }
    }

    // Merge uiFeatures partially — don't overwrite unset keys.
    // Whitelist allowed keys to prevent unbounded JSON growth via arbitrary payload.
    let updateData: Record<string, unknown> = { ...dto };
    if (dto.uiFeatures !== undefined) {
      // sto-optimize: merge needs only the existing uiFeatures JSON column.
      const current = await this.prisma.organisationSettings.findUnique({
        where: { orgId },
        select: { uiFeatures: true },
      });
      const currentFeatures = this.parseUiFeatures(current?.uiFeatures);
      const patch = this.pickUiFeatureKeys(dto.uiFeatures);
      updateData = { ...dto, uiFeatures: { ...currentFeatures, ...patch } };
    }

    const settings = await this.prisma.organisationSettings.upsert({
      where: { orgId },
      create: { orgId, ...updateData },
      update: updateData,
    });

    await this.invalidateOrgCache(orgId);

    // Reschedule NBU fetch cron if hour changed
    if (dto.nbuFetchHour !== undefined) {
      await this.nbuFetchScheduler.rescheduleForOrg(orgId, dto.nbuFetchHour);
    }

    return this.mapOrgSettings(settings);
  }

  async getBranchSettings(orgId: string, branchId: string): Promise<BranchSettingsResponseDto> {
    const cacheKey = `settings:branch:${orgId}:${branchId}`;

    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) return JSON.parse(cached) as BranchSettingsResponseDto;
    } catch {
      // offline
    }

    // sto-optimize: tenant guard only — branch fields unused; lookup is cache-cold path.
    const branch = await this.prisma.garageBranch.findFirst({
      where: { id: branchId, orgId, deletedAt: null },
      select: { id: true },
    });
    if (!branch) throw new NotFoundException('Філію не знайдено');

    let settings = await this.prisma.branchSettings.findUnique({
      where: { branchId },
    });

    if (settings && settings.orgId !== orgId) throw new NotFoundException('Філію не знайдено');

    if (!settings) {
      settings = await this.prisma.branchSettings.upsert({
        where: { branchId },
        create: { branchId, orgId },
        update: {},
      });
    }

    const result = this.mapBranchSettings(settings);

    try {
      await this.redis.set(cacheKey, JSON.stringify(result), 'EX', TTL_SECONDS);
    } catch {
      // ignore
    }

    return result;
  }

  async getWorkHours(orgId: string): Promise<{ workStartHour: number; workEndHour: number }> {
    // Bug #520: викликається на КОЖЕН mount CalendarDayGrid. До кешу — DB hit
    // (findFirst по orgId з orderBy за nested relation `branch.createdAt`).
    // Cache 60s + invalidation у updateBranchSettings → 1 DB hit / 60s / orgId.
    const cacheKey = `settings:work-hours:${orgId}`;
    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) return JSON.parse(cached) as { workStartHour: number; workEndHour: number };
    } catch {
      // Redis unavailable — continue without cache (offline-first)
    }

    const settings = await this.prisma.branchSettings.findFirst({
      where: { orgId, branch: { deletedAt: null } },
      select: { workStartTime: true, workEndTime: true },
      orderBy: { branch: { createdAt: 'asc' } },
    });
    // parseInt('00', 10) === 0 → use Number.isFinite() check (0 is valid 24/7 start hour).
    // Fallbacks aligned with BranchSettings Prisma defaults (09:00 / 18:00) to match booking.service.ts.
    const parseHour = (t: string | undefined, fallback: number) => {
      if (!t) return fallback;
      const h = parseInt(t.split(':')[0]!, 10);
      return Number.isFinite(h) && h >= 0 && h <= 23 ? h : fallback;
    };
    const workStartHour = parseHour(settings?.workStartTime, 9);
    const workEndHour = parseHour(settings?.workEndTime, 18);
    // Bug #515 defense-in-depth: defensive guard проти інвертованих часів у БД
    // (legacy/corrupt data до додавання Matches regex у DTO). Інакше frontend
    // dynHours = Array.from({ length: workEndHour - workStartHour }) дасть [] для
    // негативної довжини → дільник 0 → NaN у CSS → DOM crash. Повертаємо fallback
    // діапазон щоб calendar лишався працездатним; адмін бачить grid 09-18 поки
    // не виправить settings.
    const result =
      workEndHour <= workStartHour
        ? { workStartHour: 9, workEndHour: 18 }
        : { workStartHour, workEndHour };

    try {
      await this.redis.set(cacheKey, JSON.stringify(result), 'EX', WORK_HOURS_TTL_SECONDS);
    } catch {
      // ignore
    }

    return result;
  }

  async invalidateWorkHoursCache(orgId: string): Promise<void> {
    try {
      await this.redis.del(`settings:work-hours:${orgId}`);
    } catch {
      // ignore
    }
  }

  async updateBranchSettings(
    orgId: string,
    branchId: string,
    dto: UpdateBranchSettingsDto,
  ): Promise<BranchSettingsResponseDto> {
    // sto-optimize: tenant guard only — narrow projection.
    const branch = await this.prisma.garageBranch.findFirst({
      where: { id: branchId, orgId, deletedAt: null },
      select: { id: true },
    });
    if (!branch) throw new NotFoundException('Філію не знайдено');

    // Bug #515 cross-field guard: workEndTime повинен бути після workStartTime.
    // Reading current settings (якщо лише одне поле у PATCH) — merge з incoming.
    if (dto.workStartTime !== undefined || dto.workEndTime !== undefined) {
      const current = await this.prisma.branchSettings.findUnique({
        where: { branchId },
        select: { workStartTime: true, workEndTime: true },
      });
      const effStart = dto.workStartTime ?? current?.workStartTime ?? '09:00';
      const effEnd = dto.workEndTime ?? current?.workEndTime ?? '18:00';
      // Compare as minutes-since-midnight; safe бо @Matches regex прибив невалідний format.
      const toMin = (t: string) => {
        const [h, m] = t.split(':').map(Number);
        return (h ?? 0) * 60 + (m ?? 0);
      };
      if (toMin(effEnd) <= toMin(effStart)) {
        throw new BadRequestException('Час кінця роботи повинен бути після часу початку');
      }
    }

    const settings = await this.prisma.branchSettings.upsert({
      where: { branchId },
      create: { branchId, orgId, ...dto },
      update: dto,
    });

    await this.invalidateBranchCache(orgId, branchId);
    // Bug #520: work-hours кеш orgId-scope (один на org незалежно від branch),
    // інвалідуємо тільки коли workStartTime/workEndTime реально змінилися щоб
    // не плодити cache misses при PATCH-ах інших полів (smsEnabled, fiscalEnabled).
    if (dto.workStartTime !== undefined || dto.workEndTime !== undefined) {
      await this.invalidateWorkHoursCache(orgId);
    }

    return this.mapBranchSettings(settings);
  }

  async invalidateOrgCache(orgId: string): Promise<void> {
    try {
      await this.redis.del(`settings:org:${orgId}`);
    } catch {
      // ignore
    }
  }

  async invalidateBranchCache(orgId: string, branchId: string): Promise<void> {
    try {
      await this.redis.del(`settings:branch:${orgId}:${branchId}`);
    } catch {
      // ignore
    }
  }

  /**
   * Returns full UiFeatures object — known boolean keys merged with defaults.
   * Used for READ path (response, cache); guards against legacy junk in DB.
   */
  private parseUiFeatures(raw: unknown): UiFeatures {
    return { ...UI_FEATURES_DEFAULTS, ...this.pickUiFeatureKeys(raw) };
  }

  /**
   * Returns only the whitelisted boolean keys actually present in `raw`.
   * Used for WRITE path — caller merges with current DB state, so defaults
   * MUST NOT be filled in (would overwrite unrelated keys not in user's PATCH).
   */
  private pickUiFeatureKeys(raw: unknown): Partial<UiFeatures> {
    const stored =
      typeof raw === 'object' && raw !== null && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {};
    const allowedKeys = Object.keys(UI_FEATURES_DEFAULTS) as (keyof UiFeatures)[];
    const sanitized: Partial<UiFeatures> = {};
    for (const k of allowedKeys) {
      const v = stored[k];
      if (typeof v === 'boolean') sanitized[k] = v;
    }
    return sanitized;
  }

  private mapOrgSettings(s: {
    orgId: string;
    currency: string;
    vatMode: VatMode;
    defaultVatRateId: string | null;
    invoiceDueDays: number;
    autoArchiveDays: number;
    defaultWarrantyDays: number;
    requireClientApproval: boolean;
    allowPartialPayment: boolean;
    brandTheme: string;
    costMethod: BatchCostMethod;
    followUpActive: boolean;
    followUpDays: number;
    nbuFetchHour: number;
    uiFeatures: unknown;
    loyaltyEnabled: boolean;
    loyaltyEarnPer: { toNumber(): number } | number;
    loyaltyEarnPoints: { toNumber(): number } | number;
    loyaltyRedeemRate: { toNumber(): number } | number;
    recalcPlannedHoursFromLines: boolean;
    recalcActualHoursFromLines: boolean;
    syncCalendarSlotWithPlannedHours: boolean;
    updatedAt: Date;
  }): OrganisationSettingsResponseDto {
    const toNum = (v: { toNumber(): number } | number) =>
      typeof v === 'object' ? v.toNumber() : v;
    return {
      orgId: s.orgId,
      currency: s.currency,
      vatMode: s.vatMode,
      defaultVatRateId: s.defaultVatRateId,
      invoiceDueDays: s.invoiceDueDays,
      autoArchiveDays: s.autoArchiveDays,
      defaultWarrantyDays: s.defaultWarrantyDays,
      requireClientApproval: s.requireClientApproval,
      allowPartialPayment: s.allowPartialPayment,
      brandTheme: s.brandTheme,
      costMethod: s.costMethod,
      followUpActive: s.followUpActive,
      followUpDays: s.followUpDays,
      nbuFetchHour: s.nbuFetchHour,
      uiFeatures: this.parseUiFeatures(s.uiFeatures),
      loyaltyEnabled: s.loyaltyEnabled,
      loyaltyEarnPer: toNum(s.loyaltyEarnPer),
      loyaltyEarnPoints: toNum(s.loyaltyEarnPoints),
      loyaltyRedeemRate: toNum(s.loyaltyRedeemRate),
      recalcPlannedHoursFromLines: s.recalcPlannedHoursFromLines,
      recalcActualHoursFromLines: s.recalcActualHoursFromLines,
      syncCalendarSlotWithPlannedHours: s.syncCalendarSlotWithPlannedHours,
      updatedAt: s.updatedAt,
    };
  }

  private mapBranchSettings(s: {
    branchId: string;
    orgId: string;
    workStartTime: string;
    workEndTime: string;
    workDays: unknown;
    slotDurationMinutes: number;
    fiscalEnabled: boolean;
    checkboxApiUrl: string | null;
    checkboxCashRegisterId: string | null;
    smsEnabled: boolean;
    smsProvider: string | null;
    smsSenderName: string | null;
    updatedAt: Date;
  }): BranchSettingsResponseDto {
    return {
      branchId: s.branchId,
      orgId: s.orgId,
      workStartTime: s.workStartTime,
      workEndTime: s.workEndTime,
      workDays: Array.isArray(s.workDays) ? (s.workDays as number[]) : [],
      slotDurationMinutes: s.slotDurationMinutes,
      fiscalEnabled: s.fiscalEnabled,
      checkboxApiUrl: s.checkboxApiUrl,
      checkboxCashRegisterId: s.checkboxCashRegisterId,
      smsEnabled: s.smsEnabled,
      smsProvider: s.smsProvider,
      smsSenderName: s.smsSenderName,
      updatedAt: s.updatedAt,
    };
  }

  async getDocumentNumbers(orgId: string) {
    const configs = await this.prisma.documentNumberConfig.findMany({
      where: { orgId },
      orderBy: { documentType: 'asc' },
      take: 100,
    });
    return configs.map(c => ({
      id: c.id,
      documentType: c.documentType,
      prefix: c.prefix,
      includeDate: c.includeDate,
      separator: c.separator,
      padding: c.padding,
      currentSeq: Number(c.currentSeq),
      resetPeriod: c.resetPeriod,
      updatedAt: c.updatedAt,
    }));
  }

  async updateDocumentNumber(
    orgId: string,
    documentType: string,
    dto: {
      prefix?: string | null;
      includeDate?: boolean;
      separator?: string;
      padding?: number;
      resetPeriod?: string;
    },
  ) {
    const cfg = await this.prisma.documentNumberConfig.findFirst({
      where: { orgId, documentType: documentType as DocumentType },
    });
    if (!cfg) throw new NotFoundException('Конфігурацію не знайдено');
    const updated = await this.prisma.documentNumberConfig.update({
      where: { id: cfg.id },
      data: {
        prefix: dto.prefix !== undefined ? dto.prefix : undefined,
        includeDate: dto.includeDate !== undefined ? dto.includeDate : undefined,
        separator: dto.separator ?? undefined,
        padding: dto.padding ?? undefined,
        resetPeriod: dto.resetPeriod !== undefined ? (dto.resetPeriod as ResetPeriod) : undefined,
      },
    });
    return {
      id: updated.id,
      documentType: updated.documentType,
      prefix: updated.prefix,
      includeDate: updated.includeDate,
      separator: updated.separator,
      padding: updated.padding,
      currentSeq: Number(updated.currentSeq),
      resetPeriod: updated.resetPeriod,
      updatedAt: updated.updatedAt,
    };
  }

  async resetDocumentNumber(orgId: string, documentType: string) {
    const cfg = await this.prisma.documentNumberConfig.findFirst({
      where: { orgId, documentType: documentType as DocumentType },
    });
    if (!cfg) throw new NotFoundException('Конфігурацію не знайдено');
    await this.prisma.documentNumberConfig.update({
      where: { id: cfg.id },
      data: { currentSeq: 0 },
    });
    return { message: 'Лічильник скинуто' };
  }

  // sto-review §13: explicit VatMode literal union у return type — інакше консумери
  // (purchase-orders.service.ts, work-orders.service.ts) змушені робити
  // `as 'NONE' | 'EXCLUSIVE' | 'INCLUSIVE'` каст на кожному виклику. Прямий enum
  // повертається з Prisma → передаємо як є.
  async getDefaultVatRate(orgId: string): Promise<{ vatMode: VatMode; vatRate: number }> {
    const settings = await this.getOrganisationSettings(orgId);
    if (settings.vatMode === VatMode.NONE) return { vatMode: VatMode.NONE, vatRate: 0 };
    const taxRate = settings.defaultVatRateId
      ? await this.prisma.taxRate.findFirst({
          where: { id: settings.defaultVatRateId, orgId },
          select: { rate: true },
        })
      : await this.prisma.taxRate.findFirst({
          where: { orgId, isDefault: true, isActive: true },
          select: { rate: true },
        });
    return { vatMode: settings.vatMode, vatRate: Number(taxRate?.rate ?? 0) };
  }

  async getTaxRates(orgId: string) {
    const rates = await this.prisma.taxRate.findMany({
      where: { orgId },
      orderBy: { rate: 'asc' },
      take: 100,
    });
    return rates.map(r => ({
      id: r.id,
      name: r.name,
      rate: Number(r.rate),
      isDefault: r.isDefault,
      isActive: r.isActive,
    }));
  }

  async createTaxRate(
    orgId: string,
    dto: { name: string; rate: number; isDefault?: boolean; isActive?: boolean },
  ) {
    // Bug #357: коли створюється новий isDefault=true → unset попередні defaults
    // у тому ж orgId scope атомарно. Без цього multiple defaults можливі (немає
    // unique index `[orgId, isDefault]` у schema), і `getDefaultTaxRate()` буде
    // повертати випадковий результат.
    const rate = dto.isDefault
      ? await this.prisma.$transaction(async tx => {
          await tx.taxRate.updateMany({
            where: { orgId, isDefault: true },
            data: { isDefault: false },
          });
          return tx.taxRate.create({
            data: {
              orgId,
              name: dto.name,
              rate: dto.rate,
              isDefault: true,
              isActive: dto.isActive ?? true,
            },
          });
        })
      : await this.prisma.taxRate.create({
          data: {
            orgId,
            name: dto.name,
            rate: dto.rate,
            isDefault: false,
            isActive: dto.isActive ?? true,
          },
        });
    return {
      id: rate.id,
      name: rate.name,
      rate: Number(rate.rate),
      isDefault: rate.isDefault,
      isActive: rate.isActive,
    };
  }

  async updateTaxRate(
    orgId: string,
    id: string,
    dto: { name?: string; rate?: number; isDefault?: boolean; isActive?: boolean },
  ) {
    // Bug #357: коли встановлюється isDefault=true → unset попередні defaults
    // у тому ж orgId scope (виключаючи поточний id) атомарно.
    if (dto.isDefault === true) {
      await this.prisma.$transaction(async tx => {
        await tx.taxRate.updateMany({
          where: { orgId, isDefault: true, NOT: { id } },
          data: { isDefault: false },
        });
        // Defense-in-depth: updateMany with orgId guard (sto-review pattern 2026-05-30).
        const result = await tx.taxRate.updateMany({
          where: { id, orgId },
          data: {
            name: dto.name ?? undefined,
            rate: dto.rate ?? undefined,
            isDefault: true,
            isActive: dto.isActive ?? undefined,
          },
        });
        if (result.count === 0) throw new NotFoundException('Ставку ПДВ не знайдено');
      });
    } else {
      // Defense-in-depth: updateMany with orgId guard (sto-review pattern 2026-05-30).
      const result = await this.prisma.taxRate.updateMany({
        where: { id, orgId },
        data: {
          name: dto.name ?? undefined,
          rate: dto.rate ?? undefined,
          isDefault: dto.isDefault ?? undefined,
          isActive: dto.isActive ?? undefined,
        },
      });
      if (result.count === 0) throw new NotFoundException('Ставку ПДВ не знайдено');
    }
    const updated = await this.prisma.taxRate.findFirstOrThrow({ where: { id, orgId } });
    return {
      id: updated.id,
      name: updated.name,
      rate: Number(updated.rate),
      isDefault: updated.isDefault,
      isActive: updated.isActive,
    };
  }

  async deleteTaxRate(orgId: string, id: string) {
    // TaxRate is referenced indirectly through invoices/lines (по rate as decimal).
    // Hard delete would lose audit trail. We soft-deactivate via isActive=false.
    const existing = await this.prisma.taxRate.findFirst({ where: { id, orgId } });
    if (!existing) throw new NotFoundException('Ставку ПДВ не знайдено');
    if (existing.isDefault)
      throw new BadRequestException('Не можна видалити ставку за замовчуванням');
    // Defense-in-depth: updateMany with orgId guard (sto-review pattern 2026-05-30).
    const result = await this.prisma.taxRate.updateMany({
      where: { id, orgId },
      data: { isActive: false },
    });
    if (result.count === 0) throw new NotFoundException('Ставку ПДВ не знайдено');
  }

  private readonly orgSelect = {
    id: true,
    orgId: true,
    name: true,
    edrpou: true,
    logoUrl: true,
    legalAddress: true,
    actualAddress: true,
    bankAccountId: true,
    updatedAt: true,
  } as const;

  async getOrganisation(orgId: string): Promise<OrganisationResponseDto> {
    const org = await this.prisma.organisation.findFirst({
      where: { orgId, deletedAt: null },
      select: this.orgSelect,
    });
    if (!org) throw new NotFoundException('Організацію не знайдено');
    return this.mapOrganisation(org);
  }

  async updateOrganisation(
    orgId: string,
    dto: UpdateOrganisationDto,
  ): Promise<OrganisationResponseDto> {
    // Perf: tenant guard + optional bankAccount FK validation — обидва tenant-isolated,
    // не залежать один від одного → Promise.all (-1 RTT коли bankAccountId присутній).
    const [org, ba] = await Promise.all([
      this.prisma.organisation.findFirst({
        where: { orgId, deletedAt: null },
        select: { id: true },
      }),
      dto.bankAccountId
        ? this.prisma.bankAccount.findFirst({
            where: { id: dto.bankAccountId, orgId, deletedAt: null },
            select: { id: true },
          })
        : Promise.resolve(null),
    ]);
    if (!org) throw new NotFoundException('Організацію не знайдено');
    if (dto.bankAccountId && !ba) throw new NotFoundException('Банківський рахунок не знайдено');

    const updated = await this.prisma.organisation.update({
      where: { id: org.id },
      data: dto,
      select: this.orgSelect,
    });
    return this.mapOrganisation(updated);
  }

  private mapOrganisation(org: {
    id: string;
    orgId: string;
    name: string;
    edrpou: string | null;
    logoUrl?: string | null;
    legalAddress?: string | null;
    actualAddress?: string | null;
    bankAccountId?: string | null;
    updatedAt: Date;
  }): OrganisationResponseDto {
    return {
      id: org.id,
      orgId: org.orgId,
      name: org.name,
      edrpou: org.edrpou,
      logoUrl: org.logoUrl ?? null,
      legalAddress: org.legalAddress ?? null,
      actualAddress: org.actualAddress ?? null,
      bankAccountId: org.bankAccountId ?? null,
      updatedAt: org.updatedAt,
    };
  }
}
