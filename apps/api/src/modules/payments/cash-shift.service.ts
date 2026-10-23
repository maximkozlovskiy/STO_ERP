import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { translateError } from '@sto/shared';
import { getLocale } from '../../common/tenant/tenant-context';
import { PrismaService } from '../../prisma/prisma.service';
import { FiscalProviderRegistry } from './fiscal/fiscal-provider-registry';
import { ProviderConfigService } from './provider-config.service';
import type { FiscalConfig } from './fiscal/fiscal-provider.interface';
import { IntegrationLogService } from '../integration-logs/integration-log.service';

// Дефолтний час життя токена якщо провайдер не повернув expires_at (консервативно — 50 хв).
const DEFAULT_TOKEN_TTL_MS = 50 * 60 * 1000;

export interface CurrentShiftDto {
  id: string;
  status: 'OPEN' | 'CLOSED';
  cashRegisterId: string;
  cashRegisterName?: string;
  checkboxShiftId: string | null;
  openedAt: string;
  closedAt: string | null;
  zReportId: string | null;
  /** Скільки чеків очікують пробиття (QUEUED) — щоб касир бачив «завислі» у manual-режимі. */
  pendingReceipts?: number;
}

/**
 * Керування касовою зміною (ПРРО). Синхронні операції (негайний фідбек касиру), на відміну від
 * offline-first sell-черги. open/close роблять зовнішній Checkbox-виклик через CheckboxClient.
 * Токен зберігається на CashShift-рядку (шифрується at-rest), refresh — ensureToken().
 */
@Injectable()
export class CashShiftService {
  private readonly logger = new Logger(CashShiftService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: FiscalProviderRegistry,
    private readonly providerConfig: ProviderConfigService,
    private readonly integrationLog: IntegrationLogService,
  ) {}

  /**
   * Резолвити ПРРО-провайдер для зміни. `providerCode` задано (каса привʼязана) → резолвимо саме
   * його (resolveByCode); інакше — активний per-branch провайдер (resolveActive) + legacy-fallback.
   * Повертає {provider, cfg, code} або кидає.
   */
  private async resolveProvider(orgId: string, branchId: string, providerCode?: string | null) {
    const active = providerCode
      ? await this.providerConfig.resolveByCode(orgId, branchId, 'FISCAL', providerCode)
      : await this.providerConfig.resolveActive(orgId, branchId, 'FISCAL');
    if (!active) {
      throw new BadRequestException(
        translateError('err.cashShift.fiscalNotConfigured', getLocale()),
      );
    }
    const provider = this.registry.get(active.provider);
    if (!provider)
      throw new BadRequestException(
        translateError('err.cashShift.unknownProvider', getLocale(), {
          provider: active.provider,
        }),
      );
    const cfg: FiscalConfig = { apiUrl: active.apiUrl, credentials: active.credentials };
    return { provider, cfg };
  }

  /**
   * Поточна OPEN-зміна (+ лічильник QUEUED-чеків) або null. З `cashRegisterId` — зміна САМЕ цієї
   * каси (BR-CASH-027): у філії з двома фіскальними касами зміна однієї не робить відкритою іншу.
   * Без каси — найновіша OPEN-зміна філії, як раніше (зворотна сумісність старих клієнтів).
   */
  async getCurrent(
    orgId: string,
    branchId: string,
    cashRegisterId?: string,
  ): Promise<CurrentShiftDto | null> {
    if (cashRegisterId) {
      const register = await this.prisma.cashRegister.findFirst({
        where: { id: cashRegisterId, orgId, branchId, deletedAt: null },
        select: { id: true },
      });
      if (!register)
        throw new NotFoundException(translateError('err.cashRegister.notFound', getLocale()));
    }
    const shift = await this.prisma.cashShift.findFirst({
      where: { ...this.openShiftScope(orgId, branchId, cashRegisterId), status: 'OPEN' },
      orderBy: { openedAt: 'desc' },
      include: { cashRegister: { select: { name: true } } },
    });
    if (!shift) return null;
    // Режим каси: лічильник — чеки оплат саме цієї каси. Режим філії: скоупимо до філії зміни
    // (Payment → workOrder.branchId), інакше у мультифілійній орг картка показувала б QUEUED-чеки
    // ВСІХ філій; платежі без наряду (workOrderId=null) не належать жодній філії → не входять.
    const pendingReceipts = await this.prisma.payment.count({
      where: cashRegisterId
        ? { orgId, fiscalStatus: 'QUEUED', cashRegisterId }
        : { orgId, fiscalStatus: 'QUEUED', workOrder: { branchId } },
    });
    return this.toDto(shift, pendingReceipts);
  }

  /**
   * Відкрити зміну: sign-in (PIN→token) → Checkbox openShift → персист OPEN CashShift.
   * Guard: fiscal увімкнено+креди; немає вже відкритої зміни на касі. Offline → кидаємо (без
   * phantom-зміни: без checkboxShiftId чек не має куди пробитись).
   */
  async open(
    orgId: string,
    branchId: string,
    userId?: string,
    cashRegisterId?: string,
  ): Promise<CurrentShiftDto> {
    // Локальна каса для зміни: задана явно (з привʼязкою до провайдера) або найстаріша каса філії —
    // спершу ФІСКАЛЬНА. Віджет зміни є лише у фіскальної каси й питає зміну саме її (BR-CASH-027):
    // зміна, відкрита AUTO_OPEN-ом на нефіскальній касі, ніде не видна й не закривається (Bug #960).
    const register = await this.prisma.cashRegister.findFirst({
      where: {
        orgId,
        branchId,
        deletedAt: null,
        ...(cashRegisterId ? { id: cashRegisterId } : {}),
      },
      orderBy: [{ isFiscal: 'desc' }, { createdAt: 'asc' }],
      select: { id: true, fiscalProvider: true },
    });
    if (!register) {
      // Явна каса не цієї організації чи філії (або видалена) — 404, як у getCurrent (Bug #961).
      if (cashRegisterId)
        throw new NotFoundException(translateError('err.cashRegister.notFound', getLocale()));
      throw new BadRequestException(
        translateError('err.cashShift.noCashRegisterForBranch', getLocale()),
      );
    }

    // Провайдер зміни: якщо каса привʼязана (fiscalProvider) — саме він; інакше активний per-branch.
    // CashShift.provider = provider.code (нижче) → sell/ensureToken працюють проти правильного ПРРО.
    const { provider, cfg } = await this.resolveProvider(orgId, branchId, register.fiscalProvider);

    // Guard: одна OPEN-зміна на касу.
    const existing = await this.prisma.cashShift.findFirst({
      where: { orgId, cashRegisterId: register.id, status: 'OPEN', deletedAt: null },
      select: { id: true },
    });
    if (existing)
      throw new BadRequestException(translateError('err.cashShift.alreadyOpen', getLocale()));

    const logCtx = { orgId, branchId, provider: provider.code, documentType: 'CashShift' };
    const token = await this.integrationLog.wrap({ ...logCtx, operation: 'signIn' }, () =>
      provider.signIn(cfg),
    );
    const { providerShiftId } = await this.integrationLog.wrap(
      { ...logCtx, operation: 'openShift' },
      () => provider.openShift(cfg, token.accessToken),
    );

    try {
      const shift = await this.prisma.cashShift.create({
        data: {
          orgId,
          branchId,
          cashRegisterId: register.id,
          provider: provider.code,
          checkboxShiftId: providerShiftId,
          status: 'OPEN',
          openedById: userId ?? null,
          checkboxAccessToken: token.accessToken,
          tokenExpiresAt: this.tokenExpiry(token.expiresAt),
        },
        include: { cashRegister: { select: { name: true } } },
      });
      return this.toDto(shift, 0);
    } catch (e) {
      // Гонка: паралельний open()/AUTO_OPEN уже створив OPEN-зміну на цій касі
      // (partial unique "cash_shifts_one_open_per_register_uq"). Ми встигли зробити
      // зайвий Checkbox openShift — але БД-рядок не дублюється. Повертаємо зміну-переможця,
      // щоб processor (AUTO_OPEN) продовжив пробиття у неї, а не впав.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const winner = await this.prisma.cashShift.findFirst({
          where: { orgId, cashRegisterId: register.id, status: 'OPEN', deletedAt: null },
          orderBy: { openedAt: 'desc' },
          include: { cashRegister: { select: { name: true } } },
        });
        if (winner) return this.toDto(winner, 0);
      }
      throw e;
    }
  }

  /** Закрити зміну (Z-звіт). ensureToken → Checkbox closeShift → CLOSED. */
  async close(orgId: string, shiftId: string, _userId?: string): Promise<CurrentShiftDto> {
    const shift = await this.prisma.cashShift.findFirst({
      where: { id: shiftId, orgId, deletedAt: null },
      include: { cashRegister: { select: { name: true } } },
    });
    if (!shift) throw new NotFoundException(translateError('err.cashShift.notFound', getLocale()));
    if (shift.status !== 'OPEN')
      throw new BadRequestException(translateError('err.cashShift.alreadyClosed', getLocale()));

    // Bug #711 — CAS-claim OPEN→CLOSED ПЕРЕД зовнішнім Z-звітом. Статус-перевірка вище — це
    // STALE read: два concurrent close() (подвійний клік / retry) обидва бачать OPEN і обидва
    // пробили б Checkbox closeShift → ДВА Z-звіти на одну зміну (фіскальне порушення). updateMany
    // з `status:'OPEN'` у where — атомарний claim: рівно один переможець (count===1) іде до
    // зовнішнього виклику; програвший (count===0) → «вже закрита», без другого closeShift.
    const claim = await this.prisma.cashShift.updateMany({
      where: { id: shift.id, orgId, status: 'OPEN', deletedAt: null },
      data: { status: 'CLOSED', closedAt: new Date() },
    });
    if (claim.count === 0)
      throw new BadRequestException(translateError('err.cashShift.alreadyClosed', getLocale()));

    let zReportId: string | null | undefined;
    try {
      const { provider, cfg, token } = await this.ensureToken(orgId, shift.id);
      ({ zReportId } = await this.integrationLog.wrap(
        {
          orgId,
          branchId: shift.branchId,
          provider: provider.code,
          operation: 'closeShift',
          documentType: 'CashShift',
          documentId: shift.id,
        },
        () => provider.closeShift(cfg, token),
      ));
    } catch (e) {
      // Зовнішній Z-звіт не вдався — відкочуємо claim у OPEN, щоб касир міг повторити (інакше
      // зміна лишилась би CLOSED без реального Z-звіту). Best-effort revert; кидаємо оригінал.
      await this.prisma.cashShift
        .updateMany({
          where: { id: shift.id, orgId, status: 'CLOSED', deletedAt: null, zReportId: null },
          data: { status: 'OPEN', closedAt: null },
        })
        .catch(() => undefined);
      throw e;
    }

    const updated = await this.prisma.cashShift.update({
      where: { id: shift.id, orgId },
      data: { zReportId: zReportId ?? null },
      include: { cashRegister: { select: { name: true } } },
    });
    return this.toDto(updated, 0);
  }

  /**
   * Гарантує валідний cashier-token для зміни: якщо протух (tokenExpiresAt минув або немає) —
   * re-sign-in і оновлює рядок. Використовується close() і processor-ом (sell). Повертає
   * резолвлений провайдер (за CashShift.provider) + його cfg + валідний токен.
   */
  async ensureToken(
    orgId: string,
    shiftId: string,
  ): Promise<{
    provider: import('./fiscal/fiscal-provider.interface').FiscalProvider;
    cfg: FiscalConfig;
    token: string;
  }> {
    const shift = await this.prisma.cashShift.findFirst({
      where: { id: shiftId, orgId },
      select: { branchId: true, provider: true, checkboxAccessToken: true, tokenExpiresAt: true },
    });
    if (!shift) throw new NotFoundException(translateError('err.cashShift.notFound', getLocale()));

    // Резолвимо КОНКРЕТНИЙ провайдер зміни (не «активний» — зміна могла відкритись іншим).
    const active = await this.providerConfig.resolveByCode(
      orgId,
      shift.branchId,
      'FISCAL',
      shift.provider,
    );
    if (!active) {
      throw new BadRequestException(
        translateError('err.cashShift.fiscalNotConfiguredToken', getLocale()),
      );
    }
    const provider = this.registry.get(shift.provider);
    if (!provider)
      throw new BadRequestException(
        translateError('err.cashShift.unknownProvider', getLocale(), { provider: shift.provider }),
      );
    const cfg: FiscalConfig = { apiUrl: active.apiUrl, credentials: active.credentials };

    const valid =
      shift.checkboxAccessToken &&
      shift.tokenExpiresAt &&
      shift.tokenExpiresAt.getTime() > Date.now() + 30_000; // 30с запас
    if (valid) return { provider, cfg, token: shift.checkboxAccessToken! };

    const token = await this.integrationLog.wrap(
      {
        orgId,
        branchId: shift.branchId,
        provider: shift.provider,
        operation: 'signIn',
        documentType: 'CashShift',
        documentId: shiftId,
      },
      () => provider.signIn(cfg),
    );
    await this.prisma.cashShift.update({
      where: { id: shiftId, orgId },
      data: {
        checkboxAccessToken: token.accessToken,
        tokenExpiresAt: this.tokenExpiry(token.expiresAt),
      },
    });
    return { provider, cfg, token: token.accessToken };
  }

  /**
   * OPEN-зміна для processor-а. null якщо немає. З `cashRegisterId` — лише зміна цієї каси
   * (BR-CASH-027); без неї — будь-яка OPEN-зміна філії (оплата без каси: картка, QR).
   */
  async findOpenShift(orgId: string, branchId: string, cashRegisterId?: string) {
    return this.prisma.cashShift.findFirst({
      where: { ...this.openShiftScope(orgId, branchId, cashRegisterId), status: 'OPEN' },
      orderBy: { openedAt: 'desc' },
      select: { id: true, checkboxShiftId: true },
    });
  }

  /**
   * Де шукати OPEN-зміну. З касою — лише за касою, БЕЗ філії: зміна належить касі (одна OPEN на
   * касу — частковий унікальний індекс), а `CashShift.branchId` — філія на момент відкриття. Касу
   * можна перевести в іншу філію при відкритій зміні; фільтр за філією тоді ховав би цю зміну від
   * віджета й обробника чеків, а `open()` і касова операція (`cash.service`) її бачать → «зміна вже
   * відкрита», закрити нічим, чеки чекають вічно. Без каси — будь-яка зміна філії, як раніше.
   */
  private openShiftScope(orgId: string, branchId: string, cashRegisterId?: string) {
    return cashRegisterId
      ? { orgId, cashRegisterId, deletedAt: null }
      : { orgId, branchId, deletedAt: null };
  }

  /** Re-sign-in примусово (для processor при 401). */
  async refreshToken(orgId: string, shiftId: string) {
    // updateMany з orgId (не update by id) — tenant-scoped no-op якщо shiftId чужий (§2.2),
    // а не безумовна інвалідація токена по глобальному id.
    await this.prisma.cashShift.updateMany({
      where: { id: shiftId, orgId },
      data: { tokenExpiresAt: new Date(0) }, // форсуємо протухлість → ensureToken re-sign-in
    });
    return this.ensureToken(orgId, shiftId);
  }

  private tokenExpiry(iso?: string): Date {
    if (iso) {
      const d = new Date(iso);
      if (!Number.isNaN(d.getTime())) return d;
    }
    return new Date(Date.now() + DEFAULT_TOKEN_TTL_MS);
  }

  private toDto(
    s: {
      id: string;
      status: string;
      cashRegisterId: string;
      checkboxShiftId: string | null;
      openedAt: Date;
      closedAt: Date | null;
      zReportId: string | null;
      cashRegister?: { name: string } | null;
    },
    pendingReceipts: number,
  ): CurrentShiftDto {
    return {
      id: s.id,
      status: s.status as 'OPEN' | 'CLOSED',
      cashRegisterId: s.cashRegisterId,
      cashRegisterName: s.cashRegister?.name,
      checkboxShiftId: s.checkboxShiftId,
      openedAt: s.openedAt.toISOString(),
      closedAt: s.closedAt ? s.closedAt.toISOString() : null,
      zReportId: s.zReportId,
      pendingReceipts,
    };
  }
}
