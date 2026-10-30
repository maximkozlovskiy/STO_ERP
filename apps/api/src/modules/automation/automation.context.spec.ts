/**
 * Дані документа для правил (docs/objects/automation.md, BR-AUT-010, 014, 020): кожна змінна
 * каталогу типу документа має значення — шаблон без порожніх місць (баги «Виконано» й «Оплата»:
 * шаблон чекав змінних, яких код не передавав); одержувач і «відповідальний» за типом документа;
 * переліки `@sto/shared` — у паритеті з Prisma-enum-ами.
 */
import { describe, it, expect, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import {
  AutomationMessageKind,
  InvoiceStatus,
  NotificationChannel,
  PurchaseOrderStatus,
  RepairCategory,
  StockDocumentStatus,
  SupplierPaymentStatus,
  SupplierReturnStatus,
  TaskStatus,
  UserRole,
  WorkOrderPriority,
  WorkOrderStatus,
} from '@prisma/client';
import {
  AUTOMATION_CHANNELS,
  AUTOMATION_DOCUMENT_TYPES,
  AUTOMATION_MESSAGE_KINDS,
  AUTOMATION_PRIORITIES,
  AUTOMATION_RECIPIENT_ROLES,
  AUTOMATION_REPAIR_CATEGORIES,
  AUTOMATION_STATUS_LABELS,
  AUTOMATION_VARIABLES,
} from '@sto/shared';
import type { PrismaService } from '../../prisma/prisma.service';
import { AutomationContextService } from './automation-context.service';
import { eventVars } from './automation-engine';

const cp = {
  id: 'cp-1',
  firstName: 'Іван',
  lastName: 'Петренко',
  companyName: null,
  phone: '+380671112233',
  email: 'ivan@example.com',
  noServiceMessages: false,
  marketingConsent: true,
  preferredChannel: 'TELEGRAM_BOT',
};
const supplier = { firstName: null, lastName: null, companyName: 'ТОВ Запчастини' };
const vehicle = { make: 'Toyota', model: 'Camry', licensePlate: 'AA1234BB' };
const future = new Date('2099-01-01T00:00:00.000Z');

const docs: Record<string, Record<string, unknown>> = {
  workOrder: {
    number: 'НРД-7',
    status: 'COMPLETED',
    branchId: 'br-1',
    totalAmount: 1250,
    repairCategory: 'MAINTENANCE',
    priority: 'HIGH',
    vehicleId: 'veh-1',
    counterpartyId: 'cp-1',
    shareToken: 'tok',
    shareTokenExpiresAt: future,
    counterparty: cp,
    vehicle,
    lines: [
      { employeeId: 'm-1', assistEmployees: [{ employeeId: 'm-3' }] },
      { employeeId: 'm-2', assistEmployees: [{ employeeId: 'm-1' }] },
    ],
  },
  invoice: {
    number: 'РАХ-3',
    status: 'SENT',
    amount: 1250,
    counterpartyId: 'cp-1',
    workOrderId: 'wo-1',
    counterparty: cp,
    workOrder: { branchId: 'br-1', vehicleId: 'veh-1', vehicle },
  },
  payment: {
    amount: 500,
    reversedAt: null,
    counterpartyId: 'cp-1',
    workOrderId: null,
    counterparty: cp,
    workOrder: null,
  },
  bookingRequest: {
    status: 'PENDING',
    branchId: 'br-1',
    clientName: 'Олена',
    clientPhone: '+380501112233',
    requestedDate: new Date('2026-10-30T08:00:00.000Z'),
  },
  purchaseOrder: {
    number: 'ЗП-1',
    status: 'ORDERED',
    totalAmount: 900,
    supplierId: 's-1',
    supplier,
    warehouse: { branchId: 'br-1' },
  },
  stockDocument: { number: 'СК-1', status: 'CONFIRMED', branchId: 'br-1' },
  supplierPayment: {
    number: 'ОП-1',
    status: 'CONFIRMED',
    amount: 900,
    supplierId: 's-1',
    supplier,
  },
  supplierReturn: {
    number: 'ПВ-1',
    status: 'DRAFT',
    totalAmount: 100,
    supplierId: 's-1',
    supplier,
    warehouse: { branchId: 'br-1' },
  },
  task: {
    title: 'Підготувати пост',
    status: 'NEW',
    priority: 'NORMAL',
    assigneeId: 'm-9',
    workOrderId: null,
    vehicleId: null,
    counterpartyId: null,
    assignee: { firstName: 'Андрій', lastName: 'Коваль' },
    workOrder: null,
  },
};

function service(found = true) {
  const prisma: Record<string, unknown> = {
    garageBranch: { findFirst: vi.fn().mockResolvedValue({ id: 'br-1', name: 'Центральна' }) },
    organisation: { findFirst: vi.fn().mockResolvedValue({ phone: '+380441234567' }) },
    domainEvent: { findFirst: vi.fn().mockResolvedValue({ actorId: 'author-1' }) },
    organisationSettings: { findFirst: vi.fn().mockResolvedValue({ currency: 'UAH' }) },
  };
  for (const [model, row] of Object.entries(docs))
    prisma[model] = { findFirst: vi.fn().mockResolvedValue(found ? row : null) };
  const config = {
    get: vi.fn().mockReturnValue('https://sto.example.com/'),
  } as unknown as ConfigService;
  return { prisma, svc: new AutomationContextService(prisma as unknown as PrismaService, config) };
}

describe('AutomationContextService — змінні й одержувачі', () => {
  // guards: BR-AUT-014
  it.each(AUTOMATION_DOCUMENT_TYPES)(
    '%s: кожна змінна каталогу має непорожнє значення',
    async type => {
      const { svc } = service();
      const ctx = await svc.load('org-a', type, 'doc-1');
      const vars = eventVars(ctx!, new Date('2026-10-29T10:00:00.000Z'));
      const empty = AUTOMATION_VARIABLES[type].filter(k => !vars[k]?.trim());
      expect(empty).toEqual([]);
    },
  );

  // guards: BR-AUT-014
  it('значення: сума «1 250,00 грн», статус — назвою, авто з номером, посилання на кошторис', async () => {
    const { svc } = service();
    const ctx = await svc.load('org-a', 'WORK_ORDER', 'doc-1');
    expect(ctx!.vars).toMatchObject({
      documentNumber: 'НРД-7',
      status: 'Виконано',
      vehicle: 'Toyota Camry (AA1234BB)',
      vehiclePlate: 'AA1234BB',
      clientName: 'Петренко Іван',
      branchName: 'Центральна',
      branchPhone: '+380441234567',
      estimateLink: 'https://sto.example.com/estimate/tok',
    });
    expect(ctx!.vars.totalAmount?.replace(/\s/g, ' ')).toBe('1 250,00 грн');
  });

  // Документ у валюті, відмінній від базової: «100,00 грн» за 100 USD — неправда клієнту, а
  // «сума ≥ 1000» за 100 USD (≈ 4100 грн) мовчки не спрацювала б.
  // guards: BR-AUT-003, BR-AUT-014
  it('мультивалюта: текст — у валюті документа, умова «сума ≥ X» — за базовою сумою', async () => {
    const { svc, prisma } = service();
    const usd = { currency: { code: 'USD' } };
    (prisma.payment as { findFirst: ReturnType<typeof vi.fn> }).findFirst.mockResolvedValueOnce({
      ...docs.payment,
      amount: 100,
      amountBase: 4100,
      ...usd,
    });
    const pay = await svc.load('org-a', 'PAYMENT', 'doc-1');
    expect(pay!.vars.totalAmount?.replace(/\s/g, ' ')).toBe('100,00 USD');
    expect(pay!.amount).toBe(4100);

    // Базова валюта: сума документа як є (базова сума могла лишитись зі старого курсу).
    (prisma.invoice as { findFirst: ReturnType<typeof vi.fn> }).findFirst.mockResolvedValueOnce({
      ...docs.invoice,
      amount: 1250,
      totalAmountBase: 999,
      currency: { code: 'UAH' },
    });
    const inv = await svc.load('org-a', 'INVOICE', 'doc-1');
    expect(inv!.vars.totalAmount?.replace(/\s/g, ' ')).toBe('1 250,00 грн');
    expect(inv!.amount).toBe(1250);
  });

  // guards: BR-AUT-014
  it('{{status}} — статус ПОДІЇ, а не поточний: документ міг перейти далі до обробки', async () => {
    const { svc } = service();
    const ctx = await svc.load('org-a', 'WORK_ORDER', 'doc-1'); // поточний — «Виконано»
    const at = new Date('2026-10-29T10:00:00.000Z');
    expect(eventVars(ctx!, at, 'IN_PROGRESS').status).toBe('В роботі');
    expect(eventVars(ctx!, at).status).toBe('Виконано');
  });

  // guards: BR-AUT-010, BR-AUT-011
  it('одержувач: контрагент документа зі згодами й бажаним каналом; онлайн-запис — ім’я й телефон заявки', async () => {
    const { svc, prisma } = service();
    const wo = await svc.load('org-a', 'WORK_ORDER', 'doc-1');
    expect(wo!.client).toEqual({
      counterpartyId: 'cp-1',
      name: 'Петренко Іван',
      phone: '+380671112233',
      email: 'ivan@example.com',
      noServiceMessages: false,
      marketingConsent: true,
      preferredChannel: 'TELEGRAM_BOT',
    });
    // Фейк віддає заготовку — тож поле, яке справжня Prisma поверне, перевіряємо в select-і.
    const withClient = [
      ['workOrder', 'WORK_ORDER'],
      ['invoice', 'INVOICE'],
      ['payment', 'PAYMENT'],
    ] as const;
    for (const [model, type] of withClient) {
      const { findFirst } = prisma[model] as { findFirst: ReturnType<typeof vi.fn> };
      await svc.load('org-a', type, 'doc-1');
      const arg = findFirst.mock.calls.at(-1)![0] as {
        select: { counterparty: { select: Record<string, boolean> } };
      };
      expect(arg.select.counterparty.select).toMatchObject({ preferredChannel: true });
    }
    const booking = await svc.load('org-a', 'BOOKING', 'doc-1');
    expect(booking!.client).toMatchObject({
      counterpartyId: null,
      name: 'Олена',
      phone: '+380501112233',
      preferredChannel: null,
    });
    const po = await svc.load('org-a', 'PURCHASE_ORDER', 'doc-1');
    expect(po!.client).toBeNull();
  });

  // guards: BR-AUT-020
  it('«відповідальний»: наряд — виконавці рядків (основні, далі помічники, без повторів); задача — виконавець; решта — автор', async () => {
    const { svc } = service();
    const wo = await svc.load('org-a', 'WORK_ORDER', 'doc-1');
    expect(wo!.responsibleIds).toEqual(['m-1', 'm-2', 'm-3']);
    expect(wo!.responsibleIsAuthor).toBe(false);
    const task = await svc.load('org-a', 'TASK', 'doc-1');
    expect(task!.responsibleIds).toEqual(['m-9']);
    const inv = await svc.load('org-a', 'INVOICE', 'doc-1');
    expect(inv!.responsibleIsAuthor).toBe(true);
    expect(await svc.authorOf('org-a', 'INVOICE', 'doc-1')).toBe('author-1');
  });

  // guards: BR-AUT-052
  it('документ читається в межах організації; немає документа — null', async () => {
    const { svc, prisma } = service(false);
    expect(await svc.load('org-a', 'INVOICE', 'doc-1')).toBeNull();
    const call = (prisma.invoice as { findFirst: ReturnType<typeof vi.fn> }).findFirst.mock
      .calls[0]![0];
    expect(call.where).toMatchObject({ id: 'doc-1', orgId: 'org-a', deletedAt: null });
  });

  // guards: BR-AUT-003
  it('переліки @sto/shared — у паритеті з Prisma-enum-ами (статуси кожного документа, канали, ролі)', () => {
    const keys = (o: object) => Object.keys(o).sort();
    const vals = (o: object) => Object.values(o).map(String).sort();
    expect(keys(AUTOMATION_STATUS_LABELS.WORK_ORDER)).toEqual(vals(WorkOrderStatus));
    expect(keys(AUTOMATION_STATUS_LABELS.INVOICE)).toEqual(vals(InvoiceStatus));
    expect(keys(AUTOMATION_STATUS_LABELS.PURCHASE_ORDER)).toEqual(vals(PurchaseOrderStatus));
    expect(keys(AUTOMATION_STATUS_LABELS.STOCK_DOCUMENT)).toEqual(vals(StockDocumentStatus));
    expect(keys(AUTOMATION_STATUS_LABELS.SUPPLIER_PAYMENT)).toEqual(vals(SupplierPaymentStatus));
    expect(keys(AUTOMATION_STATUS_LABELS.SUPPLIER_RETURN)).toEqual(vals(SupplierReturnStatus));
    expect(keys(AUTOMATION_STATUS_LABELS.TASK)).toEqual(vals(TaskStatus));
    expect([...AUTOMATION_CHANNELS].sort()).toEqual(vals(NotificationChannel));
    expect([...AUTOMATION_MESSAGE_KINDS].sort()).toEqual(vals(AutomationMessageKind));
    expect([...AUTOMATION_PRIORITIES].sort()).toEqual(vals(WorkOrderPriority));
    expect([...AUTOMATION_REPAIR_CATEGORIES].sort()).toEqual(vals(RepairCategory));
    expect([...AUTOMATION_RECIPIENT_ROLES].sort()).toEqual(
      vals(UserRole).filter(r => r !== 'CLIENT'),
    );
  });
});
