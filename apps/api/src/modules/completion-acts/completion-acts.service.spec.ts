import { Test } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { WorkOrderTransitionedEvent } from '../work-orders/events/work-order.events';
import { WORK_ORDER_EVENTS } from '../work-orders/events/work-order.events';
import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { CompletionActStatus } from '@prisma/client';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { CompletionActsService } from './completion-acts.service';
import { CompletionActsController } from './completion-acts.controller';
import { PrismaService } from '../../prisma/prisma.service';
import { DocumentNumberService } from '../document-number/document-number.service';
import { InvoicesService } from '../invoices/invoices.service';
import { PdfService } from '../pdf/pdf.service';

// Регресійні гарди для sign(): ідемпотентність CONFIRM-еквіваленту (CAS DRAFT→SIGNED) та
// поведінка auto-invoice ПОЗА транзакцією (best-effort, не роллбечить підписання).
describe('CompletionActsService — sign() idempotency + auto-invoice', () => {
  let service: CompletionActsService;
  let prisma: {
    completionAct: {
      findFirst: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
    };
    workOrder: { update: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> };
    $transaction: ReturnType<typeof vi.fn>;
  };
  let invoices: { createFromWorkOrder: ReturnType<typeof vi.fn> };
  let events: { emit: ReturnType<typeof vi.fn> };

  const ORG = 'org-1';
  const ACT_ID = '11111111-1111-4111-8111-111111111111';
  const WO_ID = '22222222-2222-4222-8222-222222222222';

  // findOne() наприкінці sign() читає act через prisma.completionAct.findFirst.
  const signedActRow = {
    id: ACT_ID,
    orgId: ORG,
    workOrderId: WO_ID,
    number: 'АКТ-2026-0001',
    status: CompletionActStatus.SIGNED,
    signedAt: new Date(),
    signedBy: 'Іван',
    clientPhone: null,
    notes: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    workOrder: {
      number: 'НР-2026-0001',
      counterparty: { firstName: 'Іван', lastName: 'Петренко', companyName: null },
      vehicle: { make: 'Toyota', model: 'Corolla', licensePlate: 'AA1234BB' },
      lines: [],
      parts: [],
    },
  };

  beforeEach(async () => {
    prisma = {
      completionAct: {
        findFirst: vi.fn(),
        update: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      workOrder: {
        update: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: vi.fn().mockImplementation((arg: unknown) => {
        if (Array.isArray(arg)) return Promise.all(arg as Promise<unknown>[]);
        if (typeof arg === 'function') return (arg as (tx: unknown) => Promise<unknown>)(prisma);
        return Promise.resolve(arg);
      }),
    };
    invoices = { createFromWorkOrder: vi.fn().mockResolvedValue({}) };
    events = { emit: vi.fn() };

    const module = await Test.createTestingModule({
      providers: [
        CompletionActsService,
        { provide: PrismaService, useValue: prisma },
        { provide: DocumentNumberService, useValue: { next: vi.fn() } },
        { provide: InvoicesService, useValue: invoices },
        { provide: PdfService, useValue: { generateCompletionActPdf: vi.fn() } },
        { provide: EventEmitter2, useValue: events },
      ],
    }).compile();
    service = module.get(CompletionActsService);
  });

  it('sign(): CAS updateMany where status:DRAFT переводить у SIGNED + WO COMPLETED→INVOICED + auto-invoice', async () => {
    // in-tx guard read
    prisma.completionAct.findFirst.mockResolvedValueOnce({
      status: CompletionActStatus.DRAFT,
      workOrder: { id: WO_ID, status: 'COMPLETED' },
    });
    // findOne у кінці
    prisma.completionAct.findFirst.mockResolvedValueOnce(signedActRow);

    await service.sign(ORG, ACT_ID, { signedBy: 'Іван' } as never);

    expect(prisma.completionAct.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: ACT_ID, orgId: ORG, deletedAt: null, status: CompletionActStatus.DRAFT },
        data: expect.objectContaining({ status: CompletionActStatus.SIGNED, signedBy: 'Іван' }),
      }),
    );
    // WO COMPLETED → INVOICED — через FSM-хелпер: CAS по поточному статусу, не прямий update
    expect(prisma.workOrder.updateMany).toHaveBeenCalledWith({
      where: { id: WO_ID, orgId: ORG, deletedAt: null, status: 'COMPLETED' },
      data: { status: 'INVOICED' },
    });
    expect(prisma.workOrder.update).not.toHaveBeenCalled();
    // auto-invoice викликається ПІСЛЯ tx (не всередині)
    expect(invoices.createFromWorkOrder).toHaveBeenCalledWith(ORG, WO_ID);
  });

  it('sign() (concurrent/retry): CAS count=0 → BadRequestException, WO не оновлено, auto-invoice не викликано', async () => {
    prisma.completionAct.findFirst.mockResolvedValueOnce({
      status: CompletionActStatus.DRAFT, // stale snapshot
      workOrder: { id: WO_ID, status: 'COMPLETED' },
    });
    // Інший concurrent sign уже забрав DRAFT → CAS не знаходить рядок.
    prisma.completionAct.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(service.sign(ORG, ACT_ID, { signedBy: 'Іван' } as never)).rejects.toThrow(
      BadRequestException,
    );
    expect(prisma.workOrder.update).not.toHaveBeenCalled();
    expect(prisma.workOrder.updateMany).not.toHaveBeenCalled();
    expect(invoices.createFromWorkOrder).not.toHaveBeenCalled();
  });

  it('sign(): вже SIGNED → BadRequestException ПЕРЕД CAS', async () => {
    prisma.completionAct.findFirst.mockResolvedValueOnce({
      status: CompletionActStatus.SIGNED,
      workOrder: { id: WO_ID, status: 'INVOICED' },
    });

    await expect(service.sign(ORG, ACT_ID, {} as never)).rejects.toThrow(BadRequestException);
    expect(prisma.completionAct.updateMany).not.toHaveBeenCalled();
    expect(invoices.createFromWorkOrder).not.toHaveBeenCalled();
  });

  it('sign(): акт не знайдено → NotFoundException', async () => {
    prisma.completionAct.findFirst.mockResolvedValueOnce(null);
    await expect(service.sign(ORG, ACT_ID, {} as never)).rejects.toThrow(NotFoundException);
    expect(prisma.completionAct.updateMany).not.toHaveBeenCalled();
  });

  it('sign(): auto-invoice "вже існує активний рахунок" НЕ роллбечить підписання (best-effort ПОЗА tx)', async () => {
    prisma.completionAct.findFirst.mockResolvedValueOnce({
      status: CompletionActStatus.DRAFT,
      workOrder: { id: WO_ID, status: 'COMPLETED' },
    });
    prisma.completionAct.findFirst.mockResolvedValueOnce(signedActRow);
    invoices.createFromWorkOrder.mockRejectedValueOnce(
      new BadRequestException('Для цього наряду вже існує активний рахунок'),
    );

    // Підписання успішне попри збій auto-invoice (проковтнуто).
    const res = await service.sign(ORG, ACT_ID, { signedBy: 'Іван' } as never);
    expect(res.status).toBe(CompletionActStatus.SIGNED);
    expect(prisma.completionAct.updateMany).toHaveBeenCalled();
  });

  it('sign(): WO НЕ у COMPLETED → перехід INVOICED пропускається, підписання відбувається', async () => {
    prisma.completionAct.findFirst.mockResolvedValueOnce({
      status: CompletionActStatus.DRAFT,
      workOrder: { id: WO_ID, status: 'INVOICED' }, // не COMPLETED
    });
    prisma.completionAct.findFirst.mockResolvedValueOnce(signedActRow);

    await service.sign(ORG, ACT_ID, {} as never);

    expect(prisma.completionAct.updateMany).toHaveBeenCalled();
    expect(prisma.workOrder.update).not.toHaveBeenCalled();
    // auto-invoice усе одно намагається (WO існує) — best-effort
    expect(invoices.createFromWorkOrder).toHaveBeenCalledWith(ORG, WO_ID);
  });

  // ── BR-WO-001: статус наряду змінюється лише через FSM ──────────────────────────────

  // guards: BR-WO-001
  it('sign(): наряд скасовано між читанням і записом (CAS по статусу програв) → 400, підписання відкочується, рахунок не створюється', async () => {
    prisma.completionAct.findFirst.mockResolvedValueOnce({
      status: CompletionActStatus.DRAFT,
      workOrder: { id: WO_ID, status: 'COMPLETED' }, // застарілий знімок
    });
    // Конкурентний transition(CANCELLED) уже змінив статус: рядка зі status=COMPLETED немає.
    prisma.workOrder.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(
      service.sign(ORG, ACT_ID, { signedBy: 'Іван' } as never, 'user-1'),
    ).rejects.toThrow(BadRequestException);
    expect(invoices.createFromWorkOrder).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  // guards: BR-WO-001
  it('sign(): перехід COMPLETED→INVOICED дає подію TRANSITIONED з автором — аудит не губиться', async () => {
    prisma.completionAct.findFirst.mockResolvedValueOnce({
      status: CompletionActStatus.DRAFT,
      workOrder: { id: WO_ID, status: 'COMPLETED' },
    });
    prisma.completionAct.findFirst.mockResolvedValueOnce(signedActRow);

    await service.sign(ORG, ACT_ID, { signedBy: 'Іван' } as never, 'user-1');

    expect(events.emit).toHaveBeenCalledTimes(1);
    const [name, event] = events.emit.mock.calls[0] as [string, WorkOrderTransitionedEvent];
    expect(name).toBe(WORK_ORDER_EVENTS.TRANSITIONED);
    expect(event).toMatchObject({
      orgId: ORG,
      workOrderId: WO_ID,
      fromStatus: 'COMPLETED',
      toStatus: 'INVOICED',
      userId: 'user-1',
    });
  });

  // guards: BR-WO-001
  it('sign(): наряд не у COMPLETED → статус не чіпається і подія переходу не емітиться', async () => {
    prisma.completionAct.findFirst.mockResolvedValueOnce({
      status: CompletionActStatus.DRAFT,
      workOrder: { id: WO_ID, status: 'INVOICED' },
    });
    prisma.completionAct.findFirst.mockResolvedValueOnce(signedActRow);

    await service.sign(ORG, ACT_ID, { signedBy: 'Іван' } as never, 'user-1');

    expect(prisma.workOrder.updateMany).not.toHaveBeenCalled();
    expect(prisma.workOrder.update).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  // guards: BR-WO-001
  it('sign() без userId (системний виклик): подія переходу все одно емітиться — гейтить хендлер, не сервіс', async () => {
    prisma.completionAct.findFirst.mockResolvedValueOnce({
      status: CompletionActStatus.DRAFT,
      workOrder: { id: WO_ID, status: 'COMPLETED' },
    });
    prisma.completionAct.findFirst.mockResolvedValueOnce(signedActRow);

    await service.sign(ORG, ACT_ID, {} as never);

    expect(events.emit).toHaveBeenCalledTimes(1);
    const [name, event] = events.emit.mock.calls[0] as [string, WorkOrderTransitionedEvent];
    expect(name).toBe(WORK_ORDER_EVENTS.TRANSITIONED);
    expect(event).toMatchObject({
      workOrderId: WO_ID,
      fromStatus: 'COMPLETED',
      toStatus: 'INVOICED',
    });
    expect(event.userId).toBeUndefined();
  });

  // guards: BR-WO-001
  it('sign(): транзакція не закомітилась → події переходу й авто-рахунку немає (емісія ПІСЛЯ коміту, не всередині)', async () => {
    prisma.completionAct.findFirst.mockResolvedValueOnce({
      status: CompletionActStatus.DRAFT,
      workOrder: { id: WO_ID, status: 'COMPLETED' },
    });
    // Тіло транзакції відпрацювало повністю (обидва CAS успішні), а коміт упав — як при
    // serialization failure / timeout / обриві з'єднання.
    prisma.$transaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => {
      await fn(prisma);
      throw new Error('commit failed');
    });

    await expect(service.sign(ORG, ACT_ID, {} as never, 'user-1')).rejects.toThrow('commit failed');

    expect(prisma.workOrder.updateMany).toHaveBeenCalledTimes(1); // тіло справді дійшло до переходу
    expect(events.emit).not.toHaveBeenCalled();
    expect(invoices.createFromWorkOrder).not.toHaveBeenCalled();
  });

  it('sign(): авто-рахунок упав з довільної причини → підписання і перехід лишаються, подія вже пішла, збій у warn', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    prisma.completionAct.findFirst.mockResolvedValueOnce({
      status: CompletionActStatus.DRAFT,
      workOrder: { id: WO_ID, status: 'COMPLETED' },
    });
    prisma.completionAct.findFirst.mockResolvedValueOnce(signedActRow);
    invoices.createFromWorkOrder.mockRejectedValueOnce(new Error('exchange rate missing'));

    const res = await service.sign(ORG, ACT_ID, {} as never, 'user-1');

    expect(res.status).toBe(CompletionActStatus.SIGNED);
    expect(events.emit).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('exchange rate missing'));
    warn.mockRestore();
  });

  // Bug #795 (рішення власника 2026-10-07): акт скасованого наряду не підписується. Раніше підпис
  // проходив, авто-рахунок відхилявся і ковтався у warn — користувач бачив успіх без рахунку.
  // Скасування наряду саме гасить чернетки актів (work-orders.service.spec); цей кейс — про гонку,
  // коли акт прочитано до скасування.
  // guards: BR-WO-006
  it('sign(): наряд CANCELLED → 400, акт лишається DRAFT, рахунок не створюється', async () => {
    prisma.completionAct.findFirst.mockResolvedValueOnce({
      status: CompletionActStatus.DRAFT,
      workOrder: { id: WO_ID, status: 'CANCELLED' },
    });

    await expect(
      service.sign(ORG, ACT_ID, { signedBy: 'Іван' } as never, 'user-1'),
    ).rejects.toThrow('Наряд скасовано — акт підписати не можна');

    expect(prisma.completionAct.updateMany).not.toHaveBeenCalled();
    expect(prisma.workOrder.updateMany).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
    expect(invoices.createFromWorkOrder).not.toHaveBeenCalled();
  });

  // Наряд, що пішов далі за FSM (оплачений, архівний), акт підписати дозволяє: клієнт часто
  // платить раніше, ніж підписує. Заборона стосується лише скасованого.
  // guards: BR-WO-006
  it.each(['INVOICED', 'PAID', 'ARCHIVED'])('sign(): наряд %s → акт підписується', async status => {
    prisma.completionAct.findFirst.mockResolvedValueOnce({
      status: CompletionActStatus.DRAFT,
      workOrder: { id: WO_ID, status },
    });
    prisma.completionAct.findFirst.mockResolvedValueOnce(signedActRow);

    const res = await service.sign(ORG, ACT_ID, { signedBy: 'Іван' } as never, 'user-1');

    expect(res.status).toBe(CompletionActStatus.SIGNED);
    expect(prisma.workOrder.updateMany).not.toHaveBeenCalled();
  });

  // ── cancel(): підписаний акт не скасовується, зокрема під гонкою з sign() (Bug #793) ──

  it('cancel(): DRAFT → CAS updateMany з предикатом status ≠ SIGNED (не update за id)', async () => {
    prisma.completionAct.findFirst.mockResolvedValueOnce({ status: CompletionActStatus.DRAFT });

    await service.cancel(ORG, ACT_ID);

    expect(prisma.completionAct.updateMany).toHaveBeenCalledWith({
      where: {
        id: ACT_ID,
        orgId: ORG,
        deletedAt: null,
        status: { not: CompletionActStatus.SIGNED },
      },
      data: { status: CompletionActStatus.CANCELLED },
    });
    expect(prisma.completionAct.update).not.toHaveBeenCalled();
  });

  it('cancel(): sign() закомітився між читанням і записом (CAS count=0) → 400, акт не перезаписано', async () => {
    prisma.completionAct.findFirst.mockResolvedValueOnce({ status: CompletionActStatus.DRAFT }); // застарілий знімок
    prisma.completionAct.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(service.cancel(ORG, ACT_ID)).rejects.toThrow(BadRequestException);
    expect(prisma.completionAct.update).not.toHaveBeenCalled();
  });

  it('cancel(): уже SIGNED → 400 ще до запису; не знайдено → 404', async () => {
    prisma.completionAct.findFirst.mockResolvedValueOnce({ status: CompletionActStatus.SIGNED });
    await expect(service.cancel(ORG, ACT_ID)).rejects.toThrow(BadRequestException);

    prisma.completionAct.findFirst.mockResolvedValueOnce(null);
    await expect(service.cancel(ORG, ACT_ID)).rejects.toThrow(NotFoundException);

    expect(prisma.completionAct.updateMany).not.toHaveBeenCalled();
  });
});

// Контролер — єдине місце, де автор підписання потрапляє в сервіс. Без нього перехід наряду
// COMPLETED→INVOICED лишається без запису аудиту (хендлер пропускає події без userId), і жоден
// сервісний тест цього не помітить: вони передають userId самі.
describe('CompletionActsController — sign() передає автора', () => {
  // guards: BR-WO-001
  it('sign(): user.id іде четвертим аргументом у CompletionActsService.sign', async () => {
    const sign = vi.fn().mockResolvedValue({ id: 'act' });
    const controller = new CompletionActsController({ sign } as unknown as CompletionActsService);
    const dto = { signedBy: 'Іван' };

    await controller.sign('org-1', 'act-1', dto as never, { id: 'user-1' });

    expect(sign).toHaveBeenCalledWith('org-1', 'act-1', dto, 'user-1');
  });
});
