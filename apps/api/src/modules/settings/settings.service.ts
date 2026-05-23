import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type Redis from 'ioredis';
import { VatMode } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { REDIS_CLIENT } from '../../redis/redis.module';
import {
  BranchSettingsResponseDto,
  OrganisationSettingsResponseDto,
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
    const settings = await this.prisma.organisationSettings.upsert({
      where: { orgId },
      create: { orgId, ...dto },
      update: dto,
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
      workDays: s.workDays as number[],
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
}
