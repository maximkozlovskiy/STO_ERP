import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { Job } from 'bullmq';
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
    await processor.process(makeJob());
    expect(notifications.sendWithConfig).not.toHaveBeenCalled();
    expect(notifications.resolveConfig).not.toHaveBeenCalled();
  });

  it('повертається без виклику sendWithConfig, якщо org не має активного branch', async () => {
    prisma.organisationSettings.findFirst.mockResolvedValue({
      followUpActive: true,
      followUpDays: 90,
    });
    prisma.garageBranch.findFirst.mockResolvedValue(null);
    await processor.process(makeJob());
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

    await processor.process(makeJob());
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

    await processor.process(makeJob());
    // Тільки 1 SMS — для активного запису
    expect(notifications.sendWithConfig).toHaveBeenCalledTimes(1);
    expect(notifications.sendWithConfig).toHaveBeenCalledWith(
      'org-1',
      DEFAULT_SMS_CONFIG,
      expect.objectContaining({ phone: '+380671234567', vehicleMake: 'Toyota' }),
      'br-1',
      'FOLLOWUP_REMINDER',
    );
    // resolveConfig — 1 раз на весь batch (не per-recipient)
    expect(notifications.resolveConfig).toHaveBeenCalledTimes(1);
  });

  it('multi-branch: кожен отримувач шле через SMS-конфіг СВОЄЇ філії (C3)', async () => {
    prisma.organisationSettings.findFirst.mockResolvedValue({
      followUpActive: true,
      followUpDays: 90,
    });
    // fallbackBranch = br-1 (найстаріша).
    prisma.garageBranch.findFirst.mockResolvedValue({ id: 'br-1' });
    // Recipient A: авто з останнім нарядом у br-2 → шле через br-2.
    // Recipient B: авто без наряду → fallback br-1.
    prisma.maintenanceSchedule.findMany.mockResolvedValue([
      schedule({
        id: 'sch-A',
        vehicle: vehicle({
          id: 'veh-A',
          workOrders: [{ branchId: 'br-2' }],
          customerGarage: {
            id: 'cg-A',
            deletedAt: null,
            counterparty: cp({ id: 'cp-A', phone: '+380670000001' }),
          },
        }),
      }),
      schedule({
        id: 'sch-B',
        vehicle: vehicle({
          id: 'veh-B',
          workOrders: [], // без наряду → fallback br-1
          customerGarage: {
            id: 'cg-B',
            deletedAt: null,
            counterparty: cp({ id: 'cp-B', phone: '+380670000002' }),
          },
        }),
      }),
    ]);
    prisma.vehicle.findMany.mockResolvedValue([]);
    // Різні конфіги per-branch.
    const CFG_BR1 = { ...DEFAULT_SMS_CONFIG, senderName: 'STO-1' };
    const CFG_BR2 = { ...DEFAULT_SMS_CONFIG, senderName: 'STO-2' };
    notifications.resolveConfig.mockImplementation(async (_org: string, branchId: string) =>
      branchId === 'br-2' ? CFG_BR2 : CFG_BR1,
    );

    await processor.process(makeJob());

    // resolveConfig — по одному разу на КОЖНУ унікальну філію (br-1, br-2), не per-recipient.
    expect(notifications.resolveConfig).toHaveBeenCalledTimes(2);
    expect(notifications.resolveConfig).toHaveBeenCalledWith('org-1', 'br-1', 'FOLLOWUP_REMINDER');
    expect(notifications.resolveConfig).toHaveBeenCalledWith('org-1', 'br-2', 'FOLLOWUP_REMINDER');
    // Recipient A шле через br-2 + CFG_BR2.
    expect(notifications.sendWithConfig).toHaveBeenCalledWith(
      'org-1',
      CFG_BR2,
      expect.objectContaining({ phone: '+380670000001' }),
      'br-2',
      'FOLLOWUP_REMINDER',
    );
    // Recipient B шле через br-1 + CFG_BR1.
    expect(notifications.sendWithConfig).toHaveBeenCalledWith(
      'org-1',
      CFG_BR1,
      expect.objectContaining({ phone: '+380670000002' }),
      'br-1',
      'FOLLOWUP_REMINDER',
    );
  });

  it('cursor-пагінація: збирає отримувачів з КІЛЬКОХ сторінок maintenance (>PAGE_SIZE)', async () => {
    // T12: раніше `take: 1000` тихо губив нагадування для автопарків >1000. Тепер keyset-cursor.
    // Мок поважає cursor-аргумент: повна сторінка (PAGE_SIZE=500) → друга (коротка) сторінка → break.
    const PAGE_SIZE = 500;
    prisma.organisationSettings.findFirst.mockResolvedValue({
      followUpActive: true,
      followUpDays: 90,
    });
    prisma.garageBranch.findFirst.mockResolvedValue({ id: 'br-1' });

    const mkSchedule = (n: number) =>
      schedule({
        id: `sch-${String(n).padStart(4, '0')}`,
        vehicle: vehicle({
          id: `veh-${n}`,
          licensePlate: `PLATE-${n}`,
          customerGarage: {
            id: `cg-${n}`,
            deletedAt: null,
            // Унікальний phone на кожен запис → без дедуплікації.
            counterparty: cp({ id: `cp-${n}`, phone: `+38067${String(n).padStart(7, '0')}` }),
          },
        }),
      });
    // Сторінка 1: рівно PAGE_SIZE (0..499) → тригерить наступний fetch. Сторінка 2: 3 записи (500..502).
    const page1 = Array.from({ length: PAGE_SIZE }, (_, i) => mkSchedule(i));
    const page2 = Array.from({ length: 3 }, (_, i) => mkSchedule(PAGE_SIZE + i));
    const lastIdPage1 = page1[page1.length - 1]!.id;

    prisma.maintenanceSchedule.findMany.mockImplementation(
      async (args: { cursor?: { id: string } }) => (args.cursor ? page2 : page1),
    );
    prisma.vehicle.findMany.mockResolvedValue([]);

    await processor.process(makeJob());

    // Друга сторінка запитана з правильним keyset-cursor (останній id 1-ї сторінки, skip:1).
    expect(prisma.maintenanceSchedule.findMany).toHaveBeenCalledTimes(2);
    const secondCall = prisma.maintenanceSchedule.findMany.mock.calls[1][0];
    expect(secondCall).toMatchObject({ cursor: { id: lastIdPage1 }, skip: 1, take: PAGE_SIZE });
    // Усі 503 унікальні отримувачі (500 + 3) отримали SMS — жоден не загублений на межі сторінки.
    expect(notifications.sendWithConfig).toHaveBeenCalledTimes(PAGE_SIZE + 3);
    // resolveConfig — 1 раз на весь batch (спільна філія), не per-recipient/per-page.
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

    await processor.process(makeJob());
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

    await processor.process(makeJob());
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

    await processor.process(makeJob());
    expect(notifications.sendWithConfig).toHaveBeenCalledTimes(1);
    expect(notifications.sendWithConfig).toHaveBeenCalledWith(
      'org-1',
      DEFAULT_SMS_CONFIG,
      expect.objectContaining({ phone: '+380777' }),
      'br-1',
      'FOLLOWUP_REMINDER',
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

    await processor.process(makeJob());
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

    await expect(processor.process(makeJob())).rejects.toThrow('Redis недоступний');
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

    await expect(processor.process(makeJob())).resolves.toBeUndefined();
    expect(notifications.sendWithConfig).toHaveBeenCalledTimes(2);
  });

  // C3 skipped-counter arithmetic: отримувачі, чия філія без SMS-конфігу, пропускаються
  // (skipped), а НЕ рахуються як успіх. Promise.allSettled повертає їх як fulfilled
  // (Promise.resolve) → sendSuccess -= skipped коригує лічильник.
  describe('C3 — skipped-counter arithmetic (mixed skip/success/fail)', () => {
    // Двобранчева фікстура: A на br-config (є конфіг), B на br-nocfg (нема конфігу → skip).
    const setupTwoBranch = (resolveImpl: (org: string, branchId: string) => Promise<unknown>) => {
      prisma.organisationSettings.findFirst.mockResolvedValue({
        followUpActive: true,
        followUpDays: 90,
      });
      // fallbackBranch = br-config (для авто без наряду).
      prisma.garageBranch.findFirst.mockResolvedValue({ id: 'br-config' });
      prisma.maintenanceSchedule.findMany.mockResolvedValue([
        schedule({
          id: 'sch-A',
          vehicle: vehicle({
            id: 'veh-A',
            workOrders: [{ branchId: 'br-config' }],
            customerGarage: {
              id: 'cg-A',
              deletedAt: null,
              counterparty: cp({ id: 'cp-A', phone: '+380670000001' }),
            },
          }),
        }),
        schedule({
          id: 'sch-B',
          vehicle: vehicle({
            id: 'veh-B',
            workOrders: [{ branchId: 'br-nocfg' }],
            customerGarage: {
              id: 'cg-B',
              deletedAt: null,
              counterparty: cp({ id: 'cp-B', phone: '+380670000002' }),
            },
          }),
        }),
      ]);
      prisma.vehicle.findMany.mockResolvedValue([]);
      notifications.resolveConfig.mockImplementation(resolveImpl as never);
    };

    it('B без конфігу філії пропускається (skip), НЕ помилка; A шле нормально', async () => {
      setupTwoBranch(async (_org, branchId) =>
        branchId === 'br-config' ? DEFAULT_SMS_CONFIG : null,
      );

      // Success для A; не throw попри skip B (skip != error).
      await expect(processor.process(makeJob())).resolves.toBeUndefined();
      // Лише A реально надсилається; B skipped (cfg=null → Promise.resolve, без sendWithConfig).
      expect(notifications.sendWithConfig).toHaveBeenCalledTimes(1);
      expect(notifications.sendWithConfig).toHaveBeenCalledWith(
        'org-1',
        DEFAULT_SMS_CONFIG,
        expect.objectContaining({ phone: '+380670000001' }),
        'br-config',
        'FOLLOWUP_REMINDER',
      );
    });

    it('skip + реальний send fail → throw (усі НЕ-skip провалились = батч на retry)', async () => {
      setupTwoBranch(async (_org, branchId) =>
        branchId === 'br-config' ? DEFAULT_SMS_CONFIG : null,
      );
      // Єдиний реальний send (A) провалюється. B — skip. sendSuccess має стати 0 → throw.
      notifications.sendWithConfig.mockRejectedValue(new Error('SMS gateway down'));

      await expect(processor.process(makeJob())).rejects.toThrow('SMS gateway down');
      // Раніше: якби skip рахувався як success (без -= skipped), sendSuccess=1 → НЕ throw →
      // BullMQ не ретраїв би реальну помилку. Guard проти цієї арифметичної регресії.
    });

    it('skip + реальний send success → НЕ throw (skip не роздуває success понад реальні)', async () => {
      setupTwoBranch(async (_org, branchId) =>
        branchId === 'br-config' ? DEFAULT_SMS_CONFIG : null,
      );
      notifications.sendWithConfig.mockResolvedValue(undefined); // A success

      await expect(processor.process(makeJob())).resolves.toBeUndefined();
      expect(notifications.sendWithConfig).toHaveBeenCalledTimes(1);
    });

    it('ВСІ задіяні філії без конфігу → early return (жодного sendWithConfig, без skip-циклу)', async () => {
      // Обидва отримувачі на філіях без конфігу → configByBranch.every(null) → early return.
      setupTwoBranch(async () => null);

      await expect(processor.process(makeJob())).resolves.toBeUndefined();
      expect(notifications.sendWithConfig).not.toHaveBeenCalled();
    });
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

    await processor.process(makeJob());
    expect(notifications.sendWithConfig).toHaveBeenCalledWith(
      'org-1',
      DEFAULT_SMS_CONFIG,
      expect.objectContaining({ phone: '+380000', clientName: 'клієнте' }),
      'br-1',
      'FOLLOWUP_REMINDER',
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

    await processor.process(makeJob());

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

    await processor.process(makeJob());

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

    await processor.process(makeJob());

    expect(prisma.garageBranch.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: { createdAt: 'asc' },
      }),
    );
  });
});
