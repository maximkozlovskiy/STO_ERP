/**
 * Друкований наряд-замовлення (BR-WO-013).
 *
 * Аспект: `GET /work-orders/:id/pdf` друкує наряд-замовлення лише в статусах «Виконано»,
 * «Виставлено», «Оплачено», «Архів» (`WO_INVOICE_VISIBLE_STATUSES`); до того клієнт отримує
 * кошторис, а сервер відповідає 400. Видалений наряд → 404 (BR-WO-012). Дата — дата документа
 * наряду, шапка — реквізити організації з `OrgPrintInfoService`. Маршрут пускає OWNER, ADMIN,
 * RECEPTIONIST, MECHANIC і ACCOUNTANT.
 *
 * `PdfService` і `OrgPrintInfoService` — заглушки: перевіряємо, що сервіс їм передав.
 */
import { describe, it, expect, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { WorkOrderStatus } from '@prisma/client';
import { WO_INVOICE_VISIBLE_STATUSES, translateError } from '@sto/shared';
import { WorkOrdersService } from './work-orders.service';
import { WorkOrdersController } from './work-orders.controller';
import { ROLES_KEY } from '../../auth/decorators/roles.decorator';
import type { PrismaService } from '../../prisma/prisma.service';
import type { OrgPrintInfo } from '../pdf/pdf.service';

const ORG = '11111111-1111-4111-8111-111111111111';
const WO_ID = '22222222-2222-4222-8222-222222222222';

const ORG_INFO: OrgPrintInfo = {
  name: 'СТО Альфа',
  edrpou: '12345678',
  ipn: '123456789012',
  phone: '+380501112233',
  email: 'info@alfa.ua',
  bank: { iban: 'UA213223130000026007233566001', bankName: 'АТ «Банк»', mfo: '322313' },
  logo: 'data:image/png;base64,AAAA',
};

type PdfArg = {
  org: OrgPrintInfo;
  date: Date;
  vin?: string | null;
  mileage?: number | null;
  works: Array<{ normoHours?: number | null; actualHours?: number | null; quantity: number }>;
  parts: Array<{ unit?: string }>;
};

function woRow(status: WorkOrderStatus) {
  return {
    number: 'НЗ-2026-000001',
    status,
    documentDate: new Date('2026-10-14T00:00:00Z'),
    inMileage: 123456,
    totalNet: 700,
    totalAmount: 700,
    vehicle: {
      make: 'Toyota',
      model: 'Corolla',
      licensePlate: 'AA1234BB',
      vin: 'JTDBR32E720123456',
    },
    counterparty: { firstName: 'Іван', lastName: 'Петренко', companyName: null, phone: null },
    lines: [
      { normoHours: 2, actualHours: 1.5, price: 100, amount: 200, work: { name: 'Заміна масла' } },
    ],
    parts: [
      {
        quantity: 4,
        price: 100,
        amount: 400,
        unitOfMeasure: null,
        good: { name: 'Масло', unit: 'шт', unitOfMeasure: { shortName: 'л' } },
      },
    ],
  };
}

function setup(row: ReturnType<typeof woRow> | null) {
  const woFindFirst = vi.fn().mockResolvedValue(row);
  const generateWorkOrderPdf = vi.fn().mockResolvedValue(Buffer.from('%PDF'));
  const orgPrintInfoGet = vi.fn().mockResolvedValue(ORG_INFO);
  const service = new WorkOrdersService(
    { workOrder: { findFirst: woFindFirst } } as unknown as PrismaService,
    null as never, // stockEffects
    null as never, // docNumbers
    { generateWorkOrderPdf } as never, // pdf
    null as never, // audit
    null as never, // settingsService
    null as never, // exchangeRates
    null as never, // events
    null as never, // totals
    { get: orgPrintInfoGet } as never, // orgPrintInfo
  );
  const pdfArg = () => generateWorkOrderPdf.mock.calls[0]?.[0] as PdfArg;
  return { service, woFindFirst, generateWorkOrderPdf, orgPrintInfoGet, pdfArg };
}

const ALLOWED = ['COMPLETED', 'INVOICED', 'PAID', 'ARCHIVED'] as const;
// Усі інші статуси enum — новий статус потрапить сюди сам і стане забороненим за замовчуванням.
const FORBIDDEN = Object.values(WorkOrderStatus).filter(
  s => !(ALLOWED as readonly string[]).includes(s),
);

describe('WorkOrdersService.generatePdf — наряд-замовлення лише від «Виконано» (BR-WO-013)', () => {
  // guards: BR-WO-013
  it('ворота — саме WO_INVOICE_VISIBLE_STATUSES: «Виконано», «Виставлено», «Оплачено», «Архів»', () => {
    expect([...WO_INVOICE_VISIBLE_STATUSES].sort()).toEqual([...ALLOWED].sort());
    expect(FORBIDDEN.length).toBeGreaterThan(0);
  });

  // guards: BR-WO-013
  it.each(ALLOWED)('%s → PDF будується', async status => {
    const { service, generateWorkOrderPdf } = setup(woRow(status));

    await expect(service.generatePdf(ORG, WO_ID)).resolves.toEqual(Buffer.from('%PDF'));
    expect(generateWorkOrderPdf).toHaveBeenCalledTimes(1);
  });

  // guards: BR-WO-013
  it.each(FORBIDDEN)(
    '%s → 400 «друкується після виконання робіт», PDF не будується',
    async status => {
      const { service, generateWorkOrderPdf } = setup(woRow(status));

      const err = await service.generatePdf(ORG, WO_ID).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).message).toBe(
        translateError('err.workOrder.printBeforeCompletion', 'uk'),
      );
      expect(generateWorkOrderPdf).not.toHaveBeenCalled();
    },
  );

  // guards: BR-WO-013
  it('текст відмови — український: «Наряд-замовлення друкується після виконання робіт»', () => {
    expect(translateError('err.workOrder.printBeforeCompletion', 'uk')).toBe(
      'Наряд-замовлення друкується після виконання робіт',
    );
  });

  // guards: BR-WO-013
  it('видалений або чужий наряд → 404 (запит лише своєї org і не видаленого), PDF не будується', async () => {
    const { service, woFindFirst, generateWorkOrderPdf } = setup(null);

    await expect(service.generatePdf(ORG, WO_ID)).rejects.toThrow(NotFoundException);
    expect(woFindFirst.mock.calls[0]?.[0]).toMatchObject({
      where: { id: WO_ID, orgId: ORG, deletedAt: null },
    });
    expect(generateWorkOrderPdf).not.toHaveBeenCalled();
  });
});

describe('WorkOrdersService.generatePdf — зміст наряд-замовлення (BR-WO-013)', () => {
  // guards: BR-WO-013
  it('дата документа — documentDate наряду, а не дата створення запису', async () => {
    const { service, woFindFirst, pdfArg } = setup(woRow('COMPLETED'));

    await service.generatePdf(ORG, WO_ID);

    const select = (woFindFirst.mock.calls[0]?.[0] as { select: Record<string, unknown> }).select;
    expect(select).toMatchObject({ documentDate: true, status: true });
    expect(select).not.toHaveProperty('createdAt');
    expect(pdfArg().date).toEqual(new Date('2026-10-14T00:00:00Z'));
  });

  // guards: BR-WO-013
  it('шапка — реквізити своєї організації з OrgPrintInfoService, передані без змін', async () => {
    const { service, orgPrintInfoGet, pdfArg } = setup(woRow('INVOICED'));

    await service.generatePdf(ORG, WO_ID);

    expect(orgPrintInfoGet).toHaveBeenCalledWith(ORG);
    expect(pdfArg().org).toEqual(ORG_INFO);
  });

  // guards: BR-WO-013
  it('VIN і пробіг авто; у роботах норма й факт годин окремо; у товарах одиниця виміру', async () => {
    const { service, pdfArg } = setup(woRow('PAID'));

    await service.generatePdf(ORG, WO_ID);

    const arg = pdfArg();
    expect(arg.vin).toBe('JTDBR32E720123456');
    expect(arg.mileage).toBe(123456);
    expect(arg.works[0]).toMatchObject({ normoHours: 2, actualHours: 1.5, quantity: 1.5 });
    expect(arg.parts[0]?.unit).toBe('л');
  });

  // guards: BR-WO-013
  it('одиниця товару: обрана в рядку → базова одиниця товару → unit товару', async () => {
    const row = woRow('ARCHIVED');
    row.parts = [
      { ...row.parts[0]!, unitOfMeasure: { shortName: 'каністра' } as never },
      { ...row.parts[0]!, good: { name: 'Фільтр', unit: 'компл', unitOfMeasure: null as never } },
    ];
    const { service, pdfArg } = setup(row);

    await service.generatePdf(ORG, WO_ID);

    expect(pdfArg().parts.map(p => p.unit)).toEqual(['каністра', 'компл']);
  });
});

describe('WorkOrdersController.downloadPdf — ролі маршруту (BR-WO-013)', () => {
  // guards: BR-WO-013
  it('наряд-замовлення друкують OWNER, ADMIN, RECEPTIONIST, MECHANIC і ACCOUNTANT', () => {
    const roles = Reflect.getMetadata(
      ROLES_KEY,
      WorkOrdersController.prototype.downloadPdf,
    ) as string[];
    expect([...roles].sort()).toEqual(['ACCOUNTANT', 'ADMIN', 'MECHANIC', 'OWNER', 'RECEPTIONIST']);
  });
});
