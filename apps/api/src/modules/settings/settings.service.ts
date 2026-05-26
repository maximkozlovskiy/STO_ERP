import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type Redis from 'ioredis';
import { VatMode, BatchCostMethod, DocumentType, ResetPeriod } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { REDIS_CLIENT } from '../../redis/redis.module';
import {
  BranchSettingsResponseDto,
  OrganisationSettingsResponseDto,
  UiFeatures,
  UI_FEATURES_DEFAULTS,
  UpdateBranchSettingsDto,
  UpdateOrganisationSettingsDto,
} from './settings.dto';

const TTL_SECONDS = 300; // 5 minutes

@Injectable()
export class SettingsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
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
    // Merge uiFeatures partially — don't overwrite unset keys.
    // Whitelist allowed keys to prevent unbounded JSON growth via arbitrary payload.
    let updateData: Record<string, unknown> = { ...dto };
    if (dto.uiFeatures !== undefined) {
      const current = await this.prisma.organisationSettings.findUnique({ where: { orgId } });
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

    const branch = await this.prisma.garageBranch.findFirst({
      where: { id: branchId, orgId, deletedAt: null },
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

  async updateBranchSettings(
    orgId: string,
    branchId: string,
    dto: UpdateBranchSettingsDto,
  ): Promise<BranchSettingsResponseDto> {
    const branch = await this.prisma.garageBranch.findFirst({
      where: { id: branchId, orgId, deletedAt: null },
    });
    if (!branch) throw new NotFoundException('Філію не знайдено');

    const settings = await this.prisma.branchSettings.upsert({
      where: { branchId },
      create: { branchId, orgId, ...dto },
      update: dto,
    });

    await this.invalidateBranchCache(orgId, branchId);

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
    const stored = (typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {});
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
    uiFeatures: unknown;
    updatedAt: Date;
  }): OrganisationSettingsResponseDto {
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
      uiFeatures: this.parseUiFeatures(s.uiFeatures),
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
    const configs = await this.prisma.documentNumberConfig.findMany({ where: { orgId }, orderBy: { documentType: 'asc' } });
    return configs.map(c => ({
      id: c.id, documentType: c.documentType, prefix: c.prefix, includeDate: c.includeDate,
      separator: c.separator, padding: c.padding, currentSeq: Number(c.currentSeq),
      resetPeriod: c.resetPeriod, updatedAt: c.updatedAt,
    }));
  }

  async updateDocumentNumber(orgId: string, documentType: string, dto: { prefix?: string | null; includeDate?: boolean; separator?: string; padding?: number; resetPeriod?: string }) {
    const cfg = await this.prisma.documentNumberConfig.findFirst({ where: { orgId, documentType: documentType as DocumentType } });
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
    return { id: updated.id, documentType: updated.documentType, prefix: updated.prefix, includeDate: updated.includeDate, separator: updated.separator, padding: updated.padding, currentSeq: Number(updated.currentSeq), resetPeriod: updated.resetPeriod, updatedAt: updated.updatedAt };
  }

  async resetDocumentNumber(orgId: string, documentType: string) {
    const cfg = await this.prisma.documentNumberConfig.findFirst({ where: { orgId, documentType: documentType as DocumentType } });
    if (!cfg) throw new NotFoundException('Конфігурацію не знайдено');
    await this.prisma.documentNumberConfig.update({ where: { id: cfg.id }, data: { currentSeq: 0 } });
    return { message: 'Лічильник скинуто' };
  }

  async getTaxRates(orgId: string) {
    const rates = await this.prisma.taxRate.findMany({ where: { orgId }, orderBy: { rate: 'asc' } });
    return rates.map(r => ({ id: r.id, name: r.name, rate: Number(r.rate), isDefault: r.isDefault, isActive: r.isActive }));
  }

  async createTaxRate(orgId: string, dto: { name: string; rate: number; isDefault?: boolean; isActive?: boolean }) {
    const rate = await this.prisma.taxRate.create({
      data: { orgId, name: dto.name, rate: dto.rate, isDefault: dto.isDefault ?? false, isActive: dto.isActive ?? true },
    });
    return { id: rate.id, name: rate.name, rate: Number(rate.rate), isDefault: rate.isDefault, isActive: rate.isActive };
  }

  async updateTaxRate(orgId: string, id: string, dto: { name?: string; rate?: number; isDefault?: boolean; isActive?: boolean }) {
    const existing = await this.prisma.taxRate.findFirst({ where: { id, orgId } });
    if (!existing) throw new NotFoundException('Ставку ПДВ не знайдено');
    const updated = await this.prisma.taxRate.update({ where: { id }, data: { name: dto.name ?? undefined, rate: dto.rate ?? undefined, isDefault: dto.isDefault ?? undefined, isActive: dto.isActive ?? undefined } });
    return { id: updated.id, name: updated.name, rate: Number(updated.rate), isDefault: updated.isDefault, isActive: updated.isActive };
  }

  async deleteTaxRate(orgId: string, id: string) {
    const existing = await this.prisma.taxRate.findFirst({ where: { id, orgId } });
    if (!existing) throw new NotFoundException('Ставку ПДВ не знайдено');
    await this.prisma.taxRate.delete({ where: { id } });
  }
}
