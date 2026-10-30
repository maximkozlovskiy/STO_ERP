import { createHash } from 'node:crypto';
import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type Redis from 'ioredis';
import {
  Prisma,
  VatMode,
  BatchCostMethod,
  DocumentType,
  ResetPeriod,
  type CashOperationReason,
  type SupplierAnalogPolicy,
  type SupplierOrderSendMode,
  type SupplierStrategy,
} from '@prisma/client';
import { ENCRYPTED_FIELDS, PrismaService } from '../../prisma/prisma.service';
import { REDIS_CLIENT } from '../../redis/redis.module';
import { NbuFetchScheduler } from '../exchange-rates/nbu-fetch.scheduler';
import { BankStatementPullScheduler } from '../bank-statements/bank-statement-pull.scheduler';
import { AuditService } from '../audit/audit.service';
import {
  lookupAllAddresses,
  validatePublicUrlResolved,
  type HostLookup,
} from '../../common/utils/url-guard';
import { HOST_LOOKUP } from '../../common/utils/host-lookup.token';
import { sameApiUrl } from '../../common/utils/trim-trailing-slashes';
import { workHoursOf } from '../../common/utils/work-hours';
import { PNL_SETTINGS_DEFAULTS, translateError } from '@sto/shared';
import { getLocale } from '../../common/tenant/tenant-context';
import {
  BranchSettingsResponseDto,
  OrganisationResponseDto,
  OrganisationCardSettingsDto,
  OrganisationSettingsResponseDto,
  UiFeatures,
  UI_FEATURES_DEFAULTS,
  UpdateBranchSettingsDto,
  UpdateOrganisationDto,
  UpdateOrganisationSettingsDto,
} from './settings.dto';

const TTL_SECONDS = 300; // 5 minutes
// Separate TTL=60s for work-hours: getWorkHours is called on every CalendarDayGrid mount (cold
// cache on new session); shorter TTL reflects that admins can change work hours quickly.
// Cache invalidation in updateBranchSettings is the primary mechanism; TTL is defense-in-depth.
const WORK_HOURS_TTL_SECONDS = 60;

/**
 * Відбиток схеми моделі для ключа кешу: хеш переліку її скалярних полів із Prisma.
 *
 * ЧОМУ: кеш зберігає вже змаплений DTO. Після оновлення з новою колонкою (2026-10-18: поля
 * `supplier*`) старий об'єкт із Redis жив до TTL без нових полів → `supplierOfferTtlMinutes`
 * undefined → `POST /supplier-offers/search` 400. Ручна «версія кешу» забувається при наступній
 * міграції; відбиток від реального переліку полів змінюється сам — старі ключі просто не читаються
 * і зникають за TTL.
 */
export function schemaFingerprint(fields: Record<string, string>): string {
  return createHash('sha1').update(Object.keys(fields).sort().join(',')).digest('hex').slice(0, 8);
}

const ORG_SETTINGS_CACHE_VERSION = schemaFingerprint(Prisma.OrganisationSettingsScalarFieldEnum);
const BRANCH_SETTINGS_CACHE_VERSION = schemaFingerprint(Prisma.BranchSettingsScalarFieldEnum);

/** Ключ кешу налаштувань організації — з відбитком схеми (див. `schemaFingerprint`). */
export function orgSettingsCacheKey(orgId: string): string {
  return `settings:org:${ORG_SETTINGS_CACHE_VERSION}:${orgId}`;
}

function branchSettingsCacheKey(orgId: string, branchId: string): string {
  return `settings:branch:${BRANCH_SETTINGS_CACHE_VERSION}:${orgId}:${branchId}`;
}

/** Ключ кешу годин: основна філія організації або конкретна філія. */
function workHoursCacheKey(orgId: string, branchId?: string): string {
  return branchId ? `settings:work-hours:${orgId}:${branchId}` : `settings:work-hours:${orgId}`;
}

/**
 * Ключ кешу ставок ПДВ організації. Список читають картки документів при кожному відкритті;
 * скидається в createTaxRate / updateTaxRate / deleteTaxRate, TTL — запасний механізм.
 */
function taxRatesCacheKey(orgId: string): string {
  return `settings:tax-rates:${orgId}`;
}

/** Ставка ПДВ у відповіді `GET /settings/tax-rates` (і в кеші). */
interface TaxRateResponse {
  id: string;
  name: string;
  rate: number;
  isDefault: boolean;
  isActive: boolean;
}

/** Значення, що заміняє секрет у сліді аудиту: видно, що ключ змінили, але не який він. */
export const AUDIT_SECRET_MASK = '***';

/**
 * Секретні поля моделі (ліцензійний ключ і PIN ПРРО, токен monobank, ключ SMS) у дифі аудиту —
 * маскою (Bug #951). Їх шифрує Prisma-розширення at-rest, а `GET /settings/branch` не віддає
 * зовсім, тоді як аудит (`GET /audit`, ролі OWNER/ADMIN/ACCOUNTANT) віддавав відкритий текст.
 * `null` і порожній рядок лишаються як є — «ключ прибрали» теж частина сліду.
 */
function maskSecrets(
  entityType: string,
  data: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const secrets = ENCRYPTED_FIELDS[entityType];
  if (!data || !secrets) return data;
  const out: Record<string, unknown> = { ...data };
  for (const k of secrets) {
    if (out[k] !== undefined && out[k] !== null && out[k] !== '') out[k] = AUDIT_SECRET_MASK;
  }
  return out;
}

@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly nbuFetchScheduler: NbuFetchScheduler,
    private readonly bankPullScheduler: BankStatementPullScheduler,
    private readonly audit: AuditService,
    // Один спільний DNS-резолвер для SSRF resolved-перевірки адрес провайдера при збереженні
    // філії. Інжектиться через DI (дефолт `lookupAllAddresses`), бо перевірка викликається з
    // HTTP-шляху; тест-модуль перевизначає токен фейком і не ходить у справжній DNS.
    @Inject(HOST_LOOKUP) private readonly lookup: HostLookup = lookupAllAddresses,
  ) {}

  /** C1b: best-effort аудит зміни налаштувань (post-commit, не блокує). */
  private auditSettings(
    orgId: string,
    entityType: string,
    entityId: string,
    action: 'CREATE' | 'UPDATE' | 'DELETE',
    userId: string | undefined,
    oldData?: Record<string, unknown>,
    newData?: Record<string, unknown>,
  ): void {
    if (!userId) return;
    this.audit
      .record(
        orgId,
        entityType,
        entityId,
        action,
        userId,
        maskSecrets(entityType, oldData),
        maskSecrets(entityType, newData),
      )
      .catch((e: unknown) =>
        this.logger.warn(`Audit record failed: ${e instanceof Error ? e.message : e}`),
      );
  }

  async getOrganisationSettings(orgId: string): Promise<OrganisationSettingsResponseDto> {
    const cacheKey = orgSettingsCacheKey(orgId);

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

  /**
   * Поля налаштувань організації для картки наряду — те, що читає механік (рішення власника
   * 2026-10-16). Явний перелік, а не «усе крім»: нове поле налаштувань не потрапить механіку,
   * доки його сюди не додадуть.
   */
  async getOrganisationCardSettings(orgId: string): Promise<OrganisationCardSettingsDto> {
    const s = await this.getOrganisationSettings(orgId);
    return {
      currency: s.currency,
      vatMode: s.vatMode,
      defaultVatRateId: s.defaultVatRateId ?? null,
      language: s.language,
      recalcPlannedHoursFromLines: s.recalcPlannedHoursFromLines,
      recalcActualHoursFromLines: s.recalcActualHoursFromLines,
    };
  }

  async updateOrganisationSettings(
    orgId: string,
    dto: UpdateOrganisationSettingsDto,
    userId?: string,
  ): Promise<OrganisationSettingsResponseDto> {
    // Validate currency code belongs to this org (tenant-safe + prevents typos).
    if (dto.currency !== undefined) {
      const exists = await this.prisma.currency.findFirst({
        where: { orgId, code: dto.currency, deletedAt: null },
        select: { id: true },
      });
      if (!exists) {
        throw new BadRequestException(
          translateError('err.settings.currencyNotFound', getLocale(), { code: dto.currency }),
        );
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

    // Reschedule bank-statement pull cron if interval changed (Privat24 auto-pull).
    if (dto.bankStatementPollIntervalMinutes !== undefined) {
      await this.bankPullScheduler.rescheduleForOrg(orgId, dto.bankStatementPollIntervalMinutes);
    }

    // C1b: аудит зміни org-налаштувань (хто змінив ПДВ/валюту/config). new = поля dto.
    this.auditSettings(orgId, 'OrganisationSettings', orgId, 'UPDATE', userId, undefined, {
      ...dto,
    });

    return this.mapOrgSettings(settings);
  }

  async getBranchSettings(orgId: string, branchId: string): Promise<BranchSettingsResponseDto> {
    const cacheKey = branchSettingsCacheKey(orgId, branchId);

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
    if (!branch) throw new NotFoundException(translateError('err.branch.notFound', getLocale()));

    let settings = await this.prisma.branchSettings.findUnique({
      where: { branchId },
    });

    if (settings && settings.orgId !== orgId)
      throw new NotFoundException(translateError('err.branch.notFound', getLocale()));

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

  /**
   * Робочі години філії (`branchId`) або основної — першої створеної — філії організації.
   * Розбір і типові години — ті самі, що в календарі (`workHoursOf`, 09–18): сітка, пікер
   * планових дат наряду й сервер, що ділить запис на дні та перевіряє BR-WO-019, бачать однакові
   * межі. Філія чужої організації чи без налаштувань — типові години, не 404: години не секрет,
   * а відповідь не каже, чи існує чужа філія.
   */
  async getWorkHours(
    orgId: string,
    branchId?: string,
  ): Promise<{ workStartHour: number; workEndHour: number }> {
    const cacheKey = workHoursCacheKey(orgId, branchId);
    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) return JSON.parse(cached) as { workStartHour: number; workEndHour: number };
    } catch {
      // Redis unavailable — continue without cache (offline-first)
    }

    const settings = await this.prisma.branchSettings.findFirst({
      where: { orgId, ...(branchId ? { branchId } : {}), branch: { deletedAt: null } },
      select: { workStartTime: true, workEndTime: true },
      orderBy: { branch: { createdAt: 'asc' } },
    });
    // Невалідний час чи кінець не пізніше початку (дані до валідації DTO, Bug #515) → типові
    // години цілком: інакше сітка календаря отримала б від'ємну кількість годин.
    const { startHour, endHour } = workHoursOf(settings);
    const result = { workStartHour: startHour, workEndHour: endHour };

    try {
      await this.redis.set(cacheKey, JSON.stringify(result), 'EX', WORK_HOURS_TTL_SECONDS);
    } catch {
      // ignore
    }

    return result;
  }

  async invalidateWorkHoursCache(orgId: string, branchId?: string): Promise<void> {
    try {
      // Години основної філії (без branchId) могли змінитись разом із годинами будь-якої філії.
      await this.redis.del(
        workHoursCacheKey(orgId),
        ...(branchId ? [workHoursCacheKey(orgId, branchId)] : []),
      );
    } catch {
      // ignore
    }
  }

  async updateBranchSettings(
    orgId: string,
    branchId: string,
    dto: UpdateBranchSettingsDto,
    userId?: string,
  ): Promise<BranchSettingsResponseDto> {
    // sto-optimize: tenant guard only — narrow projection.
    const branch = await this.prisma.garageBranch.findFirst({
      where: { id: branchId, orgId, deletedAt: null },
      select: { id: true },
    });
    if (!branch) throw new NotFoundException(translateError('err.branch.notFound', getLocale()));

    // SSRF-захист при ЗБЕРЕЖЕННІ: будь-яке поле адреси провайдера (`*ApiUrl`), присутнє у dto,
    // перевіряється після DNS ще до upsert — приватна/loopback/метадані-адреса не осідає в
    // налаштуваннях і не піде в запити ПРРО/еквайрингу пізніше (BR-SEC-SSRF). Причина вже укр.
    for (const [key, value] of Object.entries(dto)) {
      if (!key.endsWith('ApiUrl') || typeof value !== 'string' || !value.trim()) continue;
      const urlError = await validatePublicUrlResolved(value, this.lookup);
      if (urlError) throw new BadRequestException(urlError);
    }

    // Cross-field guard: workEndTime must be after workStartTime. Read current settings
    // (if only one field in PATCH) and merge with incoming before comparing.
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
        throw new BadRequestException(
          translateError('err.settings.workEndAfterStart', getLocale()),
        );
      }
    }

    const secretsReset = await this.secretsResetOnUrlChange(branchId, dto);
    const settings = await this.prisma.branchSettings.upsert({
      where: { branchId },
      create: { branchId, orgId, ...dto },
      update: { ...dto, ...secretsReset },
    });

    await this.invalidateBranchCache(orgId, branchId);
    // Invalidate the work-hours cache only when workStartTime/workEndTime actually changed — not on
    // every PATCH (smsEnabled, fiscalEnabled, etc.).
    if (dto.workStartTime !== undefined || dto.workEndTime !== undefined) {
      await this.invalidateWorkHoursCache(orgId, branchId);
    }

    this.auditSettings(orgId, 'BranchSettings', branchId, 'UPDATE', userId, undefined, {
      ...dto,
      ...secretsReset,
    });

    return this.mapBranchSettings(settings);
  }

  /**
   * Змінено адресу API Checkbox / monobank, а ключі цього провайдера в запиті не передано — збережені
   * скидаються в null. Write-only ключ не має піти на адресу, яку не підтвердили введенням ключа:
   * інакше OWNER/ADMIN перенаправив би його на свій сервер, не знаючи самого ключа (рішення власника
   * 2026-10-23, TECH-DEBT §19.6). Ту саму адресу (з `/` чи без) зміною не вважаємо.
   */
  private async secretsResetOnUrlChange(
    branchId: string,
    dto: UpdateBranchSettingsDto,
  ): Promise<{ checkboxLicenseKey?: null; checkboxPinCode?: null; monobankToken?: null }> {
    if (dto.checkboxApiUrl === undefined && dto.monobankApiUrl === undefined) return {};
    const current = await this.prisma.branchSettings.findUnique({
      where: { branchId },
      select: { checkboxApiUrl: true, monobankApiUrl: true },
    });
    if (!current) return {};
    const reset: { checkboxLicenseKey?: null; checkboxPinCode?: null; monobankToken?: null } = {};
    if (
      dto.checkboxApiUrl !== undefined &&
      !sameApiUrl(current.checkboxApiUrl, dto.checkboxApiUrl)
    ) {
      if (dto.checkboxLicenseKey === undefined) reset.checkboxLicenseKey = null;
      if (dto.checkboxPinCode === undefined) reset.checkboxPinCode = null;
    }
    if (
      dto.monobankApiUrl !== undefined &&
      !sameApiUrl(current.monobankApiUrl, dto.monobankApiUrl)
    ) {
      if (dto.monobankToken === undefined) reset.monobankToken = null;
    }
    return reset;
  }

  async invalidateOrgCache(orgId: string): Promise<void> {
    try {
      await this.redis.del(orgSettingsCacheKey(orgId));
    } catch {
      // ignore
    }
  }

  async invalidateBranchCache(orgId: string, branchId: string): Promise<void> {
    try {
      await this.redis.del(branchSettingsCacheKey(orgId, branchId));
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
    // TODO(autoArchiveDays): наразі без споживача — авто-архівація документів ще не
    // реалізована (немає scheduler-джобу). Поле зберігається/віддається, щоб не втратити
    // конфіг; підключити при впровадженні auto-archive cron (аналог invoice-overdue.scheduler).
    autoArchiveDays: number;
    defaultWarrantyDays: number;
    requireClientApproval: boolean;
    allowPartialPayment: boolean;
    brandTheme: string;
    language: string;
    costMethod: BatchCostMethod;
    followUpActive: boolean;
    followUpDays: number;
    maintenanceForecastDays: number;
    nbuFetchHour: number;
    quietHoursStart: string;
    quietHoursEnd: string;
    deliveryPollIntervalMinutes: number;
    bankStatementPollIntervalMinutes: number;
    integrationLogRetentionDays: number;
    laborCostRatio: { toNumber(): number } | number;
    pnlIncomeCashReasons?: CashOperationReason[];
    pnlExpenseCashReasons?: CashOperationReason[];
    pnlWarnFuturePayroll?: boolean;
    pnlNetAdvanceReturns?: boolean;
    uiFeatures: unknown;
    loyaltyEnabled: boolean;
    loyaltyEarnPer: { toNumber(): number } | number;
    loyaltyEarnPoints: { toNumber(): number } | number;
    loyaltyRedeemRate: { toNumber(): number } | number;
    recalcPlannedHoursFromLines: boolean;
    recalcActualHoursFromLines: boolean;
    supplierOrderSendMode: SupplierOrderSendMode;
    supplierAnalogPolicy: SupplierAnalogPolicy;
    supplierDefaultStrategy: SupplierStrategy;
    supplierOptimalPriceWeight: { toNumber(): number } | number;
    supplierAllowSplit: boolean;
    supplierAllowAnalogsInAuto: boolean;
    supplierOfferTtlMinutes: number;
    supplierOfferRetentionDays: number;
    supplierOrderPollIntervalMinutes: number;
    supplierCatalogSyncIntervalMinutes: number;
    supplierUnknownDeliveryDays: number;
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
      language: s.language,
      costMethod: s.costMethod,
      followUpActive: s.followUpActive,
      followUpDays: s.followUpDays,
      maintenanceForecastDays: s.maintenanceForecastDays,
      nbuFetchHour: s.nbuFetchHour,
      quietHoursStart: s.quietHoursStart,
      quietHoursEnd: s.quietHoursEnd,
      deliveryPollIntervalMinutes: s.deliveryPollIntervalMinutes,
      bankStatementPollIntervalMinutes: s.bankStatementPollIntervalMinutes,
      integrationLogRetentionDays: s.integrationLogRetentionDays,
      laborCostRatio: toNum(s.laborCostRatio),
      pnlIncomeCashReasons: s.pnlIncomeCashReasons ?? [
        ...PNL_SETTINGS_DEFAULTS.pnlIncomeCashReasons,
      ],
      pnlExpenseCashReasons: s.pnlExpenseCashReasons ?? [
        ...PNL_SETTINGS_DEFAULTS.pnlExpenseCashReasons,
      ],
      pnlWarnFuturePayroll: s.pnlWarnFuturePayroll ?? PNL_SETTINGS_DEFAULTS.pnlWarnFuturePayroll,
      pnlNetAdvanceReturns: s.pnlNetAdvanceReturns ?? PNL_SETTINGS_DEFAULTS.pnlNetAdvanceReturns,
      uiFeatures: this.parseUiFeatures(s.uiFeatures),
      loyaltyEnabled: s.loyaltyEnabled,
      loyaltyEarnPer: toNum(s.loyaltyEarnPer),
      loyaltyEarnPoints: toNum(s.loyaltyEarnPoints),
      loyaltyRedeemRate: toNum(s.loyaltyRedeemRate),
      recalcPlannedHoursFromLines: s.recalcPlannedHoursFromLines,
      recalcActualHoursFromLines: s.recalcActualHoursFromLines,
      supplierOrderSendMode: s.supplierOrderSendMode,
      supplierAnalogPolicy: s.supplierAnalogPolicy,
      supplierDefaultStrategy: s.supplierDefaultStrategy,
      supplierOptimalPriceWeight: toNum(s.supplierOptimalPriceWeight),
      supplierAllowSplit: s.supplierAllowSplit,
      supplierAllowAnalogsInAuto: s.supplierAllowAnalogsInAuto,
      supplierOfferTtlMinutes: s.supplierOfferTtlMinutes,
      supplierOfferRetentionDays: s.supplierOfferRetentionDays,
      supplierOrderPollIntervalMinutes: s.supplierOrderPollIntervalMinutes,
      supplierCatalogSyncIntervalMinutes: s.supplierCatalogSyncIntervalMinutes,
      supplierUnknownDeliveryDays: s.supplierUnknownDeliveryDays,
      updatedAt: s.updatedAt instanceof Date ? s.updatedAt.toISOString() : s.updatedAt,
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
    shiftMode?: string;
    monobankApiUrl?: string | null;
    monobankToken?: string | null;
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
      shiftMode: s.shiftMode,
      monobankApiUrl: s.monobankApiUrl ?? null,
      hasMonobankToken: s.monobankToken != null && s.monobankToken !== '',
      smsEnabled: s.smsEnabled,
      smsProvider: s.smsProvider,
      smsSenderName: s.smsSenderName,
      updatedAt: s.updatedAt instanceof Date ? s.updatedAt.toISOString() : s.updatedAt,
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
    if (!cfg)
      throw new NotFoundException(translateError('err.settings.configNotFound', getLocale()));
    const updated = await this.prisma.documentNumberConfig.update({
      where: { id: cfg.id, orgId },
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
    if (!cfg)
      throw new NotFoundException(translateError('err.settings.configNotFound', getLocale()));
    await this.prisma.documentNumberConfig.update({
      where: { id: cfg.id, orgId },
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

  async getTaxRates(orgId: string): Promise<TaxRateResponse[]> {
    const cacheKey = taxRatesCacheKey(orgId);
    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) return JSON.parse(cached) as TaxRateResponse[];
    } catch {
      // Redis unavailable — continue without cache (offline-first)
    }

    const rates = await this.prisma.taxRate.findMany({
      where: { orgId },
      orderBy: { rate: 'asc' },
      take: 100,
    });
    const result = rates.map(r => ({
      id: r.id,
      name: r.name,
      rate: Number(r.rate),
      isDefault: r.isDefault,
      isActive: r.isActive,
    }));

    try {
      await this.redis.set(cacheKey, JSON.stringify(result), 'EX', TTL_SECONDS);
    } catch {
      // ignore
    }
    return result;
  }

  async invalidateTaxRatesCache(orgId: string): Promise<void> {
    try {
      await this.redis.del(taxRatesCacheKey(orgId));
    } catch {
      // ignore
    }
  }

  async createTaxRate(
    orgId: string,
    dto: { name: string; rate: number; isDefault?: boolean; isActive?: boolean },
    userId?: string,
  ) {
    // When isDefault=true: atomically unset previous defaults in the same orgId scope.
    // No unique index on [orgId, isDefault] in schema → multiple defaults possible without this;
    // getDefaultTaxRate() would return a non-deterministic row.
    const rate = dto.isDefault
      ? await this.prisma.$transaction(
          async tx => {
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
          },
          { timeout: 10_000 },
        )
      : await this.prisma.taxRate.create({
          data: {
            orgId,
            name: dto.name,
            rate: dto.rate,
            isDefault: false,
            isActive: dto.isActive ?? true,
          },
        });
    await this.invalidateTaxRatesCache(orgId);
    this.auditSettings(orgId, 'TaxRate', rate.id, 'CREATE', userId, undefined, {
      name: dto.name,
      rate: dto.rate,
      isDefault: dto.isDefault ?? false,
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
    userId?: string,
  ) {
    // When setting isDefault=true: atomically unset previous defaults in orgId scope (excluding current id).
    if (dto.isDefault === true) {
      await this.prisma.$transaction(
        async tx => {
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
          if (result.count === 0)
            throw new NotFoundException(
              translateError('err.settings.taxRateNotFound', getLocale()),
            );
        },
        { timeout: 10_000 },
      );
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
      if (result.count === 0)
        throw new NotFoundException(translateError('err.settings.taxRateNotFound', getLocale()));
    }
    await this.invalidateTaxRatesCache(orgId);
    const updated = await this.prisma.taxRate.findFirstOrThrow({ where: { id, orgId } });
    this.auditSettings(orgId, 'TaxRate', id, 'UPDATE', userId, undefined, { ...dto });
    return {
      id: updated.id,
      name: updated.name,
      rate: Number(updated.rate),
      isDefault: updated.isDefault,
      isActive: updated.isActive,
    };
  }

  async deleteTaxRate(orgId: string, id: string, userId?: string) {
    // TaxRate referenced indirectly through invoices/lines — hard delete loses audit trail.
    // Soft-deactivate via isActive=false instead.
    const existing = await this.prisma.taxRate.findFirst({ where: { id, orgId } });
    if (!existing)
      throw new NotFoundException(translateError('err.settings.taxRateNotFound', getLocale()));
    if (existing.isDefault)
      throw new BadRequestException(
        translateError('err.settings.defaultTaxRateUndeletable', getLocale()),
      );
    // Defense-in-depth: updateMany with orgId guard (sto-review pattern 2026-05-30).
    const result = await this.prisma.taxRate.updateMany({
      where: { id, orgId },
      data: { isActive: false },
    });
    if (result.count === 0)
      throw new NotFoundException(translateError('err.settings.taxRateNotFound', getLocale()));
    await this.invalidateTaxRatesCache(orgId);
    this.auditSettings(orgId, 'TaxRate', id, 'DELETE', userId, { name: existing.name }, undefined);
  }

  private readonly orgSelect = {
    id: true,
    orgId: true,
    name: true,
    edrpou: true,
    logoUrl: true,
    legalAddress: true,
    actualAddress: true,
    phone: true,
    email: true,
    ipn: true,
    bankAccountId: true,
    updatedAt: true,
  } as const;

  /**
   * Вигляд оболонки для КОЖНОЇ ролі: палітра й назва організації в шапці меню. Повні налаштування
   * й картка організації — лише власнику й адміну (Bug #847), тому окремий вузький метод.
   */
  async getBranding(orgId: string): Promise<{ brandTheme: string; orgName: string | null }> {
    const [settings, org] = await Promise.all([
      this.getOrganisationSettings(orgId),
      this.prisma.organisation.findFirst({
        where: { orgId, deletedAt: null },
        select: { name: true },
      }),
    ]);
    return { brandTheme: settings.brandTheme, orgName: org?.name?.trim() || null };
  }

  async getOrganisation(orgId: string): Promise<OrganisationResponseDto> {
    const org = await this.prisma.organisation.findFirst({
      where: { orgId, deletedAt: null },
      select: this.orgSelect,
    });
    if (!org)
      throw new NotFoundException(translateError('err.settings.organisationNotFound', getLocale()));
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
    if (!org)
      throw new NotFoundException(translateError('err.settings.organisationNotFound', getLocale()));
    if (dto.bankAccountId && !ba)
      throw new NotFoundException(translateError('err.bankAccount.notFound', getLocale()));

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
    phone?: string | null;
    email?: string | null;
    ipn?: string | null;
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
      phone: org.phone ?? null,
      email: org.email ?? null,
      ipn: org.ipn ?? null,
      bankAccountId: org.bankAccountId ?? null,
      updatedAt: org.updatedAt instanceof Date ? org.updatedAt.toISOString() : org.updatedAt,
    };
  }
}
