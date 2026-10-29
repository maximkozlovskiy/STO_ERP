import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { ReportsService } from './reports.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { matchesWhere } from '../calendar/calendar.spec-fixture';

/**
 * BR-RPT-036 — «ПДВ»: зобов'язання — Σ totalVat рахунків SENT / PARTIALLY_PAID / PAID / OVERDUE за
 * `documentDate` (DRAFT ще не виставлено, CANCELLED анульовано); податковий кредит — Σ totalVat
 * замовлень постачальникам PARTIAL / RECEIVED за `documentDate` (DRAFT / ORDERED ще не отримано);
 * різниця > 0 — до сплати, < 0 — до відшкодування.
 *
 * Сховища рахунків і замовлень ВИКОНУЮТЬ `where` (`matchesWhere`) і сумують `totalVat` відібраних —
 * тест бачить сам відбір, а не форму аргументів.
 * Mutation-verify (2026-10-29): додати 'DRAFT' до статусів рахунків → падають усі три; прибрати
 * 'PARTIAL' зі статусів замовлень → падає «кредит»; прибрати `deletedAt: null` у рахунків → падають
 * усі три; прибрати `orgId` у замовлень → падає «кредит»; `net = purchases − invoiced` → падають
 * «кредит» і «різниця».
 */

type Row = Record<string, unknown>;
const ORG = 'org-1';
const IN = new Date('2026-10-15T00:00:00.000Z');
const OUT = new Date('2026-09-30T00:00:00.000Z');

const doc = (status: string, totalVat: number, over: Row = {}): Row => ({
  orgId: ORG,
  deletedAt: null,
  documentDate: IN,
  status,
  totalVat,
  ...over,
});

const INVOICES: Row[] = [
  doc('DRAFT', 1),
  doc('SENT', 10),
  doc('PARTIALLY_PAID', 20),
  doc('PAID', 40),
  doc('OVERDUE', 80),
  doc('CANCELLED', 2),
  doc('PAID', 4, { deletedAt: new Date('2026-10-16T00:00:00Z') }),
  doc('PAID', 8, { orgId: 'org-2' }),
  doc('PAID', 16, { documentDate: OUT }),
];

const PURCHASES: Row[] = [
  doc('DRAFT', 1),
  doc('ORDERED', 2),
  doc('PARTIAL', 30),
  doc('RECEIVED', 60),
  doc('CANCELLED', 4),
  doc('RECEIVED', 8, { deletedAt: new Date('2026-10-16T00:00:00Z') }),
  doc('RECEIVED', 16, { orgId: 'org-2' }),
];

const aggregateOver =
  (rows: () => Row[]) =>
  ({ where }: { where: Row }) =>
    Promise.resolve({
      _sum: {
        totalVat: rows()
          .filter(r => matchesWhere(r, where))
          .reduce((s, r) => s + Number(r.totalVat), 0),
      },
    });

describe('ReportsService.vatReport — відбір і знак (BR-RPT-036)', () => {
  let service: ReportsService;
  let invoices: Row[];
  let purchases: Row[];

  beforeEach(async () => {
    invoices = INVOICES;
    purchases = PURCHASES;
    const prisma = {
      invoice: { aggregate: vi.fn(aggregateOver(() => invoices)) },
      purchaseOrder: { aggregate: vi.fn(aggregateOver(() => purchases)) },
    };
    const module = await Test.createTestingModule({
      providers: [
        ReportsService,
        { provide: PrismaService, useValue: prisma },
        { provide: SettingsService, useValue: { getOrganisationSettings: vi.fn() } },
      ],
    }).compile();
    service = module.get(ReportsService);
  });

  // guards: BR-RPT-036
  it("зобов'язання — виставлені рахунки періоду (SENT, PARTIALLY_PAID, PAID, OVERDUE)", async () => {
    const r = await service.vatReport(ORG, '2026-10-01', '2026-10-31');
    expect(r.invoiced).toBe(150);
  });

  // guards: BR-RPT-036
  it('податковий кредит — отримані закупівлі періоду (PARTIAL, RECEIVED)', async () => {
    const r = await service.vatReport(ORG, '2026-10-01', '2026-10-31');
    expect(r.purchases).toBe(90);
    expect(r.net).toBe(60);
  });

  // guards: BR-RPT-036
  it('різниця < 0 — до відшкодування (від’ємне net), > 0 — до сплати', async () => {
    purchases = [doc('RECEIVED', 200)];
    const refund = await service.vatReport(ORG, '2026-10-01', '2026-10-31');
    expect(refund.net).toBe(-50);
    invoices = [doc('SENT', 10)];
    purchases = [];
    const pay = await service.vatReport(ORG, '2026-10-01', '2026-10-31');
    expect(pay.net).toBe(10);
  });
});
