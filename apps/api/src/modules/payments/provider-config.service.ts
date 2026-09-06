import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ProviderKind, ShiftMode } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/** DTO апсерту конфіга провайдера (creds write-only — порожнє → зберегти наявні). */
export interface UpsertProviderConfigInput {
  provider: string;
  apiUrl?: string | null;
  /** Плоскі секрети провайдера (checkbox: licenseKey/pinCode/cashRegisterId; monobank: token; ...). */
  credentials?: Record<string, string>;
  enabled?: boolean;
  shiftMode?: ShiftMode;
}

/** Публічний вигляд конфіга (без сирих credentials — лише hasCredentials). */
export interface ProviderConfigView {
  provider: string;
  enabled: boolean;
  apiUrl: string | null;
  shiftMode: ShiftMode;
  hasCredentials: boolean;
}

/** Резолвлений активний провайдер + його креди/URL/режим (декриптовані). */
export interface ResolvedProvider {
  provider: string;
  apiUrl: string | null;
  credentials: Record<string, string>;
  shiftMode: 'MANUAL' | 'AUTO_OPEN';
}

/**
 * Резолвер активного провайдера per-branch для ПРРО (FISCAL) та еквайрингу (PAYMENT).
 * Джерело правди — BranchProviderConfig (enabled=true, лише 1 per kind). Legacy read-fallback:
 * якщо жодного enabled-конфіга немає, читаємо старі BranchSettings checkbox-/monobank-колонки
 * (вони вже дешифруються prisma-extension-ом) → уже налаштовані філії працюють без міграції даних.
 */
@Injectable()
export class ProviderConfigService {
  constructor(private readonly prisma: PrismaService) {}

  /** Активний провайдер для (orgId, branchId?, kind) або null якщо не налаштовано. */
  async resolveActive(
    orgId: string,
    branchId: string | null | undefined,
    kind: ProviderKind,
  ): Promise<ResolvedProvider | null> {
    // 1. BranchProviderConfig (enabled). Якщо branchId невідомий — беремо будь-який enabled у org.
    const cfg = await this.prisma.branchProviderConfig.findFirst({
      where: {
        orgId,
        kind,
        enabled: true,
        deletedAt: null,
        ...(branchId ? { branchId } : {}),
      },
      select: { provider: true, apiUrl: true, credentials: true, shiftMode: true },
    });
    if (cfg) {
      return {
        provider: cfg.provider,
        apiUrl: cfg.apiUrl,
        credentials: this.parseCreds(cfg.credentials),
        shiftMode: cfg.shiftMode,
      };
    }

    // 2. Legacy-fallback на BranchSettings (старі хардкод-колонки).
    return this.legacyFromBranchSettings(orgId, branchId, kind);
  }

  /** Конкретний конфіг провайдера (для processor, що вже знає gateway/provider наміру/зміни). */
  async resolveByCode(
    orgId: string,
    branchId: string | null | undefined,
    kind: ProviderKind,
    provider: string,
  ): Promise<ResolvedProvider | null> {
    const cfg = await this.prisma.branchProviderConfig.findFirst({
      where: { orgId, kind, provider, deletedAt: null, ...(branchId ? { branchId } : {}) },
      select: { provider: true, apiUrl: true, credentials: true, shiftMode: true },
    });
    if (cfg && this.hasCreds(this.parseCreds(cfg.credentials))) {
      return {
        provider: cfg.provider,
        apiUrl: cfg.apiUrl,
        credentials: this.parseCreds(cfg.credentials),
        shiftMode: cfg.shiftMode,
      };
    }
    // Legacy: код збігається з дефолтним провайдером старих колонок.
    const legacy = await this.legacyFromBranchSettings(orgId, branchId, kind);
    return legacy && legacy.provider === provider ? legacy : null;
  }

  // ─── CRUD + активація (для контролерів fiscal-providers / payment-gateways) ──────────

  /** Конфіги провайдерів філії (kind) для UI — секрети НЕ повертаються (лише hasCredentials). */
  async getBranchConfigs(
    orgId: string,
    branchId: string,
    kind: ProviderKind,
  ): Promise<ProviderConfigView[]> {
    await this.assertBranchInOrg(orgId, branchId);
    const rows = await this.prisma.branchProviderConfig.findMany({
      where: { orgId, branchId, kind, deletedAt: null },
      select: { provider: true, enabled: true, apiUrl: true, shiftMode: true, credentials: true },
      take: 50,
    });
    return rows.map(r => ({
      provider: r.provider,
      enabled: r.enabled,
      apiUrl: r.apiUrl,
      shiftMode: r.shiftMode,
      hasCredentials: this.hasCreds(this.parseCreds(r.credentials)),
    }));
  }

  /**
   * Створити/оновити конфіг провайдера (atomic upsert по @@unique(branchId,kind,provider)).
   * credentials write-only: передані поля мерджаться у наявні; порожні значення НЕ затирають
   * (щоб «зберегти» не стирало вже введений ключ). Reactivate soft-deleted рядок.
   */
  async upsertConfig(
    orgId: string,
    branchId: string,
    kind: ProviderKind,
    input: UpsertProviderConfigInput,
  ): Promise<ProviderConfigView> {
    await this.assertBranchInOrg(orgId, branchId);
    if (!input.provider || input.provider.length > 64) {
      throw new BadRequestException('Некоректний код провайдера');
    }

    const existing = await this.prisma.branchProviderConfig.findFirst({
      where: { branchId, kind, provider: input.provider },
      select: { id: true, credentials: true },
    });

    // Мердж credentials: наявні ← нові непорожні поля (write-only).
    const merged = this.parseCreds(existing?.credentials ?? null);
    if (input.credentials) {
      for (const [k, v] of Object.entries(input.credentials)) {
        if (typeof v === 'string' && v !== '') merged[k] = v;
      }
    }
    const credentials = Object.keys(merged).length > 0 ? JSON.stringify(merged) : null;

    const data = {
      apiUrl: input.apiUrl ?? null,
      credentials,
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.shiftMode !== undefined ? { shiftMode: input.shiftMode } : {}),
      deletedAt: null,
    };

    const row = await this.prisma.branchProviderConfig.upsert({
      where: { branchId_kind_provider: { branchId, kind, provider: input.provider } },
      create: { orgId, branchId, kind, provider: input.provider, ...data },
      update: data,
      select: { provider: true, enabled: true, apiUrl: true, shiftMode: true, credentials: true },
    });
    return {
      provider: row.provider,
      enabled: row.enabled,
      apiUrl: row.apiUrl,
      shiftMode: row.shiftMode,
      hasCredentials: this.hasCreds(this.parseCreds(row.credentials)),
    };
  }

  /**
   * Ексклюзивна активація: enabled=true активному провайдеру, enabled=false усім іншим цього kind
   * на філії (атомарно). Гарантує «активний лише 1». Guard: провайдер має мати збережені credentials.
   */
  async activate(
    orgId: string,
    branchId: string,
    kind: ProviderKind,
    provider: string,
  ): Promise<{ activated: string }> {
    await this.assertBranchInOrg(orgId, branchId);
    const target = await this.prisma.branchProviderConfig.findFirst({
      where: { orgId, branchId, kind, provider, deletedAt: null },
      select: { id: true, credentials: true },
    });
    if (!target) throw new NotFoundException('Провайдера не налаштовано для цієї філії');
    if (!this.hasCreds(this.parseCreds(target.credentials))) {
      throw new BadRequestException('Спершу введіть креди провайдера');
    }

    await this.prisma.$transaction([
      // Вимкнути всіх інших провайдерів цього kind (tenant+branch-scoped).
      this.prisma.branchProviderConfig.updateMany({
        where: {
          orgId,
          branchId,
          kind,
          provider: { not: provider },
          deletedAt: null,
          enabled: true,
        },
        data: { enabled: false },
      }),
      // Увімкнути активний.
      this.prisma.branchProviderConfig.updateMany({
        where: { orgId, branchId, kind, provider, deletedAt: null },
        data: { enabled: true },
      }),
    ]);
    return { activated: provider };
  }

  private async assertBranchInOrg(orgId: string, branchId: string): Promise<void> {
    const branch = await this.prisma.garageBranch.findFirst({
      where: { id: branchId, orgId, deletedAt: null },
      select: { id: true },
    });
    if (!branch) throw new NotFoundException('Філію не знайдено');
  }

  private async legacyFromBranchSettings(
    orgId: string,
    branchId: string | null | undefined,
    kind: ProviderKind,
  ): Promise<ResolvedProvider | null> {
    const bs = await this.prisma.branchSettings.findFirst({
      where: branchId ? { orgId, branchId } : { orgId },
      select: {
        fiscalEnabled: true,
        checkboxApiUrl: true,
        checkboxLicenseKey: true,
        checkboxPinCode: true,
        checkboxCashRegisterId: true,
        shiftMode: true,
        monobankToken: true,
        monobankApiUrl: true,
      },
    });
    if (!bs) return null;

    if (kind === 'FISCAL') {
      if (!bs.fiscalEnabled || !bs.checkboxLicenseKey) return null;
      return {
        provider: 'checkbox',
        apiUrl: bs.checkboxApiUrl,
        credentials: {
          licenseKey: bs.checkboxLicenseKey,
          ...(bs.checkboxPinCode ? { pinCode: bs.checkboxPinCode } : {}),
          ...(bs.checkboxCashRegisterId ? { cashRegisterId: bs.checkboxCashRegisterId } : {}),
        },
        shiftMode: bs.shiftMode,
      };
    }
    // PAYMENT
    if (!bs.monobankToken) return null;
    return {
      provider: 'monobank',
      apiUrl: bs.monobankApiUrl,
      credentials: { token: bs.monobankToken },
      shiftMode: 'MANUAL',
    };
  }

  private parseCreds(raw: string | null): Record<string, string> {
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
    } catch {
      return {};
    }
  }

  private hasCreds(c: Record<string, string>): boolean {
    return Object.values(c).some(v => typeof v === 'string' && v !== '');
  }
}
