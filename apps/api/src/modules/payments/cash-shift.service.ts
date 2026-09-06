import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CheckboxClient } from './checkbox.client';

// Дефолтний час життя токена якщо Checkbox не повернув expires_at (консервативно — 50 хв).
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
    private readonly checkbox: CheckboxClient,
  ) {}

  /** Поточна OPEN-зміна філії (+ лічильник QUEUED-чеків) або null. */
  async getCurrent(orgId: string, branchId: string): Promise<CurrentShiftDto | null> {
    const shift = await this.prisma.cashShift.findFirst({
      where: { orgId, branchId, status: 'OPEN', deletedAt: null },
      orderBy: { openedAt: 'desc' },
      include: { cashRegister: { select: { name: true } } },
    });
    if (!shift) return null;
    // Скоупимо лічильник до філії цієї зміни (Payment → workOrder.branchId), інакше у мульти-
    // філійній орг картка однієї каси показувала б QUEUED-чеки ВСІХ філій. Платежі без наряду
    // (workOrderId=null) не належать жодній філії → у лічильник конкретної зміни не входять.
    const pendingReceipts = await this.prisma.payment.count({
      where: { orgId, fiscalStatus: 'QUEUED', workOrder: { branchId } },
    });
    return this.toDto(shift, pendingReceipts);
  }

  /**
   * Відкрити зміну: sign-in (PIN→token) → Checkbox openShift → персист OPEN CashShift.
   * Guard: fiscal увімкнено+креди; немає вже відкритої зміни на касі. Offline → кидаємо (без
   * phantom-зміни: без checkboxShiftId чек не має куди пробитись).
   */
  async open(orgId: string, branchId: string, userId?: string): Promise<CurrentShiftDto> {
    const bs = await this.prisma.branchSettings.findFirst({
      where: { branchId, orgId },
      select: {
        fiscalEnabled: true,
        checkboxApiUrl: true,
        checkboxLicenseKey: true,
        checkboxPinCode: true,
      },
    });
    if (!bs?.fiscalEnabled || !bs.checkboxLicenseKey || !bs.checkboxPinCode) {
      throw new BadRequestException('Фіскалізацію не налаштовано (ключ/PIN/увімкнення)');
    }
    // Локальна каса для зміни: беремо активну касу філії.
    const register = await this.prisma.cashRegister.findFirst({
      where: { orgId, branchId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    if (!register) throw new BadRequestException('Немає каси для цієї філії');

    // Guard: одна OPEN-зміна на касу.
    const existing = await this.prisma.cashShift.findFirst({
      where: { orgId, cashRegisterId: register.id, status: 'OPEN', deletedAt: null },
      select: { id: true },
    });
    if (existing) throw new BadRequestException('Зміна вже відкрита');

    const apiUrl = bs.checkboxApiUrl ?? undefined;
    const token = await this.checkbox.signInPinCode(
      apiUrl!,
      bs.checkboxLicenseKey,
      bs.checkboxPinCode,
    );
    const { checkboxShiftId } = await this.checkbox.openShift(apiUrl!, token.accessToken);

    try {
      const shift = await this.prisma.cashShift.create({
        data: {
          orgId,
          branchId,
          cashRegisterId: register.id,
          checkboxShiftId,
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
    if (!shift) throw new NotFoundException('Зміну не знайдено');
    if (shift.status !== 'OPEN') throw new BadRequestException('Зміна вже закрита');

    const { apiUrl, token } = await this.ensureToken(orgId, shift.id);
    const { zReportId } = await this.checkbox.closeShift(apiUrl, token);

    const updated = await this.prisma.cashShift.update({
      where: { id: shift.id },
      data: { status: 'CLOSED', closedAt: new Date(), zReportId: zReportId ?? null },
      include: { cashRegister: { select: { name: true } } },
    });
    return this.toDto(updated, 0);
  }

  /**
   * Гарантує валідний cashier-token для зміни: якщо протух (tokenExpiresAt минув або немає) —
   * re-sign-in і оновлює рядок. Використовується close() і processor-ом (sell). Повертає apiUrl+token.
   */
  async ensureToken(orgId: string, shiftId: string): Promise<{ apiUrl: string; token: string }> {
    const shift = await this.prisma.cashShift.findFirst({
      where: { id: shiftId, orgId },
      select: { branchId: true, checkboxAccessToken: true, tokenExpiresAt: true },
    });
    if (!shift) throw new NotFoundException('Зміну не знайдено');
    const bs = await this.prisma.branchSettings.findFirst({
      where: { branchId: shift.branchId, orgId },
      select: { checkboxApiUrl: true, checkboxLicenseKey: true, checkboxPinCode: true },
    });
    const apiUrl = bs?.checkboxApiUrl ?? 'https://api.checkbox.ua';

    const valid =
      shift.checkboxAccessToken &&
      shift.tokenExpiresAt &&
      shift.tokenExpiresAt.getTime() > Date.now() + 30_000; // 30с запас
    if (valid) return { apiUrl, token: shift.checkboxAccessToken! };

    if (!bs?.checkboxLicenseKey || !bs.checkboxPinCode) {
      throw new BadRequestException('Фіскалізацію не налаштовано — неможливо оновити токен');
    }
    const token = await this.checkbox.signInPinCode(
      apiUrl,
      bs.checkboxLicenseKey,
      bs.checkboxPinCode,
    );
    await this.prisma.cashShift.update({
      where: { id: shiftId },
      data: {
        checkboxAccessToken: token.accessToken,
        tokenExpiresAt: this.tokenExpiry(token.expiresAt),
      },
    });
    return { apiUrl, token: token.accessToken };
  }

  /** OPEN-зміна для філії (для processor). null якщо немає. */
  async findOpenShift(orgId: string, branchId: string) {
    return this.prisma.cashShift.findFirst({
      where: { orgId, branchId, status: 'OPEN', deletedAt: null },
      orderBy: { openedAt: 'desc' },
      select: { id: true, checkboxShiftId: true },
    });
  }

  /** Re-sign-in примусово (для processor при 401). */
  async refreshToken(orgId: string, shiftId: string): Promise<{ apiUrl: string; token: string }> {
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
