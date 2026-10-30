/**
 * Відкладене повідомлення правила (docs/objects/automation.md, BR-AUT-016): тихі години ставлять
 * повідомлення клієнту в чергу `sms` з паузою до ранку. На мить відправки `SmsProcessor` перевіряє,
 * чи воно ще доречне: документ видалено — не надсилати; повідомлення про «створено» оплати, а оплату
 * сторновано — не надсилати; «створено» оплати / повернення постачальнику, а чернетку скасовано —
 * не надсилати; у журналі SKIPPED із причиною. Звичайна зміна статусу не скасовує.
 *
 * Таблиці документів — у пам'яті з виконанням `where` (memoryTable): зниклий `orgId` чи
 * `deletedAt` у перевірці ламає тест, а не проходить мовчки.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Queue } from 'bullmq';
import type { AutomationDocumentType, AutomationEventKind } from '@prisma/client';
import { memoryTable } from '../cash/cash.spec-fixture';
import { SmsProcessor } from '../notifications/sms.processor';
import type { TelegramRecipientsService } from '../notifications/telegram-recipients.service';
import type { NotificationLogMeta } from '../notifications/notifications.service';
import type { NotificationProviderRegistry } from '../notifications/providers/provider-registry';
import type { DeadLetterService } from '../dead-letter/dead-letter.service';
import type { PrismaService } from '../../prisma/prisma.service';

const ORG = 'org-a';
const DOC = 'doc-1';
type Row = Record<string, unknown>;

/** Модель Prisma кожного типу документа з `deletedAt` (оплата клієнта — append-only, окремо). */
const SOFT_DELETE_TABLES: [AutomationDocumentType, string][] = [
  ['WORK_ORDER', 'workOrder'],
  ['INVOICE', 'invoice'],
  ['PURCHASE_ORDER', 'purchaseOrder'],
  ['STOCK_DOCUMENT', 'stockDocument'],
  ['SUPPLIER_PAYMENT', 'supplierPayment'],
  ['SUPPLIER_RETURN', 'supplierReturn'],
  ['BOOKING', 'bookingRequest'],
  ['TASK', 'task'],
];

function harness(tables: Record<string, Row[]> = {}) {
  const send = vi.fn().mockResolvedValue({ accepted: true, providerMessageId: 'p-1' });
  const logs: Row[] = [];
  const prisma: Record<string, unknown> = {
    notificationLog: memoryTable(logs),
    notificationChannelConfig: memoryTable([
      { orgId: ORG, branchId: 'br-1', channel: 'VIBER', apiKey: 'k', deletedAt: null },
      { orgId: ORG, branchId: 'br-1', channel: 'SMS', apiKey: 'k', deletedAt: null },
    ]),
    branchSettings: memoryTable([]),
    payment: memoryTable(tables.payment ?? []),
  };
  for (const [, table] of SOFT_DELETE_TABLES) prisma[table] = memoryTable(tables[table] ?? []);
  const queueAdd = vi.fn().mockResolvedValue({});
  const processor = new SmsProcessor(
    { get: vi.fn().mockReturnValue({ send }) } as unknown as NotificationProviderRegistry,
    prisma as unknown as PrismaService,
    { add: queueAdd } as unknown as Queue,
    { capture: vi.fn() } as unknown as DeadLetterService,
    {} as TelegramRecipientsService,
  );
  const step = (channel: string) => ({
    channel,
    provider: 'turbosms',
    senderName: 'STO',
    message: 'Дякуємо! Оплату отримано',
    recipient: '+380671112233',
  });
  const process = (meta: NotificationLogMeta | undefined) =>
    processor.process({
      data: {
        orgId: ORG,
        branchId: 'br-1',
        meta,
        // Зашита подія (старий формат job-а) — без meta, але з eventType.
        ...(meta ? {} : { event: 'WO_COMPLETED' }),
        chain: [step('VIBER'), step('SMS')],
        chainIndex: 0,
      },
      attemptsMade: 0,
    } as unknown as Parameters<SmsProcessor['process']>[0]);
  return { send, logs, queueAdd, process };
}

const meta = (
  documentType: AutomationDocumentType,
  eventKind: AutomationEventKind,
  over: Partial<NotificationLogMeta> = {},
): NotificationLogMeta => ({
  ruleId: 'rule-1',
  documentType,
  documentId: DOC,
  eventKind,
  ...over,
});

const payment = (over: Row = {}): Row => ({ id: DOC, orgId: ORG, reversedAt: null, ...over });

describe('Відкладене повідомлення правила — доречність на мить відправки', () => {
  // guards: BR-AUT-016
  it('«оплату створено», а до ранку оплату сторновано — не надсилається, SKIPPED PAYMENT_REVERSED', async () => {
    const h = harness({ payment: [payment({ reversedAt: new Date() })] });
    await h.process(meta('PAYMENT', 'CREATED'));
    expect(h.send).not.toHaveBeenCalled();
    expect(h.queueAdd).not.toHaveBeenCalled(); // ланцюг далі (SMS) не йде
    expect(h.logs).toEqual([
      expect.objectContaining({
        status: 'SKIPPED',
        skipReason: 'PAYMENT_REVERSED',
        ruleId: 'rule-1',
        documentType: 'PAYMENT',
        documentId: DOC,
        channel: 'VIBER',
      }),
    ]);
  });

  // guards: BR-AUT-016
  it('оплата діє — надсилається; повідомлення про САМЕ сторно (статус змінено) — теж', async () => {
    const live = harness({ payment: [payment()] });
    await live.process(meta('PAYMENT', 'CREATED'));
    expect(live.send).toHaveBeenCalledTimes(1);
    expect(live.logs[0]).toMatchObject({ status: 'SENT' });

    const reversalNotice = harness({ payment: [payment({ reversedAt: new Date() })] });
    await reversalNotice.process(meta('PAYMENT', 'STATUS_CHANGED'));
    expect(reversalNotice.send).toHaveBeenCalledTimes(1);
  });

  // guards: BR-AUT-016
  it('оплату постачальнику створено, а її сторновано — PAYMENT_REVERSED; проведена — надсилається', async () => {
    const row = (status: string): Row => ({ id: DOC, orgId: ORG, status, deletedAt: null });
    const reversed = harness({ supplierPayment: [row('REVERSED')] });
    await reversed.process(meta('SUPPLIER_PAYMENT', 'CREATED'));
    expect(reversed.send).not.toHaveBeenCalled();
    expect(reversed.logs[0]).toMatchObject({ status: 'SKIPPED', skipReason: 'PAYMENT_REVERSED' });

    const confirmed = harness({ supplierPayment: [row('CONFIRMED')] });
    await confirmed.process(meta('SUPPLIER_PAYMENT', 'CREATED'));
    expect(confirmed.send).toHaveBeenCalledTimes(1);
  });

  // Рішення власника 2026-10-30: скасована чернетка оплати постачальнику = сторно — «не надсилати».
  // Повернення постачальнику має той самий DRAFT → CANCELLED, тож і для нього так само.
  // guards: BR-AUT-016
  it.each([
    ['SUPPLIER_PAYMENT', 'supplierPayment'],
    ['SUPPLIER_RETURN', 'supplierReturn'],
  ] as const)(
    '%s створено, а чернетку скасовано до відправки — не надсилається, SKIPPED DOCUMENT_CANCELLED',
    async (type, table) => {
      const h = harness({
        [table]: [{ id: DOC, orgId: ORG, status: 'CANCELLED', deletedAt: null }],
      });
      await h.process(meta(type, 'CREATED'));
      expect(h.send).not.toHaveBeenCalled();
      expect(h.queueAdd).not.toHaveBeenCalled(); // ланцюг далі (SMS) не йде
      expect(h.logs).toEqual([
        expect.objectContaining({
          status: 'SKIPPED',
          skipReason: 'DOCUMENT_CANCELLED',
          documentType: type,
          documentId: DOC,
          channel: 'VIBER',
        }),
      ]);
    },
  );

  // guards: BR-AUT-016
  it('повідомлення про САМЕ скасування (зміна статусу) і «створено» проведеного повернення — надсилаються', async () => {
    const row = (status: string): Row => ({ id: DOC, orgId: ORG, status, deletedAt: null });
    const cancelNotice = harness({ supplierPayment: [row('CANCELLED')] });
    await cancelNotice.process(meta('SUPPLIER_PAYMENT', 'STATUS_CHANGED'));
    expect(cancelNotice.send).toHaveBeenCalledTimes(1);

    const returnCancelNotice = harness({ supplierReturn: [row('CANCELLED')] });
    await returnCancelNotice.process(meta('SUPPLIER_RETURN', 'STATUS_CHANGED'));
    expect(returnCancelNotice.send).toHaveBeenCalledTimes(1);

    const confirmedReturn = harness({ supplierReturn: [row('CONFIRMED')] });
    await confirmedReturn.process(meta('SUPPLIER_RETURN', 'CREATED'));
    expect(confirmedReturn.send).toHaveBeenCalledTimes(1);
    expect(confirmedReturn.logs[0]).toMatchObject({ status: 'SENT' });
  });

  // guards: BR-AUT-016
  it.each(SOFT_DELETE_TABLES)(
    '%s видалено до відправки — не надсилається, SKIPPED DOCUMENT_DELETED',
    async (type, table) => {
      const h = harness({ [table]: [{ id: DOC, orgId: ORG, deletedAt: new Date() }] });
      await h.process(meta(type, 'STATUS_CHANGED'));
      expect(h.send).not.toHaveBeenCalled();
      expect(h.logs).toEqual([
        expect.objectContaining({ status: 'SKIPPED', skipReason: 'DOCUMENT_DELETED' }),
      ]);
    },
  );

  // Наряд «Виконано» о 23:00, вранці клієнт оплатив — наряд PAID; «Виконано» лишається правдою.
  // guards: BR-AUT-016
  it('звичайна зміна статусу не скасовує: наряд пішов далі (PAID) — повідомлення йде', async () => {
    const h = harness({
      workOrder: [{ id: DOC, orgId: ORG, status: 'PAID', deletedAt: null }],
    });
    await h.process(meta('WORK_ORDER', 'STATUS_CHANGED'));
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.logs[0]).toMatchObject({ status: 'SENT' });
  });

  // guards: BR-AUT-016, BR-AUT-052
  it('документ з тим самим id у ЧУЖІЙ організації — для нашої його немає: не надсилається', async () => {
    const h = harness({ payment: [payment({ orgId: 'org-b' })] });
    await h.process(meta('PAYMENT', 'CREATED'));
    expect(h.send).not.toHaveBeenCalled();
    expect(h.logs[0]).toMatchObject({ skipReason: 'DOCUMENT_DELETED', orgId: ORG });
  });

  // guards: BR-AUT-016, BR-AUT-051
  it('тест правила і зашита подія без документа — без перевірки документа', async () => {
    const test = harness({ payment: [payment({ reversedAt: new Date() })] });
    await test.process(meta('PAYMENT', 'CREATED', { isTest: true }));
    expect(test.send).toHaveBeenCalledTimes(1);

    const legacy = harness();
    await legacy.process(undefined);
    expect(legacy.send).toHaveBeenCalledTimes(1);
  });
});
