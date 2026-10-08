/**
 * PdfService — підсумок наряду й акта (BR-WO-007)
 *
 * Аспект: клієнт бачить у друкованому наряді й акті ту саму суму, що в його боргу. Коли в сумі
 * є ПДВ (передано `vatTotal > 0` і `totalNet`) — три рядки «Сума без ПДВ / ПДВ / Разом»;
 * інакше — один рядок «Разом». Перевіряється сам вузол pdfmake (`documentTotal`) і те, що обидва
 * документи будують підсумок саме ним, зі своїми сумами.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { PdfService } from './pdf.service';

type TotalInput = { total: number; totalNet?: number; vatTotal?: number };
type Internals = {
  documentTotal(data: TotalInput): unknown;
  fmtMoney(value: number): string;
};

/** Усі `text` вузла pdfmake в порядку обходу — підписи й суми підсумку. */
function texts(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(texts);
  if (node && typeof node === 'object') {
    const o = node as Record<string, unknown>;
    const own = typeof o.text === 'string' && o.text !== '' ? [o.text] : [];
    return [...own, ...texts(o.columns), ...texts(o.stack)];
  }
  return [];
}

describe('PdfService — підсумок наряду й акта з ПДВ (BR-WO-007)', () => {
  let service: PdfService;
  let internals: Internals;

  beforeAll(() => {
    service = new PdfService();
    internals = service as unknown as Internals;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // guards: BR-WO-007
  it('vatTotal > 0 → три рядки: «Сума без ПДВ» = totalNet, «ПДВ» = vatTotal, «Разом» = сума до сплати', () => {
    const out = texts(internals.documentTotal({ total: 840, totalNet: 700, vatTotal: 140 }));

    expect(out).toEqual([
      'Сума без ПДВ:',
      internals.fmtMoney(700),
      'ПДВ:',
      internals.fmtMoney(140),
      'Разом:',
      internals.fmtMoney(840),
    ]);
  });

  // guards: BR-WO-007
  it('ПДВ немає (vatTotal не передано) → один рядок «Разом» із сумою, без рядків про ПДВ', () => {
    const out = texts(internals.documentTotal({ total: 700 }));

    expect(out).toEqual([`Разом: ${internals.fmtMoney(700)}`]);
  });

  // guards: BR-WO-007
  it('vatTotal = 0 (наряд без ПДВ, totalNet = total) → теж один рядок «Разом»', () => {
    const out = texts(internals.documentTotal({ total: 700, totalNet: 700, vatTotal: 0 }));

    expect(out).toEqual([`Разом: ${internals.fmtMoney(700)}`]);
    expect(out.join(' ')).not.toContain('ПДВ');
  });

  // guards: BR-WO-007
  it('друкований наряд будує підсумок із total / totalNet / vatTotal наряду', async () => {
    const spy = vi.spyOn(internals, 'documentTotal');

    const buf = await service.generateWorkOrderPdf({
      org: { name: 'СТО Альфа' },
      counterparty: { name: 'Іван Петренко', phone: '+380501112233' },
      vehicleLabel: 'Toyota Camry (AA1234BB)',
      number: 'WO-2026-0001',
      date: new Date('2026-05-26T10:00:00Z'),
      works: [{ name: 'Заміна масла', quantity: 2, price: 100, total: 200 }],
      parts: [{ name: 'Фільтр масляний', quantity: 1, price: 500, total: 500 }],
      total: 840,
      totalNet: 700,
      vatTotal: 140,
    });

    expect(buf.slice(0, 4).toString('ascii')).toBe('%PDF');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toMatchObject({ total: 840, totalNet: 700, vatTotal: 140 });
    expect(texts(spy.mock.results[0]?.value)).toContain('Сума без ПДВ:');
  }, 15_000);

  // guards: BR-WO-007
  it('друкований акт будує підсумок із total / totalNet / vatTotal акта', async () => {
    const spy = vi.spyOn(internals, 'documentTotal');

    const buf = await service.generateCompletionActPdf({
      org: { name: 'СТО Альфа' },
      counterparty: { name: 'Іван Петренко', phone: '+380501112233' },
      vehicleLabel: 'Toyota Camry (AA1234BB)',
      number: 'АКТ-2026-0001',
      date: new Date('2026-05-26T10:00:00Z'),
      lines: [{ description: 'Заміна масла', quantity: 2, unitPrice: 100, amount: 200 }],
      total: 240,
      totalNet: 200,
      vatTotal: 40,
    });

    expect(buf.slice(0, 4).toString('ascii')).toBe('%PDF');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toMatchObject({ total: 240, totalNet: 200, vatTotal: 40 });
    expect(texts(spy.mock.results[0]?.value)).toEqual([
      'Сума без ПДВ:',
      internals.fmtMoney(200),
      'ПДВ:',
      internals.fmtMoney(40),
      'Разом:',
      internals.fmtMoney(240),
    ]);
  }, 15_000);

  // guards: BR-WO-007
  it('акт без ПДВ → один рядок «Разом»', async () => {
    const spy = vi.spyOn(internals, 'documentTotal');

    await service.generateCompletionActPdf({
      org: { name: 'СТО Альфа' },
      counterparty: { name: 'Іван Петренко' },
      vehicleLabel: '',
      number: 'АКТ-2026-0002',
      date: new Date('2026-05-26T10:00:00Z'),
      lines: [{ description: 'Заміна масла', quantity: 2, unitPrice: 100, amount: 200 }],
      total: 200,
    });

    expect(texts(spy.mock.results[0]?.value)).toEqual([`Разом: ${internals.fmtMoney(200)}`]);
  }, 15_000);
});
