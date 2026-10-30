import { vi } from 'vitest';
import { Prisma, type DomainEvent } from '@prisma/client';
import type { ConfigService } from '@nestjs/config';
import { memoryTable } from '../cash/cash.spec-fixture';
import { TasksService } from '../tasks/tasks.service';
import { NotificationsService } from '../notifications/notifications.service';
import type { NotificationProviderRegistry } from '../notifications/providers/provider-registry';
import { TelegramRecipientsService } from '../notifications/telegram-recipients.service';
import type { PrismaService } from '../../prisma/prisma.service';
import { AutomationActionsService } from './automation-actions.service';
import { AutomationContextService, type DocumentContext } from './automation-context.service';
import { AutomationEngine } from './automation-engine';

// Двигун правил над таблицями в пам'яті: `where` справді обчислюється (memoryTable), тож зниклий
// `enabled: true`, `status: { not: 'FIRED' }` чи `orgId` у фільтрі ламає тест, а не проходить
// мовчки. Зовнішнє — черга `sms` (enqueueChain) і канали філії (resolveChannels) — моки.
//
// Factory, не const: `isolate: false` без `clearMocks` — спільний стан протікав би між файлами.

type Row = Record<string, unknown>;

export const ORG = 'org-a';
export const OTHER_ORG = 'org-b';
export const BRANCH = 'b0000000-0000-4000-8000-000000000001';
export const OTHER_BRANCH = 'b0000000-0000-4000-8000-000000000002';
export const DOC = 'doc-wo-1';
export const CP = 'cp-1';
export const ACTOR = 'e0000000-0000-4000-8000-000000000001';
export const MECH_1 = 'e0000000-0000-4000-8000-000000000002';
export const MECH_2 = 'e0000000-0000-4000-8000-000000000003';
export const RECEPTION = 'e0000000-0000-4000-8000-000000000004';
export const FIRED = 'e0000000-0000-4000-8000-000000000005';
export const ON_LEAVE = 'e0000000-0000-4000-8000-000000000006';
export const FOREIGN = 'e0000000-0000-4000-8000-000000000007';

const emp = (id: string, role: string, over: Row = {}): Row => ({
  id,
  orgId: ORG,
  role,
  status: 'ACTIVE',
  phone: null,
  email: null,
  deletedAt: null,
  ...over,
});

export function defaultEmployees(): Row[] {
  return [
    emp(ACTOR, 'RECEPTIONIST', { phone: '+380670000001' }),
    emp(MECH_1, 'MECHANIC', { phone: '+380670000002' }),
    emp(MECH_2, 'MECHANIC', { phone: null }),
    emp(RECEPTION, 'RECEPTIONIST', { phone: '+380670000004' }),
    emp(FIRED, 'MECHANIC', { status: 'FIRED', phone: '+380670000005' }),
    emp(ON_LEAVE, 'MECHANIC', { status: 'ON_LEAVE' }),
    emp(FOREIGN, 'MECHANIC', { orgId: OTHER_ORG }),
  ];
}

/** Контекст наряду: клієнт з телефоном і email, два виконавці, філія, сума 5000. */
export function fakeCtx(over: Partial<DocumentContext> = {}): DocumentContext {
  return {
    documentType: 'WORK_ORDER',
    documentId: DOC,
    status: 'IN_PROGRESS',
    branchId: BRANCH,
    messageBranchId: BRANCH,
    amount: 5000,
    repairCategory: 'MAINTENANCE',
    priority: 'NORMAL',
    client: {
      counterpartyId: CP,
      name: 'Петренко Іван',
      phone: '+380671112233',
      email: 'ivan@example.com',
      noServiceMessages: false,
      marketingConsent: false,
      preferredChannel: null,
    },
    responsibleIds: [MECH_1, MECH_2],
    responsibleIsAuthor: false,
    workOrderId: DOC,
    vehicleId: 'veh-1',
    counterpartyId: CP,
    vars: {
      documentNumber: 'НРД-7',
      clientName: 'Петренко Іван',
      vehicle: 'Toyota Camry (AA1234BB)',
      totalAmount: '5 000,00 грн',
      status: 'В роботі',
      branchName: 'Центральна',
      branchPhone: '+380441234567',
    },
    ...over,
  };
}

let seq = 0;

export function fakeEvent(over: Partial<DomainEvent> = {}): DomainEvent {
  seq += 1;
  return {
    id: `evt-${seq}`,
    orgId: ORG,
    documentType: 'WORK_ORDER',
    documentId: DOC,
    kind: 'STATUS_CHANGED',
    fromStatus: 'APPROVED',
    toStatus: 'IN_PROGRESS',
    actorId: ACTOR,
    occurredAt: new Date('2026-10-29T10:00:00.000Z'), // 12:00 Києва — поза тихими годинами
    processedAt: null,
    attempts: 0,
    lastError: null,
    syncVersion: BigInt(0),
    createdAt: new Date('2026-10-29T10:00:00.000Z'),
    updatedAt: new Date('2026-10-29T10:00:00.000Z'),
    deletedAt: null,
    ...over,
  };
}

/** Дія «повідомлення клієнту» Viber → SMS. */
export const clientMessage = (over: Row = {}): Row => ({
  type: 'client_message',
  channels: ['VIBER', 'SMS'],
  template: { body: '{{clientName}}, авто {{vehicle}}: {{status}}' },
  ...over,
});

export function fakeRule(over: Row = {}): Row {
  seq += 1;
  return {
    id: `rule-${seq}`,
    orgId: ORG,
    name: `Правило ${seq}`,
    enabled: true,
    documentType: 'WORK_ORDER',
    eventKind: 'STATUS_CHANGED',
    toStatuses: ['IN_PROGRESS'],
    conditions: {},
    actions: [clientMessage()],
    messageKind: 'SERVICE',
    systemKey: null,
    createdById: null,
    createdAt: new Date(`2026-01-01T00:00:${String(seq % 60).padStart(2, '0')}.000Z`),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    deletedAt: null,
    ...over,
  };
}

export interface HarnessInit {
  rules?: Row[];
  employees?: Row[];
  tasks?: Row[];
  events?: Row[];
  /** Налаштовані канали філії (решта — «не налаштовано»). */
  channels?: string[];
  quiet?: [string, string];
  ctx?: DocumentContext | null;
  /** Токен власного Telegram-бота організації; без нього бот не підключено (BR-AUT-040). */
  botToken?: string | null;
  /** Підписки на бот (BR-AUT-041). */
  subscriptions?: Row[];
  /**
   * Рядки `NotificationChannelConfig` філії: з ними канали резолвить СПРАВЖНІЙ
   * `NotificationsService.resolveChannels` (пріоритет, бот, legacy SMS), а не мок `channels`.
   */
  branchConfigs?: Row[];
  /** Legacy SMS філії (`BranchSettings`) — лише разом із `branchConfigs`. */
  legacySms?: boolean;
}

/** Провайдери для справжнього `resolveChannels`: TurboSMS, SMTP і власний бот (креди в org). */
const fakeRegistry = (): NotificationProviderRegistry => {
  const providers: Record<string, Row> = {
    turbosms: { code: 'turbosms', channels: ['SMS', 'VIBER'] },
    smtp: { code: 'smtp', channels: ['EMAIL'] },
    'telegram-bot': { code: 'telegram-bot', channels: ['TELEGRAM_BOT'], orgCredentials: true },
  };
  return {
    get: (code: string) => providers[code] ?? null,
  } as unknown as NotificationProviderRegistry;
};

export function automationHarness(init: HarnessInit = {}) {
  const runs: Row[] = [];
  const runTable = memoryTable(runs, () => ({
    deletedAt: null,
    isTest: false,
    createdAt: new Date(),
  }));
  // Унікальна пара (ruleId, eventId) — як @@unique у схемі: дубль → P2002.
  const baseCreate = runTable.create;
  runTable.create = vi.fn((args: { data: Row }) =>
    runs.some(r => r.ruleId === args.data.ruleId && r.eventId === args.data.eventId)
      ? Promise.reject(
          new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
            code: 'P2002',
            clientVersion: 'test',
          }),
        )
      : baseCreate(args),
  );

  const tables = {
    automationRule: memoryTable(init.rules ?? [], () => ({
      createdAt: new Date(),
      updatedAt: new Date(),
      systemKey: null,
      deletedAt: null,
    })),
    automationRun: runTable,
    employee: memoryTable(init.employees ?? defaultEmployees()),
    employeeNotification: memoryTable([], () => ({ deletedAt: null, readAt: null, body: null })),
    notificationLog: memoryTable([]),
    task: memoryTable(init.tasks ?? [], () => ({ status: 'NEW', deletedAt: null })),
    domainEvent: memoryTable(init.events ?? []),
    garageBranch: memoryTable([
      { id: BRANCH, orgId: ORG, name: 'Центральна', deletedAt: null },
      { id: OTHER_BRANCH, orgId: OTHER_ORG, name: 'Чужа', deletedAt: null },
    ]),
    organisationSettings: memoryTable([
      {
        orgId: ORG,
        quietHoursStart: init.quiet?.[0] ?? '21:00',
        quietHoursEnd: init.quiet?.[1] ?? '09:00',
        telegramBotToken: init.botToken ?? null,
      },
    ]),
    telegramSubscription: memoryTable(init.subscriptions ?? [], () => ({
      active: true,
      deletedAt: null,
      subscribedAt: new Date(),
    })),
    notificationChannelConfig: memoryTable(
      (init.branchConfigs ?? []).map(r => ({
        orgId: ORG,
        branchId: BRANCH,
        enabled: true,
        apiKey: 'key',
        senderName: 'STO',
        externalTemplateId: null,
        deletedAt: null,
        ...r,
      })),
    ),
    branchSettings: memoryTable(
      init.legacySms
        ? [
            {
              orgId: ORG,
              branchId: BRANCH,
              smsEnabled: true,
              smsApiKey: 'legacy',
              smsProvider: 'turbosms',
              smsSenderName: 'OLD',
            },
          ]
        : [],
    ),
  };
  const prisma = {
    ...tables,
    $transaction: vi.fn((cb: (tx: unknown) => unknown) => cb(prisma)),
  } as unknown as PrismaService & typeof tables;

  const telegram = new TelegramRecipientsService(prisma);
  // Налаштовані канали філії в пріоритеті власника; `wanted = null` — «як у філії» (BR-AUT-011).
  const configured = init.channels ?? ['VIBER', 'SMS', 'EMAIL'];
  let notifications: NotificationsService;
  let enqueueChain;
  let resolveChannels;
  if (init.branchConfigs) {
    notifications = new NotificationsService(
      prisma,
      fakeRegistry(),
      { add: vi.fn() } as never,
      telegram,
    );
    enqueueChain = vi.spyOn(notifications, 'enqueueChain').mockResolvedValue(undefined);
    resolveChannels = vi.spyOn(notifications, 'resolveChannels');
  } else {
    enqueueChain = vi.fn().mockResolvedValue(undefined);
    resolveChannels = vi.fn((_org: string, _branch: string, wanted: readonly string[] | null) =>
      Promise.resolve(
        (wanted ?? configured)
          .filter(c => configured.includes(c))
          .map(c => ({ channel: c, provider: 'turbosms', senderName: 'STO' })),
      ),
    );
    notifications = { enqueueChain, resolveChannels } as unknown as NotificationsService;
  }

  const config = { get: vi.fn().mockReturnValue(undefined) } as unknown as ConfigService;
  const context = new AutomationContextService(prisma, config);
  const load = vi
    .spyOn(context, 'load')
    .mockResolvedValue(init.ctx === undefined ? fakeCtx() : init.ctx);
  const tasks = new TasksService(prisma);
  const actions = new AutomationActionsService(prisma, notifications, tasks, context, telegram);
  const engine = new AutomationEngine(prisma, context, actions);

  return {
    prisma,
    tables,
    runs,
    engine,
    actions,
    context,
    load,
    enqueueChain,
    resolveChannels,
    telegram,
  };
}
