import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { Job } from 'bull';
import { FollowUpProcessor, FollowUpJob } from './followup.processor';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from './notifications.service';

type Cp = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  phone: string | null;
  deletedAt: Date | null;
};

const cp = (overrides: Partial<Cp> = {}): Cp => ({
  id: 'cp-1',
  firstName: 'Іван',
  lastName: 'Петренко',
  companyName: null,
  phone: '+380671234567',
  deletedAt: null,
  ...overrides,
});

const vehicle = (overrides: Record<string, unknown> = {}) => ({
  id: 'veh-1',
  make: 'Toyota',
  model: 'Camry',
  licensePlate: 'AA1234BB',
  deletedAt: null,
  customerGarage: {
    id: 'cg-1',
    deletedAt: null,
    counterparty: cp(),
  },
  workOrders: [],
  ...overrides,
});

const schedule = (overrides: Record<string, unknown> = {}) => ({
  id: 'sch-1',
  orgId: 'org-1',
  isActive: true,
  deletedAt: null,
  nextMaintenanceDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  vehicle: vehicle(),
  ...overrides,
});

const makeJob = (orgId = 'org-1') => ({ data: { orgId } }) as Job<FollowUpJob>;

const makePrismaMock = () => ({
  organisationSettings: { findFirst: vi.fn() },
  garageBranch: { findFirst: vi.fn() },
  maintenanceSchedule: { findMany: vi.fn() },
  vehicle: { findMany: vi.fn() },
});

/** Default resolved SMS config — non-null means SMS is configured and template exists. */
const DEFAULT_SMS_CONFIG = {
  provider: 'turbosms',
  apiKey: 'test-key',
  senderName: 'STO',
  templateBody: 'Вітаємо, {{clientName}}!',
};

describe('FollowUpProcessor.handleSendReminders', () => {
  let processor: FollowUpProcessor;
  let prisma: ReturnType<typeof makePrismaMock>;
  let notifications: {
    resolveConfig: ReturnType<typeof vi.fn>;
    sendWithConfig: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    prisma = makePrismaMock();
    notifications = {
      resolveConfig: vi.fn().mockResolvedValue(DEFAULT_SMS_CONFIG),
      sendWithConfig: vi.fn().mockResolvedValue(undefined),
    };

    const module = await Test.createTestingModule({
      providers: [
        FollowUpProcessor,
        { provide: PrismaService, useValue: prisma },
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();
    processor = module.get(FollowUpProcessor);
  });

  it('повертається без виклику sendWithConfig, якщо followUpActive=false', async () => {
    prisma.organisationSettings.findFirst.mockResolvedValue({
      followUpActive: false,
      followUpDays: 90,
    });
    await processor.handleSendReminders(makeJob());
    expect(notifications.sendWithConfig).not.toHaveBeenCalled();
    expect(notifications.resolveConfig).not.toHaveBeenCalled();
  });

  it('повертається без виклику sendWithConfig, якщо org не має активного branch', async () => {
    prisma.organisationSettings.findFirst.mockResolvedValue({
      followUpActive: true,
      followUpDays: 90,
    });
    prisma.garageBranch.findFirst.mockResolvedValue(null);
    await processor.handleSendReminders(makeJob());
    expect(notifications.sendWithConfig).not.toHaveBeenCalled();
  });

  it('повертається без виклику sendWithConfig, якщо SMS не налаштовано (resolveConfig=null)', async () => {
    prisma.organisationSettings.findFirst.mockResolvedValue({
      followUpActive: true,
      followUpDays: 90,
    });
    prisma.garageBranch.findFirst.mockResolvedValue({ id: 'br-1' });
    prisma.maintenanceSchedule.findMany.mockResolvedValue([schedule()]);
    prisma.vehicle.findMany.mockResolvedValue([]);
    // Simulate: SMS not configured or template missing
    notifications.resolveConfig.mockResolvedValue(null);

    await processor.handleSendReminders(makeJob());
    expect(notifications.sendWithConfig).not.toHaveBeenCalled();
    // resolveConfig called once (not per-recipient)
    expect(notifications.resolveConfig).toHaveBeenCalledTimes(1);
    expect(notifications.resolveConfig).toHaveBeenCalledWith('org-1', 'br-1', 'FOLLOWUP_REMINDER');
  });

  it('фільтрує soft-deleted vehicles/garages/counterparties у maintenance', async () => {
    prisma.organisationSettings.findFirst.mockResolvedValue({
      followUpActive: true,
      followUpDays: 90,
    });
    prisma.garageBranch.findFirst.mockResolvedValue({ id: 'br-1' });
    prisma.maintenanceSchedule.findMany.mockResolvedValue([
      // Active — ok
      schedule({ id: 'sch-keep' }),
      // soft-deleted vehicle — filtered
      schedule({ id: 'sch-deleted-v', vehicle: vehicle({ deletedAt: new Date() }) }),
      // soft-deleted garage — filtered
      schedule({
        id: 'sch-deleted-g',
        vehicle: vehicle({
          customerGarage: {
            id: 'cg-2',
            deletedAt: new Date(),
            counterparty: cp({ id: 'cp-2', phone: '+380999' }),
          },
        }),
      }),
      // soft-deleted counterparty — filtered
      schedule({
        id: 'sch-deleted-cp',
        vehicle: vehicle({
          customerGarage: {
            id: 'cg-3',
            deletedAt: null,
            counterparty: cp({ id: 'cp-3', phone: '+380888', deletedAt: new Date() }),
          },
        }),
      }),
    ]);
    prisma.vehicle.findMany.mockResolvedValue([]);

    await processor.handleSendReminders(makeJob());
    // Тільки 1 SMS — для активного запису
    expect(notifications.sendWithConfig).toHaveBeenCalledTimes(1);
    expect(notifications.sendWithConfig).toHaveBeenCalledWith(
      'org-1',
      '+380671234567',
      DEFAULT_SMS_CONFIG,
      expect.objectContaining({ vehicleMake: 'Toyota' }),
    );
    // resolveConfig — 1 раз на весь batch (не per-recipient)
    expect(notifications.resolveConfig).toHaveBeenCalledTimes(1);
  });

  it('дедуплікує phone — один клієнт з кількома авто отримує лише 1 SMS', async () => {
    prisma.organisationSettings.findFirst.mockResolvedValue({
      followUpActive: true,
      followUpDays: 90,
    });
    prisma.garageBranch.findFirst.mockResolvedValue({ id: 'br-1' });
    // Той самий phone у двох розкладах maintenance
    prisma.maintenanceSchedule.findMany.mockResolvedValue([
      schedule({ id: 'sch-1' }),
      schedule({ id: 'sch-2', vehicle: vehicle({ id: 'veh-2', licensePlate: 'BB5555CC' }) }),
    ]);
    prisma.vehicle.findMany.mockResolvedValue([]);

    await processor.handleSendReminders(makeJob());
    expect(notifications.sendWithConfig).toHaveBeenCalledTimes(1);
  });

  it('пропускає клієнтів без phone', async () => {
    prisma.organisationSettings.findFirst.mockResolvedValue({
      followUpActive: true,
      followUpDays: 90,
    });
    prisma.garageBranch.findFirst.mockResolvedValue({ id: 'br-1' });
    prisma.maintenanceSchedule.findMany.mockResolvedValue([
      schedule({
        vehicle: vehicle({
          customerGarage: { id: 'cg-1', deletedAt: null, counterparty: cp({ phone: null }) },
        }),
      }),
    ]);
    prisma.vehicle.findMany.mockResolvedValue([]);

    await processor.handleSendReminders(makeJob());
    expect(notifications.sendWithConfig).not.toHaveBeenCalled();
  });

  it('inactive vehicle з останнім WO до cutoff надсилається SMS', async () => {
    prisma.organisationSettings.findFirst.mockResolvedValue({
      followUpActive: true,
      followUpDays: 90,
    });
    prisma.garageBranch.findFirst.mockResolvedValue({ id: 'br-1' });
    prisma.maintenanceSchedule.findMany.mockResolvedValue([]);
    const oldCompletedAt = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000); // 120 days ago
    prisma.vehicle.findMany.mockResolvedValue([
      vehicle({
        customerGarage: {
          id: 'cg-1',
          deletedAt: null,
          counterparty: cp({ phone: '+380777' }),
        },
        workOrders: [{ id: 'wo-old', completedAt: oldCompletedAt }],
      }),
    ]);

    await processor.handleSendReminders(makeJob());
    expect(notifications.sendWithConfig).toHaveBeenCalledTimes(1);
    expect(notifications.sendWithConfig).toHaveBeenCalledWith(
      'org-1',
      '+380777',
      DEFAULT_SMS_CONFIG,
      expect.any(Object),
    );
  });

  it('inactive vehicle без жодного COMPLETED WO — пропуск (DB filter заодно + defensive check)', async () => {
    prisma.organisationSettings.findFirst.mockResolvedValue({
      followUpActive: true,
      followUpDays: 90,
    });
    prisma.garageBranch.findFirst.mockResolvedValue({ id: 'br-1' });
    prisma.maintenanceSchedule.findMany.mockResolvedValue([]);
    prisma.vehicle.findMany.mockResolvedValue([
      vehicle({
        customerGarage: {
          id: 'cg-1',
          deletedAt: null,
          counterparty: cp({ phone: '+380555' }),
        },
        workOrders: [], // no completed WO
      }),
    ]);

    await processor.handleSendReminders(makeJob());
    expect(notifications.sendWithConfig).not.toHaveBeenCalled();
  });

  it('throw lastError, якщо ВСІ виклики sendWithConfig провалились (для BullMQ retry)', async () => {
    prisma.organisationSettings.findFirst.mockResolvedValue({
      followUpActive: true,
      followUpDays: 90,
    });
    prisma.garageBranch.findFirst.mockResolvedValue({ id: 'br-1' });
    prisma.maintenanceSchedule.findMany.mockResolvedValue([schedule()]);
    prisma.vehicle.findMany.mockResolvedValue([]);
    notifications.sendWithConfig.mockRejectedValueOnce(new Error('Redis недоступний'));

    await expect(processor.handleSendReminders(makeJob())).rejects.toThrow('Redis недоступний');
  });

  it('НЕ throw якщо частина sendWithConfig успішна (часткові помилки не блокують batch)', async () => {
    prisma.organisationSettings.findFirst.mockResolvedValue({
      followUpActive: true,
      followUpDays: 90,
    });
    prisma.garageBranch.findFirst.mockResolvedValue({ id: 'br-1' });
    prisma.maintenanceSchedule.findMany.mockResolvedValue([
      schedule({
        id: 's1',
        vehicle: vehicle({
          id: 'v1',
          customerGarage: {
            id: 'cg-1',
            deletedAt: null,
            counterparty: cp({ id: 'c1', phone: '+380111' }),
          },
        }),
      }),
      schedule({
        id: 's2',
        vehicle: vehicle({
          id: 'v2',
          customerGarage: {
            id: 'cg-2',
            deletedAt: null,
            counterparty: cp({ id: 'c2', phone: '+380222' }),
          },
        }),
      }),
    ]);
    prisma.vehicle.findMany.mockResolvedValue([]);
    notifications.sendWithConfig.mockRejectedValueOnce(new Error('Phone invalid')); // 1st fails
    notifications.sendWithConfig.mockResolvedValueOnce(undefined); // 2nd succeeds

    await expect(processor.handleSendReminders(makeJob())).resolves.toBeUndefined();
    expect(notifications.sendWithConfig).toHaveBeenCalledTimes(2);
  });

  it('formatName fallback "клієнте" для контрагента без імен → SMS не "Вітаємо, !"', async () => {
    prisma.organisationSettings.findFirst.mockResolvedValue({
      followUpActive: true,
      followUpDays: 90,
    });
    prisma.garageBranch.findFirst.mockResolvedValue({ id: 'br-1' });
    prisma.maintenanceSchedule.findMany.mockResolvedValue([
      schedule({
        vehicle: vehicle({
          customerGarage: {
            id: 'cg-1',
            deletedAt: null,
            counterparty: cp({
              firstName: null,
              lastName: null,
              companyName: null,
              phone: '+380000',
            }),
          },
        }),
      }),
    ]);
    prisma.vehicle.findMany.mockResolvedValue([]);

    await processor.handleSendReminders(makeJob());
    expect(notifications.sendWithConfig).toHaveBeenCalledWith(
      'org-1',
      '+380000',
      DEFAULT_SMS_CONFIG,
      expect.objectContaining({ clientName: 'клієнте' }),
    );
  });

  it('запит maintenanceSchedule фільтрує nextMaintenanceDate { gte: today, lte: today+14d }', async () => {
    prisma.organisationSettings.findFirst.mockResolvedValue({
      followUpActive: true,
      followUpDays: 90,
    });
    prisma.garageBranch.findFirst.mockResolvedValue({ id: 'br-1' });
    prisma.maintenanceSchedule.findMany.mockResolvedValue([]);
    prisma.vehicle.findMany.mockResolvedValue([]);

    await processor.handleSendReminders(makeJob());

    expect(prisma.maintenanceSchedule.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          nextMaintenanceDate: expect.objectContaining({
            gte: expect.any(Date),
            lte: expect.any(Date),
          }),
        }),
      }),
    );
  });

  it('запит vehicle фільтрує some+none — авто з минулим WO але без recent activity', async () => {
    prisma.organisationSettings.findFirst.mockResolvedValue({
      followUpActive: true,
      followUpDays: 90,
    });
    prisma.garageBranch.findFirst.mockResolvedValue({ id: 'br-1' });
    prisma.maintenanceSchedule.findMany.mockResolvedValue([]);
    prisma.vehicle.findMany.mockResolvedValue([]);

    await processor.handleSendReminders(makeJob());

    const where = prisma.vehicle.findMany.mock.calls[0][0].where;
    expect(where.workOrders).toBeDefined();
    expect(where.workOrders.some).toBeDefined();
    expect(where.workOrders.none).toBeDefined();
  });

  it('обирає НАЙСТАРІШИЙ branch (orderBy: createdAt asc) для стабільного SMS sender', async () => {
    prisma.organisationSettings.findFirst.mockResolvedValue({
      followUpActive: true,
      followUpDays: 90,
    });
    prisma.garageBranch.findFirst.mockResolvedValue({ id: 'br-1' });
    prisma.maintenanceSchedule.findMany.mockResolvedValue([]);
    prisma.vehicle.findMany.mockResolvedValue([]);

    await processor.handleSendReminders(makeJob());

    expect(prisma.garageBranch.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: { createdAt: 'asc' },
      }),
    );
  });
});
