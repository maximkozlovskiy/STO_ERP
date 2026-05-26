import { Process, Processor } from '@nestjs/bull';
import { Job } from 'bull';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from './notifications.service';

export interface FollowUpJob {
  orgId: string;
}

@Injectable()
@Processor('followup')
export class FollowUpProcessor {
  private readonly logger = new Logger(FollowUpProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  @Process('send-reminders')
  async handleSendReminders(job: Job<FollowUpJob>) {
    const { orgId } = job.data;

    const settings = await this.prisma.organisationSettings.findFirst({ where: { orgId } });
    if (!settings?.followUpActive) return;

    const branch = await this.prisma.garageBranch.findFirst({ where: { orgId, deletedAt: null } });
    if (!branch) return;

    const today = new Date();
    const todayPlusForecast = new Date(today);
    todayPlusForecast.setDate(todayPlusForecast.getDate() + 14);

    const cutoffDate = new Date(today);
    cutoffDate.setDate(cutoffDate.getDate() - (settings.followUpDays ?? 90));

    // Find vehicles with upcoming maintenance
    const upcomingMaintenance = await this.prisma.maintenanceSchedule.findMany({
      where: {
        orgId,
        deletedAt: null,
        isActive: true,
        nextMaintenanceDate: { lte: todayPlusForecast },
      },
      include: {
        vehicle: {
          include: {
            customerGarage: {
              include: { counterparty: true },
            },
          },
        },
      },
      take: 200,
    });

    // Find vehicles with no recent work orders
    const inactiveVehicles = await this.prisma.vehicle.findMany({
      where: {
        orgId,
        deletedAt: null,
        workOrders: {
          none: {
            completedAt: { gte: cutoffDate },
          },
        },
      },
      include: {
        customerGarage: {
          include: { counterparty: true },
        },
        workOrders: {
          where: { completedAt: { not: null } },
          orderBy: { completedAt: 'desc' },
          take: 1,
        },
      },
      take: 200,
    });

    const sentTo = new Set<string>();

    for (const schedule of upcomingMaintenance) {
      const phone = schedule.vehicle.customerGarage.counterparty.phone;
      if (!phone || sentTo.has(phone)) continue;
      sentTo.add(phone);

      await this.notifications.send(orgId, 'FOLLOWUP_REMINDER', {
        branchId: branch.id,
        phone,
        clientName: this.formatName(schedule.vehicle.customerGarage.counterparty),
        vehicleMake: schedule.vehicle.make,
        vehicleModel: schedule.vehicle.model,
        licensePlate: schedule.vehicle.licensePlate ?? '',
        nextMaintenanceDate: schedule.nextMaintenanceDate?.toLocaleDateString('uk-UA') ?? '',
      }).catch((e: Error) => {
        if (!e.message.includes('не налаштовано') && !e.message.includes('не знайдено')) {
          this.logger.warn(`Помилка відправки нагадування: ${e.message}`);
        }
      });
    }

    for (const vehicle of inactiveVehicles) {
      const phone = vehicle.customerGarage.counterparty.phone;
      if (!phone || sentTo.has(phone)) continue;
      sentTo.add(phone);

      const lastWO = vehicle.workOrders[0];
      if (!lastWO?.completedAt) continue;
      if (lastWO.completedAt >= cutoffDate) continue;

      await this.notifications.send(orgId, 'FOLLOWUP_REMINDER', {
        branchId: branch.id,
        phone,
        clientName: this.formatName(vehicle.customerGarage.counterparty),
        vehicleMake: vehicle.make,
        vehicleModel: vehicle.model,
        licensePlate: vehicle.licensePlate ?? '',
        nextMaintenanceDate: '',
      }).catch((e: Error) => {
        if (!e.message.includes('не налаштовано') && !e.message.includes('не знайдено')) {
          this.logger.warn(`Помилка відправки нагадування: ${e.message}`);
        }
      });
    }

    this.logger.log(`FollowUp для org=${orgId}: надіслано ${sentTo.size} нагадувань`);
  }

  private formatName(cp: { firstName?: string | null; lastName?: string | null; companyName?: string | null }): string {
    if (cp.firstName || cp.lastName) {
      return [cp.firstName, cp.lastName].filter(Boolean).join(' ');
    }
    return cp.companyName ?? '';
  }
}
