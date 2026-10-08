/**
 * InvoicesService — дефолти створення рахунку: номер і тип
 *
 * Аспект: що сервіс САМ підставляє у новий рахунок, не покладаючись ні на клієнта,
 * ні на дефолт колонки в БД.
 *
 *   BR-INV-001 — номер береться з DocumentNumberService.next(orgId, 'INVOICE')
 *                (create / createFromWorkOrder / clone), а не збирається у сервісі.
 *   BR-INV-003 — invoiceType ставиться явно 'STANDARD'. Prisma-колонка має
 *                @default("INVOICE") — значення ПОЗА UI-enum; якщо сервіс промовчить,
 *                web-форма впаде на zodResolver при редагуванні такого рахунку.
 *
 * Сетап — `makeInvoicesHarness()` з `./invoices.spec-fixture`.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  makeInvoicesHarness,
  ORG,
  WO_ID,
  INV_ID,
  type InvoicesHarness,
} from './invoices.spec-fixture';

describe('InvoicesService — create-defaults', () => {
  let service: InvoicesHarness['service'];
  let prisma: InvoicesHarness['prisma'];
  let docNumbers: InvoicesHarness['docNumbers'];

  const CP = '44444444-4444-4444-8444-444444444444';
  // Навмисно НЕ дефолт фікстури ('INV-2026-0001'): якби сервіс зібрав номер сам,
  // випадковий збіг із дефолтом сховав би це.
  const ISSUED_NUMBER = 'РАХ-000777';

  /** create-мок віддає рядок, зібраний із того, що сервіс РЕАЛЬНО передав у data. */
  const echoCreate = (extra: Record<string, unknown>) => {
    prisma.invoice.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({
        id: INV_ID,
        orgId: ORG,
        status: 'DRAFT',
        notes: null,
        dueDate: null,
        deletedAt: null,
        totalWithoutVat: 0,
        totalVat: 0,
        totalWithVat: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
        counterparty: { firstName: null, lastName: null, companyName: 'ТОВ' },
        workOrder: null,
        ...extra,
        ...data,
      }),
    );
  };

  const createData = () => prisma.invoice.create.mock.calls[0][0].data as Record<string, unknown>;

  const arrangeCreate = () => {
    prisma.counterparty.findFirst.mockResolvedValue({ id: CP });
    echoCreate({ counterpartyId: CP, workOrderId: null });
  };

  const arrangeCreateFromWorkOrder = () => {
    prisma.workOrder.findFirst.mockResolvedValue({
      id: WO_ID,
      status: 'COMPLETED',
      counterpartyId: CP,
      currencyId: null,
      // Наряд читається ще раз у транзакції (BR-INV-002): тотали й рядки, що з ними сходяться.
      totalNet: 500,
      totalAmount: 500,
      lines: [{ workId: 'w-1', price: 500, normoHours: 1, actualHours: null, work: null }],
      parts: [],
    });
    // pre-check і re-check всередині tx: активного рахунку на наряд немає.
    prisma.invoice.findFirst.mockResolvedValue(null);
    echoCreate({ counterpartyId: CP, workOrderId: WO_ID });
    // Після запису рядків сервіс перечитує рахунок — віддаємо те, що «створив» create.
    (prisma.invoice as unknown as { findFirstOrThrow: ReturnType<typeof vi.fn> }).findFirstOrThrow =
      vi.fn(() => prisma.invoice.create.mock.results[0]?.value as Promise<unknown>);
  };

  beforeEach(async () => {
    ({ service, prisma, docNumbers } = await makeInvoicesHarness());
    docNumbers.next.mockResolvedValue(ISSUED_NUMBER);
  });

  describe('номер документа — лише з DocumentNumberService', () => {
    // guards: BR-INV-001
    it('create: number = DocumentNumberService.next(orgId, "INVOICE"), без змін', async () => {
      arrangeCreate();

      const dto = await service.create(ORG, { counterpartyId: CP, amount: 100 } as never);

      expect(docNumbers.next).toHaveBeenCalledTimes(1);
      expect(docNumbers.next).toHaveBeenCalledWith(ORG, 'INVOICE');
      expect(createData().number).toBe(ISSUED_NUMBER);
      expect(dto.number).toBe(ISSUED_NUMBER);
    });

    // guards: BR-INV-001
    it('createFromWorkOrder: number = DocumentNumberService.next(orgId, "INVOICE"), без змін', async () => {
      arrangeCreateFromWorkOrder();

      await service.createFromWorkOrder(ORG, WO_ID);

      expect(docNumbers.next).toHaveBeenCalledTimes(1);
      expect(docNumbers.next).toHaveBeenCalledWith(ORG, 'INVOICE');
      expect(createData().number).toBe(ISSUED_NUMBER);
    });

    // guards: BR-INV-001
    it('clone: клон отримує НОВИЙ номер із лічильника, а не номер оригіналу', async () => {
      prisma.invoice.findFirst.mockResolvedValue({
        id: INV_ID,
        orgId: ORG,
        number: 'РАХ-000001',
        status: 'SENT',
        counterpartyId: CP,
        workOrderId: null,
        amount: 300,
        currencyId: null,
        dueDate: null,
        notes: null,
        lines: [],
      });
      prisma.counterparty.findFirst.mockResolvedValue({ id: CP });
      echoCreate({ counterpartyId: CP, workOrderId: null, invoiceType: 'STANDARD' });

      await service.clone(ORG, INV_ID);

      expect(docNumbers.next).toHaveBeenCalledTimes(1);
      expect(docNumbers.next).toHaveBeenCalledWith(ORG, 'INVOICE');
      expect(createData().number).toBe(ISSUED_NUMBER);
    });
  });

  describe('invoiceType — явно STANDARD, а не дефолт колонки', () => {
    // guards: BR-INV-003
    it('create без invoiceType у DTO → у БД іде "STANDARD" (не undefined → Prisma-дефолт "INVOICE")', async () => {
      arrangeCreate();

      await service.create(ORG, { counterpartyId: CP, amount: 100 } as never);

      expect(createData().invoiceType).toBe('STANDARD');
    });

    // guards: BR-INV-003
    it('createFromWorkOrder → у БД іде "STANDARD" (найчастіший шлях створення рахунку)', async () => {
      arrangeCreateFromWorkOrder();

      await service.createFromWorkOrder(ORG, WO_ID);

      expect(createData().invoiceType).toBe('STANDARD');
    });
  });
});
