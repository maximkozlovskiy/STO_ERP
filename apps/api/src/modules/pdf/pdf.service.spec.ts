import { describe, it, expect, beforeAll, vi } from 'vitest';
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
      org: { name: 'СТО Альфа', edrpou: '12345678' },
      counterparty: { name: 'ТОВ Бета', phone: '+380501112233', edrpou: '87654321' },
      number: 'INV-2026-0001',
      date: new Date('2026-05-26T10:00:00Z'),
      dueDate: new Date('2026-06-09T10:00:00Z'),
      lines: [
        {
          description: 'Заміна масла',
          quantity: 1,
          unit: 'шт',
          unitPrice: 500,
          vatRate: 20,
          total: 600,
        },
      ],
      subtotal: 500,
      vatTotal: 100,
      grandTotal: 600,
    });

    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(1000);
    expect(buf.slice(0, 4).toString('ascii')).toBe('%PDF');
  }, 15_000);

  it('generateWorkOrderPdf returns a non-empty PDF Buffer with Cyrillic content', async () => {
    const buf = await service.generateWorkOrderPdf({
      org: { name: 'СТО Альфа' },
      counterparty: { name: 'Іван Петренко', phone: '+380501112233' },
      vehicleLabel: 'Toyota Camry (AA1234BB)',
      number: 'WO-2026-0001',
      date: new Date('2026-05-26T10:00:00Z'),
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
      org: { name: 'СТО Альфа' },
      counterparty: { name: 'Клієнт' },
      vehicleLabel: 'Авто',
      number: 'WO-2026-EMPTY',
      date: new Date(),
      works: [],
      parts: [],
      total: 0,
    });
    expect(buf.length).toBeGreaterThan(500);
  }, 15_000);

  // Bug #269: null-safety smoke — counterparty з усіма optional полями = null/undefined,
  // org з пустим edrpou, empty invoice без рядків. Перевіряє що pdfmake не падає на NULL.
  it('Bug #269: handles minimal Invoice data (empty lines, null edrpou, empty counterparty fields)', async () => {
    const buf = await service.generateInvoicePdf({
      org: { name: 'СТО', edrpou: null },
      counterparty: { name: '', phone: null, edrpou: null },
      number: 'INV-EMPTY-001',
      date: new Date('2026-05-31T00:00:00Z'),
      dueDate: null,
      lines: [],
      subtotal: 0,
      vatTotal: 0,
      grandTotal: 0,
    });
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(500);
    expect(buf.slice(0, 4).toString('ascii')).toBe('%PDF');
  }, 15_000);

  // Bug #269: WO with all-null counterparty + vehicle fields — pdf must still render.
  it('Bug #269: handles WorkOrder with empty counterparty/vehicleLabel without crashing', async () => {
    const buf = await service.generateWorkOrderPdf({
      org: { name: 'СТО' },
      counterparty: { name: '', phone: null },
      vehicleLabel: '',
      number: 'WO-EMPTY-001',
      date: new Date('2026-05-31T00:00:00Z'),
      works: [],
      parts: [],
      total: 0,
    });
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(500);
  }, 15_000);

  // Мультивалюта Фаза 4 (sync-fix): generateReconciliationActPdf раніше мав ЛОКАЛЬНИЙ
  // txTypeLabel-дубль без SUPPLIER_*/FX_GAIN/FX_LOSS → курсова різниця друкувалась як сирий
  // enum. Тепер мітка йде з shared SETTLEMENT_TX_TYPE_LABELS — смоук перевіряє, що FX-рядок
  // у акті звірки не валить генерацію (і що імпорт з @sto/shared резолвиться у Nest-рантаймі).
  it('generateReconciliationActPdf renders FX_GAIN/FX_LOSS rows without crashing', async () => {
    const buf = await service.generateReconciliationActPdf({
      org: { name: 'СТО Альфа' },
      counterpartyName: 'Іван Петренко',
      periodFrom: new Date('2026-09-01T00:00:00Z'),
      periodTo: new Date('2026-09-14T00:00:00Z'),
      openingBalance: 0,
      closingBalance: 0,
      transactions: [
        {
          date: new Date('2026-09-05T10:00:00Z'),
          type: 'CHARGE',
          amount: 1000,
          document: 'Рахунок № РФ-000001',
        },
        {
          date: new Date('2026-09-10T10:00:00Z'),
          type: 'FX_LOSS',
          amount: 15.5,
          document: 'Рахунок № РФ-000001',
        },
        {
          date: new Date('2026-09-11T10:00:00Z'),
          type: 'FX_GAIN',
          amount: 3.2,
          document: 'Рахунок № РФ-000001',
        },
      ],
    });
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(500);
    expect(buf.slice(0, 4).toString('ascii')).toBe('%PDF');
  }, 15_000);
  // Шапка документа несе зображення: pdfmake не має тягнути з мережі нічого, а з диска — нічого,
  // крім шрифтів. Інакше рядок, що потрапив у `image`, став би запитом на URL чи читанням файла.
  it('зображення за URL не завантажується — документ не будується', async () => {
    const build = (service as unknown as { buildBuffer(d: object): Promise<Buffer> }).buildBuffer;
    await expect(
      build.call(service, {
        // Через словник images — саме його pdfmake завантажує як URL перед рендером.
        images: { logo: 'http://127.0.0.1:9/logo.png' },
        content: [{ image: 'logo' }],
        defaultStyle: { font: 'Roboto' },
      }),
    ).rejects.toThrow(/denied|access policy/i);
  }, 15_000);

  it('зображення з локального файла (не шрифт) не читається — документ не будується', async () => {
    const build = (service as unknown as { buildBuffer(d: object): Promise<Buffer> }).buildBuffer;
    await expect(
      build.call(service, {
        content: [{ image: __filename }],
        defaultStyle: { font: 'Roboto' },
      }),
    ).rejects.toThrow(/denied|access policy/i);
  }, 15_000);
  // Знаку «₴» у вбудованому Roboto немає — суми друкувались із порожнім квадратом замість валюти.
  it('суми в PDF — «1 250,00 грн», без знаку ₴, якого немає у шрифті', () => {
    const fmt = (service as unknown as { fmtMoney(n: number): string }).fmtMoney(1250);
    expect(fmt.replace(/\s/gu, ' ')).toBe('1 250,00 грн');
    expect(fmt).not.toContain('₴');
  });

  /** docDefinition, який іде в pdfmake: шпигун пропускає виклик далі, PDF будується справжній. */
  const docOf = async (generate: () => Promise<Buffer>): Promise<string> => {
    const internals = service as unknown as { buildBuffer(d: unknown): Promise<Buffer> };
    const spy = vi.spyOn(internals, 'buildBuffer');
    try {
      await generate();
      return JSON.stringify(spy.mock.calls[0]![0]);
    } finally {
      spy.mockRestore();
    }
  };

  const usdInvoice = (currencyCode?: string) =>
    service.generateInvoicePdf({
      org: { name: 'СТО Альфа' },
      counterparty: { name: 'ТОВ Бета' },
      number: 'РАХ-1',
      date: new Date('2026-10-15T00:00:00Z'),
      lines: [
        { description: 'Олива', quantity: 0.25, unit: 'л', unitPrice: 40, vatRate: 0, total: 10 },
      ],
      subtotal: 10,
      vatTotal: 0,
      grandTotal: 10,
      currencyCode,
    });

  // Bug #865: рахунок у USD друкувався «Разом: 10,00 грн».
  it('документ в іншій валюті — суми з кодом валюти, без «грн»', async () => {
    const invoice = await docOf(() => usdInvoice('USD'));
    expect(invoice).toContain('10,00 USD');
    expect(invoice).toContain('40,00 USD');
    expect(invoice).not.toContain('грн');

    const order = await docOf(() =>
      service.generateWorkOrderPdf({
        org: { name: 'СТО Альфа' },
        counterparty: { name: 'Клієнт' },
        vehicleLabel: '',
        number: 'НЗ-1',
        date: new Date('2026-10-15T00:00:00Z'),
        works: [{ name: 'Діагностика', quantity: 1, price: 50, total: 50 }],
        parts: [{ name: 'Фільтр', quantity: 1, price: 20, total: 20 }],
        total: 84,
        totalNet: 70,
        vatTotal: 14,
        currencyCode: 'EUR',
      }),
    );
    expect(order).toContain('84,00 EUR');
    expect(order).toContain('20,00 EUR');
    expect(order).not.toContain('грн');

    const act = await docOf(() =>
      service.generateCompletionActPdf({
        org: { name: 'СТО Альфа' },
        counterparty: { name: 'Клієнт' },
        vehicleLabel: '',
        number: 'АКТ-1',
        date: new Date('2026-10-15T00:00:00Z'),
        lines: [{ description: 'Діагностика', quantity: 1, unitPrice: 50, amount: 50 }],
        total: 50,
        currencyCode: 'USD',
      }),
    );
    expect(act).toContain('50,00 USD');
    expect(act).not.toContain('грн');
  }, 15_000);

  it('гривня або валюту не передано — «грн»', async () => {
    for (const code of ['UAH', undefined]) {
      const doc = await docOf(() => usdInvoice(code));
      expect(doc).toContain('10,00 грн');
      expect(doc).not.toMatch(/UAH|USD/);
    }
  }, 15_000);

  // Bug #866: кількість і години — «0,25», а не «0.25».
  it('кількість у рядку — український формат з комою', async () => {
    const doc = await docOf(() => usdInvoice());
    expect(doc).toContain('"0,25"');
    expect(doc).not.toContain('"0.25"');
  }, 15_000);
});
