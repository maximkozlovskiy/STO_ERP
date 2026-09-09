import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { formatPersonName } from '@sto/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SHAREABLE_STATUSES } from './work-orders.fsm';
import type { EstimatePublicDto } from './work-orders.dto';

/**
 * A3 (розбиття God-service): публічний перегляд кошторису наряду — окремий bounded context із власним
 * периметром безпеки (неавтентифікований доступ за share-token, SHAREABLE_STATUSES-гейт, мінімальний
 * public-DTO без чутливих полів, open-redirect guard на baseUrl). Винесено з WorkOrdersService, де він
 * змішувався з внутрішнім CRUD і розмивав security-межу.
 */
@Injectable()
export class WorkOrderShareService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Генерує (або повертає існуючий) shareToken для публічного перегляду кошторису.
   * Обмежено статусами DRAFT/ESTIMATE/APPROVED — після початку робіт ділитися немає сенсу,
   * а CLOSED-статуси (COMPLETED/INVOICED/PAID/ARCHIVED/CANCELLED) містять чутливі дані.
   *
   * Race-safe: умовний update `where: { shareToken: null }` — якщо інший запит щойно записав токен,
   * цей update не зачепить рядок, і ми перечитаємо актуальний токен.
   */
  async getOrCreateShareToken(orgId: string, id: string): Promise<{ token: string }> {
    const wo = await this.prisma.workOrder.findFirst({
      where: { id, orgId, deletedAt: null },
      select: { id: true, status: true, shareToken: true },
    });
    if (!wo) throw new NotFoundException('Наряд не знайдено');
    if (!SHAREABLE_STATUSES.includes(wo.status)) {
      throw new BadRequestException(
        'Поділитися кошторисом можна лише у статусі чернетка / кошторис / затверджено',
      );
    }
    if (wo.shareToken) return { token: wo.shareToken };

    const token = randomBytes(16).toString('hex');
    // updateMany з умовою shareToken: null уникає race condition:
    // якщо інший запит уже записав токен — count=0, ми перечитаємо актуальний.
    const { count } = await this.prisma.workOrder.updateMany({
      where: { id, orgId, shareToken: null, deletedAt: null },
      data: { shareToken: token },
    });
    if (count === 0) {
      const fresh = await this.prisma.workOrder.findFirst({
        where: { id, orgId, deletedAt: null },
        select: { shareToken: true },
      });
      if (fresh?.shareToken) return { token: fresh.shareToken };
      // Малоймовірний випадок — токен зник між викликами; кидаємо як conflict.
      throw new BadRequestException('Не вдалося згенерувати токен — спробуйте ще раз');
    }
    return { token };
  }

  /**
   * Публічний перегляд кошторису. Повертає МІНІМАЛЬНИЙ DTO:
   * без orgId, FK-ів, paidAmount, slot-полів, dueDate, syncVersion тощо.
   * Доступний лише для shareable-статусів (DRAFT/ESTIMATE/APPROVED) —
   * після переходу у CLOSED-статус посилання перестає працювати (404).
   */
  async findByShareToken(token: string): Promise<EstimatePublicDto> {
    const wo = await this.prisma.workOrder.findFirst({
      where: {
        shareToken: token,
        deletedAt: null,
        status: { in: [...SHAREABLE_STATUSES] },
      },
      include: {
        vehicle: { select: { make: true, model: true, licensePlate: true } },
        counterparty: { select: { firstName: true, lastName: true, companyName: true } },
        branch: { select: { name: true } },
        lines: {
          where: { deletedAt: null },
          orderBy: { createdAt: 'asc' },
          take: 500,
          select: {
            id: true,
            normoHours: true,
            price: true,
            amount: true,
            notes: true,
            work: { select: { name: true } },
          },
        },
        parts: {
          where: { deletedAt: null },
          orderBy: { createdAt: 'asc' },
          take: 500,
          select: {
            id: true,
            goodId: true,
            quantity: true,
            price: true,
            amount: true,
            unitOfMeasureId: true,
            good: {
              select: { name: true, unit: true, unitOfMeasure: { select: { shortName: true } } },
            },
          },
        },
      },
    });
    if (!wo) throw new NotFoundException('Посилання не дійсне або термін дії минув');

    // sto-optimize 2026-06-17: tier merger — org та uoms обидва залежать лише
    // від wo (orgId + parts.unitOfMeasureId), один від одного — ні. Раніше:
    // sequential 2 RTT після головного findFirst. Тепер: 1 RTT паралельно.
    // На public endpoint (share-token, без auth) це 50% TTFB save.
    // WO-C3: lookup за (unitOfMeasureId, goodId), не за GoodUoM.id (part.unitOfMeasureId = FK на
    // UnitOfMeasure.id). Раніше збіг був неможливий → у публічному кошторисі показувалась базова
    // одиниця замість обраної.
    const uomIds = wo.parts.map(p => p.unitOfMeasureId).filter((x): x is string => !!x);
    const partGoodIds = wo.parts.map(p => p.goodId);
    const [org, goodUoMs] = await Promise.all([
      this.prisma.organisation.findFirst({
        where: { id: wo.orgId },
        select: { name: true, logoUrl: true },
      }),
      uomIds.length > 0
        ? this.prisma.goodUoM.findMany({
            where: { unitOfMeasureId: { in: uomIds }, goodId: { in: partGoodIds } },
            select: {
              unitOfMeasureId: true,
              goodId: true,
              unitOfMeasure: { select: { shortName: true } },
            },
          })
        : Promise.resolve(
            [] as {
              unitOfMeasureId: string;
              goodId: string;
              unitOfMeasure: { shortName: string };
            }[],
          ),
    ]);
    const uomMap: Record<string, string> = {};
    for (const u of goodUoMs)
      uomMap[`${u.goodId}|${u.unitOfMeasureId}`] = u.unitOfMeasure.shortName;

    const cp = wo.counterparty;
    const counterpartyName =
      formatPersonName(cp?.lastName, cp?.firstName, cp?.companyName) || undefined;
    const vehicleSummary = wo.vehicle
      ? `${wo.vehicle.make} ${wo.vehicle.model}${wo.vehicle.licensePlate ? ` (${wo.vehicle.licensePlate})` : ''}`
      : undefined;

    return {
      number: wo.number,
      status: wo.status,
      orgName: org?.name,
      orgLogoUrl: org?.logoUrl ?? null,
      branchName: wo.branch?.name,
      counterpartyName,
      vehicleSummary,
      documentDate: wo.documentDate ? wo.documentDate.toISOString().slice(0, 10) : null,
      description: wo.description ?? null,
      inMileage: wo.inMileage ?? null,
      totalLabor: Number(wo.totalLabor),
      totalParts: Number(wo.totalParts),
      // Public estimate shows PLANNED total: wo.totalAmount = totalActualLabor + totalParts
      // (uses actual hours when entered). For SHAREABLE_STATUSES this is semantically wrong —
      // the client sees an estimate, not a completion act. Compute locally as totalLabor + totalParts
      // so row math (normoHours × price) matches the grand total.
      totalAmount: Number(wo.totalLabor) + Number(wo.totalParts),
      lines: wo.lines.map(l => ({
        id: l.id,
        workName: l.work?.name,
        normoHours: l.normoHours,
        price: Number(l.price),
        amount: Number(l.amount),
        notes: l.notes ?? null,
      })),
      parts: wo.parts.map(p => ({
        id: p.id,
        goodName: p.good?.name,
        quantity: p.quantity,
        unitShortName:
          (p.unitOfMeasureId && uomMap[`${p.goodId}|${p.unitOfMeasureId}`]) ??
          p.good?.unitOfMeasure?.shortName ??
          p.good?.unit,
        price: Number(p.price),
        amount: Number(p.amount),
      })),
    };
  }

  /**
   * Відправити SMS клієнту з посиланням на кошторис.
   * baseUrl формується на сервері з ConfigService('WEB_PUBLIC_URL') — НЕ приймається з клієнта
   * (open-redirect/phishing ризик: шкідливий каллер міг би передати `https://phishing.com`).
   */
  async sendEstimateSms(orgId: string, id: string): Promise<void> {
    const { token } = await this.getOrCreateShareToken(orgId, id);
    const wo = await this.prisma.workOrder.findFirst({
      where: { id, orgId, deletedAt: null },
      select: {
        branchId: true,
        number: true,
        totalAmount: true,
        vehicle: { select: { licensePlate: true, make: true, model: true } },
        counterparty: {
          select: { phone: true, email: true, firstName: true, lastName: true, companyName: true },
        },
      },
    });
    if (!wo?.counterparty?.phone) {
      throw new BadRequestException('Телефон клієнта не вказано');
    }

    const publicUrl = this.config.get<string>('WEB_PUBLIC_URL');
    if (!publicUrl) {
      throw new BadRequestException(
        'Публічний URL не налаштовано (WEB_PUBLIC_URL) — зверніться до адміністратора',
      );
    }
    // Підрізаємо trailing slash для уніфікації — щоб не отримати `https://x.com//estimate/...`
    const link = `${publicUrl.replace(/\/+$/, '')}/estimate/${token}`;

    const clientName = formatPersonName(
      wo.counterparty.lastName,
      wo.counterparty.firstName,
      wo.counterparty.companyName,
    );
    const vehiclePlate =
      wo.vehicle?.licensePlate ?? `${wo.vehicle?.make ?? ''} ${wo.vehicle?.model ?? ''}`.trim();

    // Шаблон WO_ESTIMATE_READY очікує {{clientName}}, {{vehiclePlate}}, {{totalAmount}};
    // {{link}} і {{woNumber}} додано для нової версії шаблону (див. seed.ts).
    await this.notifications.send(orgId, 'WO_ESTIMATE_READY', {
      branchId: wo.branchId,
      phone: wo.counterparty.phone,
      email: wo.counterparty.email,
      clientName,
      vehiclePlate,
      totalAmount: Number(wo.totalAmount).toFixed(2),
      woNumber: wo.number,
      link,
    });
  }
}
