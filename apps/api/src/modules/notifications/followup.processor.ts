import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService, NotificationConfig } from './notifications.service';

export interface FollowUpJob {
  orgId: string;
}

// Hard caps — prevent OOM on large fleets.
// TODO: switch to cursor pagination when single org has > 1000 vehicles or schedules.
const MAX_SCHEDULES_PER_RUN = 1000;
const MAX_VEHICLES_PER_RUN = 1000;
const MAINTENANCE_FORECAST_DAYS = 14;

// Module-level Intl singleton — `.toLocaleDateString('uk-UA')` allocates a new formatter
// per call. Used in hot loop через `for (const schedule of upcomingMaintenance)` × N schedules
// × щоденний tick → hoist to module-level (sto-optimize: Intl.DateTimeFormat у hot-path).
const UA_DATE_FMT = new Intl.DateTimeFormat('uk-UA');

// concurrency: 1 — followup is a scheduled daily batch per org; a single run fans-out
// all SMS via Promise.allSettled internally. Parallel org runs would contend on the SMS
// provider rate limit — serialize at the queue level to avoid cascading 429s.
@Injectable()
@Processor('followup', { concurrency: 1 })
export class FollowUpProcessor extends WorkerHost {
  private readonly logger = new Logger(FollowUpProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {
    super();
  }

  async process(job: Job<FollowUpJob>): Promise<void> {
    const { orgId } = job.data;

    // Parallel: settings + fallback branch — independent reads (різні таблиці, обидва orgId-scoped).
    // -1 RTT на кожен daily tick. Раніше: послідовно settings → branch.
    const [settings, fallbackBranch] = await Promise.all([
      this.prisma.organisationSettings.findFirst({ where: { orgId } }),
      // Найстаріша філія — fallback SMS-конфіг для отримувачів БЕЗ власного наряду
      // (напр. maintenance-графік авто, яке ще не обслуговувалось у нас).
      this.prisma.garageBranch.findFirst({
        where: { orgId, deletedAt: null },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      }),
    ]);
    if (!settings?.followUpActive) return;
    if (!fallbackBranch) return;

    // DST-safe Kyiv "today" anchor. Set UTC 09:00 (= 11:00/12:00 Kyiv depending on DST)
    // so setDate(±N) operates well away from the local-midnight boundary.
    const today = new Date();
    today.setUTCHours(9, 0, 0, 0);

    const todayPlusForecast = new Date(today);
    todayPlusForecast.setDate(todayPlusForecast.getDate() + MAINTENANCE_FORECAST_DAYS);

    const cutoffDate = new Date(today);
    cutoffDate.setDate(cutoffDate.getDate() - (settings.followUpDays ?? 90));

    // Maintenance schedules due within forecast window — exclude already-overdue ones
    // (previously sent SMS daily for missed maintenance months in the past).
    // Parallel: upcomingMaintenance + inactiveVehicles — independent reads on різні таблиці
    // (maintenanceSchedule vs vehicle), без cross-deps. -1 RTT на кожен daily tick.
    const [upcomingMaintenanceRaw, inactiveVehiclesRaw] = await Promise.all([
      this.prisma.maintenanceSchedule.findMany({
        where: {
          orgId,
          deletedAt: null,
          isActive: true,
          nextMaintenanceDate: { gte: today, lte: todayPlusForecast },
        },
        include: {
          vehicle: {
            include: {
              customerGarage: {
                include: { counterparty: true },
              },
              // last WO branchId → per-branch SMS-конфіг (multi-branch orgs).
              workOrders: {
                where: { deletedAt: null },
                orderBy: { completedAt: 'desc' },
                take: 1,
                select: { branchId: true },
              },
            },
          },
        },
        take: MAX_SCHEDULES_PER_RUN,
      }),
      // "Inactive" vehicles — had a completed WO before cutoff but none after.
      // Vehicles that NEVER had a completed WO are excluded — they were never our customers
      // for that vehicle, so a "we miss you" SMS would be misleading.
      this.prisma.vehicle.findMany({
        where: {
          orgId,
          deletedAt: null,
          workOrders: {
            some: {
              deletedAt: null,
              completedAt: { not: null, lt: cutoffDate },
            },
            none: {
              deletedAt: null,
              completedAt: { gte: cutoffDate },
            },
          },
        },
        include: {
          customerGarage: {
            include: { counterparty: true },
          },
          workOrders: {
            where: { deletedAt: null, completedAt: { not: null } },
            orderBy: { completedAt: 'desc' },
            take: 1,
          },
        },
        take: MAX_VEHICLES_PER_RUN,
      }),
    ]);

    const upcomingMaintenance = upcomingMaintenanceRaw.filter(
      s =>
        !s.vehicle.deletedAt &&
        !s.vehicle.customerGarage.deletedAt &&
        !s.vehicle.customerGarage.counterparty.deletedAt,
    );

    if (upcomingMaintenance.length >= MAX_SCHEDULES_PER_RUN) {
      this.logger.warn(
        `FollowUp org=${orgId}: maintenance schedules ліміт ${MAX_SCHEDULES_PER_RUN} досягнуто — потрібна пагінація`,
      );
    }

    const inactiveVehicles = inactiveVehiclesRaw.filter(
      v => !v.customerGarage.deletedAt && !v.customerGarage.counterparty.deletedAt,
    );

    if (inactiveVehicles.length >= MAX_VEHICLES_PER_RUN) {
      this.logger.warn(
        `FollowUp org=${orgId}: inactive vehicles ліміт ${MAX_VEHICLES_PER_RUN} досягнуто — потрібна пагінація`,
      );
    }

    // Build deduplicated recipient list first (sync), THEN fan-out sends in parallel.
    // Previously: 2 sequential for-await loops × N sends × ~SMS RTT = N × RTT wall-clock.
    // Now: collectee → Promise.allSettled — limited by SMS provider connection count,
    // not by sequential RTT. Дедуплікація phone збережена через sentTo Set.
    type Recipient = {
      phone: string;
      clientName: string;
      vehicleMake: string;
      vehicleModel: string;
      licensePlate: string;
      nextMaintenanceDate: string;
      // Філія останнього наряду авто → per-branch SMS-конфіг; null → fallbackBranch.
      branchId: string | null;
    };
    const sentTo = new Set<string>();
    const recipients: Recipient[] = [];

    for (const schedule of upcomingMaintenance) {
      const phone = schedule.vehicle.customerGarage.counterparty.phone;
      if (!phone || sentTo.has(phone)) continue;
      sentTo.add(phone);
      recipients.push({
        phone,
        clientName: this.formatName(schedule.vehicle.customerGarage.counterparty),
        vehicleMake: schedule.vehicle.make,
        vehicleModel: schedule.vehicle.model,
        licensePlate: schedule.vehicle.licensePlate ?? '',
        nextMaintenanceDate: schedule.nextMaintenanceDate
          ? ` ${UA_DATE_FMT.format(schedule.nextMaintenanceDate)}`
          : '',
        branchId: schedule.vehicle.workOrders[0]?.branchId ?? null,
      });
    }

    for (const vehicle of inactiveVehicles) {
      const phone = vehicle.customerGarage.counterparty.phone;
      if (!phone || sentTo.has(phone)) continue;
      // Defensive: only proceed if last completed WO is actually before cutoff (DB filter guarantees this,
      // but we double-check in case workOrders include was overridden).
      const lastWO = vehicle.workOrders[0];
      if (!lastWO?.completedAt || lastWO.completedAt >= cutoffDate) continue;
      sentTo.add(phone);
      recipients.push({
        phone,
        clientName: this.formatName(vehicle.customerGarage.counterparty),
        vehicleMake: vehicle.make,
        vehicleModel: vehicle.model,
        licensePlate: vehicle.licensePlate ?? '',
        nextMaintenanceDate: '',
        branchId: lastWO.branchId ?? null,
      });
    }

    let sendErrors = 0;
    let sendSuccess = 0;
    let lastError: Error | undefined;

    if (recipients.length === 0) {
      this.logger.log(`FollowUp для org=${orgId}: немає отримувачів`);
      return;
    }

    // Per-branch SMS-конфіг (multi-branch): кожен отримувач шле через конфіг СВОЄЇ
    // філії (останній наряд авто), не через одну «найстарішу» філію. branchId=null
    // (авто без наряду) → fallbackBranch. resolveConfig викликаємо ОДИН раз на
    // унікальну філію (branchSettings+template спільні для всіх отримувачів філії) —
    // memoized map, тож fan-out loop лишається 0 DB reads.
    const branchIdsInUse = new Set<string>();
    for (const r of recipients) branchIdsInUse.add(r.branchId ?? fallbackBranch.id);

    const configByBranch = new Map<string, NotificationConfig | null>();
    await Promise.all(
      [...branchIdsInUse].map(async bId => {
        configByBranch.set(
          bId,
          await this.notifications.resolveConfig(orgId, bId, 'FOLLOWUP_REMINDER'),
        );
      }),
    );

    // Якщо жодна задіяна філія не має SMS-конфігу — нічого відправляти.
    if ([...configByBranch.values()].every(c => c === null)) {
      this.logger.log(
        `FollowUp для org=${orgId}: SMS не налаштовано або шаблон відсутній — відправка пропущена`,
      );
      return;
    }

    // Use pre-fetched config (sendWithConfig = no DB reads per recipient).
    // Отримувачі, чия філія без конфігу, пропускаються (skipped), не помилка.
    let skipped = 0;
    const results = await Promise.allSettled(
      recipients.map(r => {
        const bId = r.branchId ?? fallbackBranch.id;
        const cfg = configByBranch.get(bId) ?? null;
        if (!cfg) {
          skipped++;
          return Promise.resolve(undefined);
        }
        return this.notifications.sendWithConfig(
          orgId,
          cfg,
          {
            phone: r.phone, // recipient обирається per-channel у sendWithConfig
            clientName: r.clientName,
            vehicleMake: r.vehicleMake,
            vehicleModel: r.vehicleModel,
            licensePlate: r.licensePlate,
            nextMaintenanceDate: r.nextMaintenanceDate,
          },
          bId,
          'FOLLOWUP_REMINDER',
        );
      }),
    );

    for (let i = 0; i < results.length; i++) {
      const res = results[i];
      if (res.status === 'fulfilled') {
        sendSuccess++;
      } else {
        sendErrors++;
        const e = res.reason instanceof Error ? res.reason : new Error(String(res.reason));
        lastError = e;
        this.logger.warn(`Помилка відправки нагадування для ${recipients[i].phone}: ${e.message}`);
      }
    }
    // skipped рахуються як fulfilled (Promise.resolve) — коригуємо success-лічильник.
    sendSuccess -= skipped;

    this.logger.log(
      `FollowUp для org=${orgId}: успішно ${sendSuccess}, помилок ${sendErrors}, пропущено (без SMS-конфігу філії) ${skipped}, унікальних отримувачів ${sentTo.size}`,
    );

    // If ALL sends failed (and we tried at least one), surface the error to BullMQ for retry.
    // Per-message failures otherwise don't block the batch.
    if (sendErrors > 0 && sendSuccess === 0 && lastError) {
      throw lastError;
    }
  }

  private formatName(cp: {
    firstName?: string | null;
    lastName?: string | null;
    companyName?: string | null;
  }): string {
    const full = [cp.firstName, cp.lastName]
      .map(s => s?.trim())
      .filter(Boolean)
      .join(' ')
      .trim();
    // Fallback "клієнте" prevents broken templates like "Вітаємо, !" when counterparty
    // has no name fields (rare legacy data).
    return full || cp.companyName?.trim() || 'клієнте';
  }
}
