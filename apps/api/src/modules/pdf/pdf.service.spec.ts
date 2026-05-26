import { describe, it, expect, beforeAll } from 'vitest';
import { PdfService } from './pdf.service';

// Smoke tests for PdfService. The point of these tests is to detect future regressions in the
// pdfmake font-wiring (Bug #68): if Roboto descriptors are missing or wired with Buffers, the
// constructor throws or `getBuffer()` rejects with the URLResolver "toLowerCase" crash. Both
// modes are exercised here, end-to-end against the real pdfmake instance.

describe('PdfService — pdfmake integration', () => {
  let service: PdfService;

  beforeAll(() => {
    // The constructor itself does the dangerous part (setFonts). If pdfmake/fonts/Roboto is
    // missing this throws synchronously and the test fails before any PDF is generated.
    service = new PdfService();
  });

  it('generateInvoicePdf returns a non-empty PDF Buffer starting with %PDF magic', async () => {
    const buf = await service.generateInvoicePdf({
      org:           { name: 'СТО Альфа', edrpou: '12345678' },
      counterparty:  { name: 'ТОВ Бета', phone: '+380501112233', edrpou: '87654321' },
      number:        'INV-2026-0001',
      date:          new Date('2026-05-26T10:00:00Z'),
      dueDate:       new Date('2026-06-09T10:00:00Z'),
      lines: [
        { description: 'Заміна масла', quantity: 1, unit: 'шт', unitPrice: 500, vatRate: 20, total: 600 },
      ],
      subtotal:   500,
      vatTotal:   100,
      grandTotal: 600,
    });

    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(1000);
    expect(buf.slice(0, 4).toString('ascii')).toBe('%PDF');
  }, 15_000);

  it('generateWorkOrderPdf returns a non-empty PDF Buffer with Cyrillic content', async () => {
    const buf = await service.generateWorkOrderPdf({
      org:          { name: 'СТО Альфа' },
      counterparty: { name: 'Іван Петренко', phone: '+380501112233' },
      vehicleLabel: 'Toyota Camry (AA1234BB)',
      number:       'WO-2026-0001',
      date:         new Date('2026-05-26T10:00:00Z'),
      works: [{ name: 'Заміна масла', quantity: 1, price: 500, total: 500 }],
      parts: [{ name: 'Фільтр масляний', quantity: 1, price: 200, total: 200 }],
      total: 700,
    });

    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(1000);
    expect(buf.slice(0, 4).toString('ascii')).toBe('%PDF');
  }, 15_000);

  it('handles empty works/parts arrays gracefully', async () => {
    const buf = await service.generateWorkOrderPdf({
      org:          { name: 'СТО Альфа' },
      counterparty: { name: 'Клієнт' },
      vehicleLabel: 'Авто',
      number:       'WO-2026-EMPTY',
      date:         new Date(),
      works: [],
      parts: [],
      total: 0,
    });
    expect(buf.length).toBeGreaterThan(500);
  }, 15_000);
});
