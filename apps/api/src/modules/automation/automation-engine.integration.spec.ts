import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import { createPgAdapter } from '../../prisma/pg-adapter';
import { withTenantGuard } from '../../prisma/tenant-guard.extension';
import type { PrismaService } from '../../prisma/prisma.service';
import { runWithTenant } from '../../common/tenant/tenant-context';
import { handleDbUnavailable, testDatabaseUrl } from '../../common/testing/require-db';
import { NotificationsService } from '../notifications/notifications.service';
import { TelegramRecipientsService } from '../notifications/telegram-recipients.service';
import type { NotificationProviderRegistry } from '../notifications/providers/provider-registry';
import { TasksService } from '../tasks/tasks.service';
import { AutomationActionsService } from './automation-actions.service';
import { AutomationContextService } from './automation-context.service';
import { AutomationEngine } from './automation-engine';

/**
 * Двигун правил на ЖИВІЙ БД (docs/objects/automation.md): подія онлайн-запису → правило → журнал
 * спрацювання, повідомлення клієнту в журналі (філія без каналів — «пропущено» з причиною),
 * сповіщення механіку, задача від «Автоматизації». Повторна обробка події — без дублів
 * (унікальна пара правило + подія). Через tenant-guard, як у prisma.service.
 *
 * Дані — власна організація (випадковий uuid, назва з префіксом `000 TST`); прибирання в
 * `afterAll` за цим orgId. Без БД — SKIP (у CI з REQUIRE_DB=1 — падіння).
 */
const ORG = randomUUID();

let raw: PrismaClient;
let guarded: PrismaClient;
let dbAvailable = false;
let mechanicId = '';
let bookingId = '';
let ruleId = '';
let eventId = '';

function engineOn(prisma: PrismaService) {
  const queue = { add: vi.fn().mockResolvedValue({}) } as unknown as Queue;
  const registry = { get: vi.fn() } as unknown as NotificationProviderRegistry;
  const telegram = new TelegramRecipientsService(prisma);
  const notifications = new NotificationsService(prisma, registry, queue, telegram);
  const config = { get: vi.fn().mockReturnValue(undefined) } as unknown as ConfigService;
  const context = new AutomationContextService(prisma, config);
  const actions = new AutomationActionsService(
    prisma,
    notifications,
    new TasksService(prisma),
    context,
    telegram,
  );
  return new AutomationEngine(prisma, context, actions);
}

beforeAll(async () => {
  raw = new PrismaClient({ adapter: createPgAdapter(testDatabaseUrl()) });
  try {
    await raw.$connect();
    await raw.$queryRaw`SELECT 1 FROM automation_rules LIMIT 1`;
    guarded = withTenantGuard(raw) as PrismaClient;
    dbAvailable = true;
  } catch {
    dbAvailable = false;
    handleDbUnavailable('підключення або таблиця automation_rules недоступні');
    return;
  }
  await raw.organisation.create({ data: { id: ORG, orgId: ORG, name: '000 TST автоматизація' } });
  const branch = await raw.garageBranch.create({
    data: { orgId: ORG, name: '000 TST філія', address: '—' },
  });
  const mech = await raw.employee.create({
    data: { orgId: ORG, firstName: 'Тест', lastName: '000 TST', role: 'MECHANIC', rateScheme: {} },
  });
  mechanicId = mech.id;
  const booking = await raw.bookingRequest.create({
    data: {
      orgId: ORG,
      branchId: branch.id,
      status: 'PENDING',
      clientName: '000 TST Клієнт',
      clientPhone: '+380670000000',
      requestedDate: new Date('2026-11-02T08:00:00.000Z'),
      serviceIds: [],
    },
  });
  bookingId = booking.id;
  const rule = await raw.automationRule.create({
    data: {
      orgId: ORG,
      name: '000 TST запис → клієнт, механік, задача',
      documentType: 'BOOKING',
      eventKind: 'CREATED',
      actions: [
        { type: 'client_message', channels: ['SMS'], template: { body: 'Запис {{visitDate}}' } },
        {
          type: 'employee_notification',
          recipients: { roles: ['MECHANIC'] },
          title: 'Новий запис: {{clientName}}',
          inApp: true,
        },
        {
          type: 'create_task',
          title: 'Передзвонити {{clientName}}',
          assignee: { employeeId: mech.id },
          dueInHours: 1,
          priority: 'NORMAL',
        },
      ],
    },
  });
  ruleId = rule.id;
  const event = await raw.domainEvent.create({
    data: {
      orgId: ORG,
      documentType: 'BOOKING',
      documentId: booking.id,
      kind: 'CREATED',
      toStatus: 'PENDING',
      occurredAt: new Date('2026-10-29T10:00:00.000Z'),
    },
  });
  eventId = event.id;
}, 30_000);

afterAll(async () => {
  if (raw && dbAvailable) {
    const where = { where: { orgId: ORG } };
    await raw.employeeNotification.deleteMany(where).catch(() => undefined);
    await raw.notificationLog.deleteMany(where).catch(() => undefined);
    await raw.task.deleteMany(where).catch(() => undefined);
    await raw.automationRun.deleteMany(where).catch(() => undefined);
    await raw.automationRule.deleteMany(where).catch(() => undefined);
    await raw.domainEvent.deleteMany(where).catch(() => undefined);
    await raw.bookingRequest.deleteMany(where).catch(() => undefined);
    await raw.employee.deleteMany(where).catch(() => undefined);
    await raw.garageBranch.deleteMany(where).catch(() => undefined);
    await raw.organisation.deleteMany({ where: { id: ORG } }).catch(() => undefined);
  }
  await raw?.$disconnect().catch(() => undefined);
});

describe('AutomationEngine — integration (жива БД)', () => {
  // guards: BR-AUT-004, BR-AUT-005, BR-AUT-021, BR-AUT-030, BR-AUT-031, BR-AUT-050
  it('подія → спрацювання з результатом кожної дії, журнал повідомлення, сповіщення, задача', async () => {
    if (!dbAvailable) return;
    const event = await raw.domainEvent.findFirstOrThrow({ where: { id: eventId } });
    await runWithTenant({ orgId: ORG }, () =>
      engineOn(guarded as unknown as PrismaService).handle(event),
    );

    const runs = await raw.automationRun.findMany({ where: { orgId: ORG } });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ ruleId, eventId, status: 'DONE' });
    expect(runs[0]!.actionResults).toEqual([
      expect.objectContaining({ type: 'client_message', status: 'SKIPPED', reason: 'NO_CHANNEL' }),
      expect.objectContaining({ type: 'employee_notification', status: 'DONE', recipients: 1 }),
      expect.objectContaining({ type: 'create_task', status: 'DONE' }),
    ]);

    const logs = await raw.notificationLog.findMany({ where: { orgId: ORG } });
    expect(logs).toEqual([
      expect.objectContaining({
        status: 'SKIPPED',
        skipReason: 'NO_CHANNEL',
        ruleId,
        documentType: 'BOOKING',
        documentId: bookingId,
        eventType: null,
        isTest: false,
      }),
    ]);

    const inbox = await raw.employeeNotification.findMany({ where: { orgId: ORG } });
    // Механіку — сповіщення правила й сповіщення про нову задачу.
    expect(inbox.map(n => n.title).sort()).toEqual([
      'Новий запис: 000 TST Клієнт',
      'Передзвонити 000 TST Клієнт',
    ]);
    expect(inbox.every(n => n.employeeId === mechanicId && n.readAt === null)).toBe(true);

    const tasks = await raw.task.findMany({ where: { orgId: ORG } });
    expect(tasks).toEqual([
      expect.objectContaining({
        createdById: null,
        assigneeId: mechanicId,
        automationRuleId: ruleId,
        entityType: 'BOOKING',
        entityId: bookingId,
        dueAt: new Date('2026-10-29T11:00:00.000Z'),
      }),
    ]);
    // Подія «створено» задачі — в outbox (система, без ініціатора).
    const taskEvents = await raw.domainEvent.findMany({
      where: { orgId: ORG, documentType: 'TASK', documentId: tasks[0]!.id },
    });
    expect(taskEvents).toEqual([expect.objectContaining({ kind: 'CREATED', actorId: null })]);
  });

  // guards: BR-AUT-004, BR-AUT-032
  it('повторна обробка тієї самої події — без другого спрацювання, задачі й сповіщень', async () => {
    if (!dbAvailable) return;
    const event = await raw.domainEvent.findFirstOrThrow({ where: { id: eventId } });
    await runWithTenant({ orgId: ORG }, () =>
      engineOn(guarded as unknown as PrismaService).handle(event),
    );
    expect(await raw.automationRun.count({ where: { orgId: ORG } })).toBe(1);
    expect(await raw.task.count({ where: { orgId: ORG } })).toBe(1);
    expect(await raw.employeeNotification.count({ where: { orgId: ORG } })).toBe(2);
    // Друга вставка тієї самої пари (правило, подія) — порушення унікальності в самій БД.
    await expect(
      raw.automationRun.create({ data: { orgId: ORG, ruleId, eventId, status: 'DONE' } }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });
});
