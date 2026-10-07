import { Test } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type {
  WorkOrderTransitionedEvent} from '../work-orders/events/work-order.events';
import {
  WORK_ORDER_EVENTS
} from '../work-orders/events/work-order.events';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CompletionActStatus } from '@prisma/client';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { CompletionActsService } from './completion-acts.service';
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
});
