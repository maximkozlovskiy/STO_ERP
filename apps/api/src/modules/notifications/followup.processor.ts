import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { runWithTenant } from '../../common/tenant/tenant-context';
import { NotificationsService, NotificationConfig } from './notifications.service';

export interface FollowUpJob {
  orgId: string;
}

// T12: cursor-пагінація замість hard-cap 1000. Раніше `take: 1000` ТИХО губив нагадування для
// автопарків >1000 (лише warn). Тепер сторінкуємо по PAGE_SIZE через keyset-cursor (id), будуючи
// дедуплікований recipients-список ІНКРЕМЕНТАЛЬНО — у пам'яті тримаємо лише одну сторінку raw-рядків
// + унікальні-за-телефоном recipients (набагато менше), тож OOM-захист збережено без втрати даних.
const PAGE_SIZE = 500;
// Запобіжник від нескінченного циклу/патологічних обсягів (напр. пошкоджені дані): жорстка стеля
// сторінок на прогін. 200 × 500 = 100k рядків/джерело — недосяжно для реального СТО; досягнення = warn.
const MAX_PAGES = 200;
// T13: дефолт горизонту прогнозу ТО, якщо OrganisationSettings.maintenanceForecastDays не задано.
const MAINTENANCE_FORECAST_DEFAULT_DAYS = 14;

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
    return runWithTenant({ orgId: job.data.orgId }, async () => {
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

      // T13: горизонт прогнозу ТО з налаштувань (було hardcoded 14). Різні СТО хочуть різний обрій.
      const forecastDays = settings.maintenanceForecastDays ?? MAINTENANCE_FORECAST_DEFAULT_DAYS;
      const todayPlusForecast = new Date(today);
      todayPlusForecast.setDate(todayPlusForecast.getDate() + forecastDays);

      const cutoffDate = new Date(today);
      cutoffDate.setDate(cutoffDate.getDate() - (settings.followUpDays ?? 90));

      // T12: cursor-пагінація. Обидва джерела (maintenanceSchedule / vehicle) сторінкуємо по PAGE_SIZE
      // через keyset-cursor (id, orderBy id asc) і будуємо дедуплікований recipients-список
      // ІНКРЕМЕНТАЛЬНО — без утримання всіх raw-рядків у пам'яті й без тихої втрати понад 1000.
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

      // 1) Графіки ТО у вікні прогнозу — виключаємо вже-прострочені.
      let mCursor: string | undefined;
      let mPages = 0;
      for (;;) {
        const page = await this.prisma.maintenanceSchedule.findMany({
          where: {
            orgId,
            deletedAt: null,
            isActive: true,
            nextMaintenanceDate: { gte: today, lte: todayPlusForecast },
          },
          include: {
            vehicle: {
              include: {
                customerGarage: { include: { counterparty: true } },
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
          orderBy: { id: 'asc' },
          take: PAGE_SIZE,
          ...(mCursor ? { cursor: { id: mCursor }, skip: 1 } : {}),
        });
        if (page.length === 0) break;
        mCursor = page[page.length - 1].id;

        for (const schedule of page) {
          // soft-delete guards на пов'язаних сутностях (Prisma include не фільтрує per-relation deletedAt).
          if (
            schedule.vehicle.deletedAt ||
            schedule.vehicle.customerGarage.deletedAt ||
            schedule.vehicle.customerGarage.counterparty.deletedAt
          ) {
            continue;
          }
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

        if (page.length < PAGE_SIZE) break;
        if (++mPages >= MAX_PAGES) {
          this.logger.warn(
            `FollowUp org=${orgId}: досягнуто MAX_PAGES(${MAX_PAGES}) для maintenance — можливі пошкоджені дані`,
          );
          break;
        }
      }

      // 2) "Inactive" авто — мали завершений наряд ДО cutoff, але жодного ПІСЛЯ. Авто, що НІКОЛИ не
      //    мали завершеного наряду, виключено (не наші клієнти для цього авто).
      let vCursor: string | undefined;
      let vPages = 0;
      for (;;) {
        const page = await this.prisma.vehicle.findMany({
          where: {
            orgId,
            deletedAt: null,
            workOrders: {
              some: { deletedAt: null, completedAt: { not: null, lt: cutoffDate } },
              none: { deletedAt: null, completedAt: { gte: cutoffDate } },
            },
          },
          include: {
            customerGarage: { include: { counterparty: true } },
            workOrders: {
              where: { deletedAt: null, completedAt: { not: null } },
              orderBy: { completedAt: 'desc' },
              take: 1,
            },
          },
          orderBy: { id: 'asc' },
          take: PAGE_SIZE,
          ...(vCursor ? { cursor: { id: vCursor }, skip: 1 } : {}),
        });
        if (page.length === 0) break;
        vCursor = page[page.length - 1].id;

        for (const vehicle of page) {
          if (vehicle.customerGarage.deletedAt || vehicle.customerGarage.counterparty.deletedAt) {
            continue;
          }
          const phone = vehicle.customerGarage.counterparty.phone;
          if (!phone || sentTo.has(phone)) continue;
          // Defensive: last completed WO дійсно до cutoff (DB-фільтр гарантує, але подвійна перевірка).
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

        if (page.length < PAGE_SIZE) break;
        if (++vPages >= MAX_PAGES) {
          this.logger.warn(
            `FollowUp org=${orgId}: досягнуто MAX_PAGES(${MAX_PAGES}) для inactive vehicles — можливі пошкоджені дані`,
          );
          break;
        }
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
          this.logger.warn(
            `Помилка відправки нагадування для ${recipients[i].phone}: ${e.message}`,
          );
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
    });
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
