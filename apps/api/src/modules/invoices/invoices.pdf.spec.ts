/**
 * InvoicesService.generatePdf — друкований рахунок із реквізитами організації.
 *
 * Аспект: шапка рахунку й блок «Реквізити для оплати» будуються з реквізитів СВОЄЇ організації
 * (`OrgPrintInfoService.get(orgId)`: назва, ЄДРПОУ, ІПН, телефон, e-mail, логотип, основний
 * банківський рахунок) — передаються в PdfService без змін. Видалений/чужий рахунок → 404, PDF
 * не будується. Сам вигляд блоку оплати — `pdf/pdf.org-header.spec.ts`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { makeInvoicesHarness, ORG, INV_ID, type InvoicesHarness } from './invoices.spec-fixture';

const ORG_INFO = {
  name: 'СТО Альфа',
  edrpou: '12345678',
  ipn: '123456789012',
  phone: '+380501112233',
  email: 'info@alfa.ua',
  bank: { iban: 'UA213223130000026007233566001', bankName: 'АТ «Банк»', mfo: '322313' },
  logo: null,
};

const invoiceRow = {
  number: 'РАХ-2026-000001',
  documentDate: new Date('2026-10-01T00:00:00Z'),
  dueDate: null,
  totalWithoutVat: 500,
  totalVat: 100,
  totalWithVat: 600,
  counterparty: {
    firstName: null,
    lastName: null,
    companyName: 'ТОВ Бета',
    phone: null,
    edrpou: '87654321',
  },
  lines: [],
};

describe('InvoicesService.generatePdf — реквізити організації в рахунку', () => {
  let h: InvoicesHarness;

  beforeEach(async () => {
    h = await makeInvoicesHarness();
    h.orgPrintInfo.get.mockResolvedValue(ORG_INFO);
    h.pdf.generateInvoicePdf.mockResolvedValue(Buffer.from('%PDF'));
  });

  it('реквізити СВОЄЇ організації (з банківським рахунком) ідуть у PdfService без змін', async () => {
    h.prisma.invoice.findFirst.mockResolvedValue(invoiceRow);

    await h.service.generatePdf(ORG, INV_ID);

    expect(h.orgPrintInfo.get).toHaveBeenCalledWith(ORG);
    const arg = h.pdf.generateInvoicePdf.mock.calls[0]?.[0] as { org: unknown; number: string };
    expect(arg.org).toEqual(ORG_INFO);
    expect(arg.number).toBe('РАХ-2026-000001');
  });

  it('рахунок видалений або чужий → 404, PDF не будується', async () => {
    h.prisma.invoice.findFirst.mockResolvedValue(null);

    await expect(h.service.generatePdf(ORG, INV_ID)).rejects.toThrow(NotFoundException);
    expect(h.prisma.invoice.findFirst.mock.calls[0]?.[0]).toMatchObject({
      where: { id: INV_ID, orgId: ORG, deletedAt: null },
    });
    expect(h.pdf.generateInvoicePdf).not.toHaveBeenCalled();
  });

  it('дата друкованого рахунку — дата документа (documentDate), а не дата створення запису', async () => {
    h.prisma.invoice.findFirst.mockResolvedValue(invoiceRow);

    await h.service.generatePdf(ORG, INV_ID);

    const select = (h.prisma.invoice.findFirst.mock.calls[0]?.[0] as { select: object }).select;
    expect(select).toMatchObject({ documentDate: true });
    expect(select).not.toHaveProperty('createdAt');
    const arg = h.pdf.generateInvoicePdf.mock.calls[0]?.[0] as { date: Date };
    expect(arg.date).toEqual(new Date('2026-10-01T00:00:00Z'));
  });

  // Bug #865: рахунок у USD друкувався «Разом: … грн» — валюта рахунку в PDF не йшла.
  it('валюта рахунку (код) іде в PDF разом із сумами', async () => {
    h.prisma.invoice.findFirst.mockResolvedValue({ ...invoiceRow, currency: { code: 'USD' } });

    await h.service.generatePdf(ORG, INV_ID);

    const select = (h.prisma.invoice.findFirst.mock.calls[0]?.[0] as { select: object }).select;
    expect(select).toMatchObject({ currency: { select: { code: true } } });
    const arg = h.pdf.generateInvoicePdf.mock.calls[0]?.[0] as { currencyCode?: string };
    expect(arg.currencyCode).toBe('USD');
  });
});
