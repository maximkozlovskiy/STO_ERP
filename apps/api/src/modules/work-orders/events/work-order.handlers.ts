import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { formatPersonName } from '@sto/shared';
import { PrismaService } from '../../../prisma/prisma.service';
import { MaintenanceSchedulesService } from '../../maintenance-schedules/maintenance-schedules.service';
import { WarrantiesService } from '../../warranties/warranties.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { SettingsService } from '../../settings/settings.service';
import { AuditService } from '../../audit/audit.service';
import {
  WORK_ORDER_EVENTS,
  WorkOrderCompletedEvent,
  WorkOrderTransitionedEvent,
} from './work-order.events';

/**
 * A2: @OnEvent-хендлери lifecycle-side-effects наряду. Кожен — незалежний, best-effort (як були
 * inline .catch у transition()). Помилка одного хендлера не зриває інші й не впливає на сам перехід
 * (подія емітиться ПІСЛЯ коміту). Додати нову реакцію на завершення наряду = новий @OnEvent-метод,
 * WorkOrdersService не чіпається.
 */
@Injectable()
export class WorkOrderEventHandlers {
  private readonly logger = new Logger(WorkOrderEventHandlers.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly maintenanceSchedules: MaintenanceSchedulesService,
    private readonly warranties: WarrantiesService,
    private readonly notifications: NotificationsService,
    private readonly settingsService: SettingsService,
    private readonly audit: AuditService,
  ) {}

  /** Аудит статус-переходу — на КОЖЕН перехід (userId=undefined → системний, пропускаємо). */
  @OnEvent(WORK_ORDER_EVENTS.TRANSITIONED)
  async onTransitioned(e: WorkOrderTransitionedEvent): Promise<void> {
    if (!e.userId) return;
    try {
      await this.audit.record(
        e.orgId,
        'WorkOrder',
        e.workOrderId,
        'UPDATE',
        e.userId,
        { status: e.fromStatus },
        { status: e.toStatus },
      );
    } catch (err: unknown) {
      this.logger.warn(`Audit record failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Синхронізувати Vehicle.currentMileage з outMileage (тільки якщо новий пробіг більший або NULL). */
  @OnEvent(WORK_ORDER_EVENTS.COMPLETED)
  async syncMileage(e: WorkOrderCompletedEvent): Promise<void> {
    if (!e.outMileage) return;
    try {
      // Prisma `lt` виключає NULL — авто без початкового пробігу лишились би NULL назавжди; матчимо явно.
      await this.prisma.vehicle.updateMany({
        where: {
          id: e.vehicleId,
          orgId: e.orgId,
          OR: [{ currentMileage: null }, { currentMileage: { lt: e.outMileage } }],
        },
        data: { currentMileage: e.outMileage },
      });
    } catch (err: unknown) {
      this.logger.warn(
        `Помилка оновлення пробігу авто: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Авто-оновлення графіків ТО коли завершено MAINTENANCE-наряд. */
  @OnEvent(WORK_ORDER_EVENTS.COMPLETED)
  async updateMaintenance(e: WorkOrderCompletedEvent): Promise<void> {
    if (e.repairCategory !== 'MAINTENANCE') return;
    try {
      await this.maintenanceSchedules.updateAfterWorkOrder(
        e.orgId,
        e.vehicleId,
        e.completedAt,
        e.outMileage ?? undefined,
      );
    } catch (err: unknown) {
      this.logger.warn(`Помилка оновлення ТО: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Авто-створення гарантії після завершення, якщо defaultWarrantyDays > 0. */
  @OnEvent(WORK_ORDER_EVENTS.COMPLETED)
  async createWarranty(e: WorkOrderCompletedEvent): Promise<void> {
    try {
      const settings = await this.settingsService.getOrganisationSettings(e.orgId);
      const warrantyDays = settings.defaultWarrantyDays ?? 0;
      if (warrantyDays > 0) {
        await this.warranties.autoCreate(e.orgId, e.workOrderId, warrantyDays);
      }
    } catch (err: unknown) {
      this.logger.warn(
        `Warranty auto-create failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Сповіщення клієнту про завершення (через BullMQ-чергу — offline-safe). */
  @OnEvent(WORK_ORDER_EVENTS.COMPLETED)
  async notify(e: WorkOrderCompletedEvent): Promise<void> {
    try {
      await this.notifications.send(e.orgId, 'WO_COMPLETED', {
        branchId: e.branchId,
        phone: e.counterparty.phone,
        email: e.counterparty.email,
        workOrderNumber: e.workOrderNumber,
        clientName: formatPersonName(
          e.counterparty.lastName,
          e.counterparty.firstName,
          e.counterparty.companyName,
        ),
      });
    } catch (err: unknown) {
      this.logger.warn(
        `Помилка сповіщення WO_COMPLETED: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
