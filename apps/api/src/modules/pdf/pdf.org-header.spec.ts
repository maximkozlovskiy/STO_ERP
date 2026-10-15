/**
 * PdfService — шапка друкованого документа з логотипом і реквізитами, блок «Реквізити для
 * оплати» рахунку і таблиці наряд-замовлення (BR-WO-013).
 *
 * Перевіряється docDefinition, який іде в pdfmake (шпигун на `buildBuffer` пропускає виклик далі,
 * тож PDF будується справжній), — текст стиснутого PDF-буфера напряму не читається.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { PdfService, type OrgPrintInfo } from './pdf.service';

const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
// Правильна сигнатура PNG, далі сміття: OrgPrintInfoService такий файл пропустить, pdfmake — ні.
const BROKEN_PNG_DATA_URL = `data:image/png;base64,${Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('not really a png'),
]).toString('base64')}`;

const FULL_ORG: OrgPrintInfo = {
  name: 'СТО Альфа',
  edrpou: '12345678',
  ipn: '123456789012',
  address: 'м. Київ, вул. Фактична, 2',
  phone: '+380501112233',
  email: 'info@alfa.ua',
  bank: { iban: 'UA213223130000026007233566001', bankName: 'АТ «Банк»', mfo: '322313' },
  logo: PNG_DATA_URL,
};

type DocDef = { content: unknown[]; images?: Record<string, string> };
type Internals = { buildBuffer(docDef: DocDef): Promise<Buffer> };

/** Усі текстові вузли pdfmake в порядку обходу. */
function texts(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(texts);
  if (node && typeof node === 'object') {
    const o = node as Record<string, unknown>;
    const own = typeof o.text === 'string' && o.text !== '' ? [o.text] : [];
    const table = (o.table as { body?: unknown } | undefined)?.body;
    return [...own, ...texts(o.columns), ...texts(o.stack), ...texts(table)];
  }
  return typeof node === 'string' && node !== '' ? [node] : [];
}

/** Вузли з `image` у шапці (перший елемент content). */
function headerImages(doc: DocDef): unknown[] {
  const header = doc.content[0] as { columns: Array<Record<string, unknown>> };
  return header.columns.filter(c => 'image' in c).map(c => c.image);
}

const invoiceData = (org: OrgPrintInfo) => ({
  org,
  counterparty: { name: 'ТОВ Бета', edrpou: '87654321' },
  number: 'РАХ-2026-000001',
  date: new Date('2026-10-15T10:00:00Z'),
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

const workOrderData = (org: OrgPrintInfo) => ({
  org,
  counterparty: { name: 'Іван Петренко', phone: '+380671112233' },
  vehicleLabel: 'Toyota Corolla AA1234BB',
  vin: 'JTDBR32E720123456',
  mileage: 123456,
  number: 'НЗ-2026-000001',
  date: new Date('2026-10-14T00:00:00Z'),
  works: [
    {
      name: 'Заміна масла',
      quantity: 1.5,
      normoHours: 1,
      actualHours: 1.5,
      price: 100,
      total: 150,
    },
    {
      name: 'Діагностика',
      quantity: 0.5,
      normoHours: 0.5,
      actualHours: null,
      price: 100,
      total: 50,
    },
  ],
  parts: [{ name: 'Масло 5W-30', quantity: 4, unit: 'л', price: 300, total: 1200 }],
  total: 1400,
});

describe('PdfService — шапка з логотипом і реквізитами', () => {
  let service: PdfService;
  let internals: Internals;

  beforeAll(() => {
    service = new PdfService();
    internals = service as unknown as Internals;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const capture = () => {
    const spy = vi.spyOn(internals, 'buildBuffer');
    return () => spy.mock.calls.map(c => c[0]);
  };

  it('з логотипом: зображення в images під ключем, у шапці — посилання на ключ, PDF будується', async () => {
    const docs = capture();

    const buf = await service.generateWorkOrderPdf(workOrderData(FULL_ORG));

    expect(buf.subarray(0, 4).toString('ascii')).toBe('%PDF');
    const [doc] = docs();
    expect(Object.values(doc!.images ?? {})).toEqual([PNG_DATA_URL]);
    // У вузол шапки йде КЛЮЧ, а не сам рядок: довільний рядок у `image` pdfmake читав би як
    // шлях до файла чи URL.
    expect(headerImages(doc!)).toEqual(Object.keys(doc!.images ?? {}));
  }, 15_000);

  it('без логотипа: ні images, ні зображення в шапці; PDF будується', async () => {
    const docs = capture();

    const buf = await service.generateWorkOrderPdf(workOrderData({ ...FULL_ORG, logo: null }));

    expect(buf.subarray(0, 4).toString('ascii')).toBe('%PDF');
    const [doc] = docs();
    // pdfmake сам дописує в docDef порожній `images: {}` — рахуємо ключі.
    expect(Object.keys(doc!.images ?? {})).toEqual([]);
    expect(headerImages(doc!)).toEqual([]);
  }, 15_000);

  it('пошкоджений логотип (pdfmake його не приймає) → документ будується вдруге без логотипа', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const docs = capture();

    const buf = await service.generateInvoicePdf(
      invoiceData({ ...FULL_ORG, logo: BROKEN_PNG_DATA_URL }),
    );

    expect(buf.subarray(0, 4).toString('ascii')).toBe('%PDF');
    const calls = docs();
    expect(calls).toHaveLength(2);
    expect(headerImages(calls[1]!)).toEqual([]);
    expect(Object.keys(calls[1]!.images ?? {})).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  }, 15_000);

  it('шапка несе назву, ЄДРПОУ, ІПН, адресу, телефон, e-mail, IBAN, банк і МФО', async () => {
    const docs = capture();

    await service.generateWorkOrderPdf(workOrderData(FULL_ORG));

    const header = texts(docs()[0]!.content[0]);
    expect(header[0]).toBe('СТО Альфа');
    const joined = header.join('\n');
    expect(joined).toContain('ЄДРПОУ: 12345678');
    expect(joined).toContain('ІПН: 123456789012');
    expect(joined).toContain('м. Київ, вул. Фактична, 2');
    expect(joined).toContain('Тел.: +380501112233');
    expect(joined).toContain('E-mail: info@alfa.ua');
    expect(joined).toContain('IBAN: UA213223130000026007233566001');
    expect(joined).toContain('Банк: АТ «Банк»');
    expect(joined).toContain('МФО: 322313');
    expect(header[header.length - 1]).toBe('Наряд-замовлення № НЗ-2026-000001');
  }, 15_000);

  it('незаповнені реквізити не друкуються порожніми підписами', async () => {
    const docs = capture();

    await service.generateWorkOrderPdf(workOrderData({ name: 'СТО Мінімум' }));

    const header = texts(docs()[0]!.content[0]).join('\n');
    expect(header).not.toMatch(/ЄДРПОУ|ІПН|Тел\.|E-mail|IBAN|Банк|МФО/);
  }, 15_000);

  it.each([
    ['рахунок', (s: PdfService, o: OrgPrintInfo) => s.generateInvoicePdf(invoiceData(o))],
    [
      'акт виконаних робіт',
      (s: PdfService, o: OrgPrintInfo) =>
        s.generateCompletionActPdf({
          org: o,
          counterparty: { name: 'Клієнт' },
          vehicleLabel: '',
          number: 'АКТ-1',
          date: new Date('2026-10-15T00:00:00Z'),
          lines: [],
          total: 0,
        }),
    ],
    [
      'акт звірки',
      (s: PdfService, o: OrgPrintInfo) =>
        s.generateReconciliationActPdf({
          org: o,
          counterpartyName: 'Клієнт',
          periodFrom: new Date('2026-09-01T00:00:00Z'),
          periodTo: new Date('2026-09-30T00:00:00Z'),
          openingBalance: 0,
          closingBalance: 0,
          transactions: [],
        }),
    ],
  ])(
    '%s має ту саму шапку: логотип і реквізити',
    async (_label, generate) => {
      const docs = capture();

      await generate(service, FULL_ORG);

      const [doc] = docs();
      expect(headerImages(doc!)).toHaveLength(1);
      const header = texts(doc!.content[0]).join('\n');
      expect(header).toContain('ІПН: 123456789012');
      expect(header).toContain('IBAN: UA213223130000026007233566001');
    },
    15_000,
  );
});

describe('PdfService — рахунок: «Реквізити для оплати»', () => {
  let service: PdfService;
  let internals: Internals;

  beforeAll(() => {
    service = new PdfService();
    internals = service as unknown as Internals;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Текст блоку оплати (від заголовка до кінця його стека) або null. */
  async function paymentBlock(org: OrgPrintInfo): Promise<string[] | null> {
    const spy = vi.spyOn(internals, 'buildBuffer');
    await service.generateInvoicePdf(invoiceData(org));
    const content = (spy.mock.calls[0]![0] as DocDef).content;
    const block = content.find(n => texts(n)[0] === 'Реквізити для оплати:');
    return block ? texts(block) : null;
  }

  it('основний рахунок задано → блок з одержувачем, ЄДРПОУ, IBAN, банком і МФО', async () => {
    expect(await paymentBlock(FULL_ORG)).toEqual([
      'Реквізити для оплати:',
      'Одержувач: СТО Альфа',
      'ЄДРПОУ: 12345678',
      'IBAN: UA213223130000026007233566001',
      'Банк: АТ «Банк»',
      'МФО: 322313',
    ]);
  }, 15_000);

  it('ЄДРПОУ одержувача на рахунку має пріоритет над ЄДРПОУ організації', async () => {
    const block = await paymentBlock({
      ...FULL_ORG,
      bank: { iban: 'UA213223130000026007233566001', edrpou: '87654321' },
    });
    expect(block).toContain('ЄДРПОУ: 87654321');
    expect(block).not.toContain('Банк: АТ «Банк»');
  }, 15_000);

  it('основний рахунок не задано → блоку немає', async () => {
    expect(await paymentBlock({ ...FULL_ORG, bank: null })).toBeNull();
  }, 15_000);
});

describe('PdfService — наряд-замовлення: роботи й товари (BR-WO-013)', () => {
  let service: PdfService;
  let internals: Internals;

  beforeAll(() => {
    service = new PdfService();
    internals = service as unknown as Internals;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function doc() {
    const spy = vi.spyOn(internals, 'buildBuffer');
    await service.generateWorkOrderPdf(workOrderData({ name: 'СТО Альфа' }));
    return spy.mock.calls[0]![0] as DocDef;
  }

  // guards: BR-WO-013
  it('роботи: назва, норма й факт годин окремо (без факту — «—»), ціна, сума', async () => {
    const all = texts((await doc()).content);
    const start = all.indexOf('Роботи:');
    expect(all.slice(start, start + 16)).toEqual([
      'Роботи:',
      'Найменування',
      'Норма, год',
      'Факт, год',
      'Ціна',
      'Сума',
      'Заміна масла',
      '1',
      '1.5',
      expect.stringContaining('100,00'),
      expect.stringContaining('150,00'),
      'Діагностика',
      '0.5',
      '—',
      expect.stringContaining('100,00'),
      expect.stringContaining('50,00'),
    ]);
  }, 15_000);

  // guards: BR-WO-013
  it('товари: назва, кількість, одиниця, ціна, сума', async () => {
    const all = texts((await doc()).content);
    const start = all.indexOf('Товари:');
    expect(all.slice(start, start + 11)).toEqual([
      'Товари:',
      'Найменування',
      'Кіл.',
      'Од.',
      'Ціна',
      'Сума',
      'Масло 5W-30',
      '4',
      'л',
      expect.stringContaining('300,00'),
      expect.stringContaining('200,00'),
    ]);
  }, 15_000);

  // guards: BR-WO-013
  it('авто: марка, модель, номер, VIN і пробіг; дата — передана дата документа', async () => {
    const all = texts((await doc()).content);
    expect(all).toContain(
      'Автомобіль: Toyota Corolla AA1234BB, VIN: JTDBR32E720123456, пробіг: 123456 км',
    );
    expect(all).toContain('Дата: 14.10.2026');
  }, 15_000);
});
