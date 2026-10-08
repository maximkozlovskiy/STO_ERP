/**
 * buildInvoiceLinesFromWorkOrder — рядки рахунку з наряду (BR-INV-002), чиста функція
 *
 * Аспект: рахунок із наряду виходить РІВНО на суму наряду. Правило перевіряється на числах,
 * без моків транзакції:
 *   · Σ priceWithVat = wo.totalAmount, Σ priceWithoutVat = wo.totalNet,
 *     Σ vatAmount = wo.totalAmount − wo.totalNet;
 *   · у кожному рядку priceWithoutVat + vatAmount = priceWithVat;
 *   · режим ПДВ рядків визначає НАРЯД (його тотали), а не поточні налаштування;
 *   · копійчану різницю «ПДВ від суми» проти «Σ ПДВ рядків» забирає останній рядок;
 *   · різниця понад копійку на рядок — WorkOrderTotalsMismatchError, а не вирівнювання.
 *
 * Тотали наряду в кейсах рахуються так само, як їх рахує BR-WO-007:
 * `calcVatOnBase(база)` + `splitWorkOrderTotal`.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { VatMode } from '@prisma/client';
import {
  buildInvoiceLinesFromWorkOrder,
  WorkOrderTotalsMismatchError,
  type InvoiceLineDraft,
  type WorkOrderForInvoice,
} from './work-order-invoice-lines';
import { calcVatOnBase, splitWorkOrderTotal } from '../../common/utils/vat';
import { money } from '../../common/utils/money';

type Row = [quantity: number, unitPrice: number];

const NONE = { vatMode: 'NONE' as VatMode, vatRate: 0 };
const EXCL20 = { vatMode: 'EXCLUSIVE' as VatMode, vatRate: 20 };
const INCL20 = { vatMode: 'INCLUSIVE' as VatMode, vatRate: 20 };

/** Наряд із робіт і запчастин; тотали задаються явно — саме їх функція мусить відтворити. */
function wo(
  works: Row[],
  parts: Row[],
  totals: { totalNet: number; totalAmount: number },
): WorkOrderForInvoice {
  return {
    ...totals,
    lines: works.map(([quantity, unitPrice], i) => ({
      workId: `w-${i}`,
      name: `Робота ${i}`,
      quantity,
      unitPrice,
    })),
    parts: parts.map(([quantity, unitPrice], i) => ({
      goodId: `g-${i}`,
      name: `Запчастина ${i}`,
      quantity,
      unitPrice,
    })),
  };
}

/** Тотали наряду так, як їх пише WorkOrderTotalsService.recalc (BR-WO-007). */
function totalsLikeRecalc(works: Row[], parts: Row[], vatMode: VatMode, vatRate: number) {
  let labor = 0;
  for (const [q, p] of works) labor += q * p;
  let partsSum = 0;
  // WorkOrderPart.amount лежить у БД уже округленим — наряд сумує округлені суми запчастин.
  for (const [q, p] of parts) partsSum += money(q * p);
  const base = money(labor + partsSum);
  const vat = calcVatOnBase(base, vatRate, vatMode);
  return splitWorkOrderTotal(base, vat, vatMode);
}

const sum = (lines: InvoiceLineDraft[], key: 'priceWithVat' | 'priceWithoutVat' | 'vatAmount') =>
  money(lines.reduce((acc, l) => acc + l[key], 0));

/** Три рівності BR-INV-002 «сума рядків = сума наряду» + тотожність кожного рядка. */
function expectLinesMatchWorkOrder(lines: InvoiceLineDraft[], source: WorkOrderForInvoice) {
  expect(sum(lines, 'priceWithVat')).toBe(money(source.totalAmount));
  expect(sum(lines, 'priceWithoutVat')).toBe(money(source.totalNet));
  expect(sum(lines, 'vatAmount')).toBe(money(source.totalAmount - source.totalNet));
  for (const l of lines) {
    expect(money(l.priceWithoutVat + l.vatAmount)).toBe(l.priceWithVat);
  }
}

describe('buildInvoiceLinesFromWorkOrder — рядки рахунку з наряду', () => {
  describe('три режими ПДВ: сума рядків = сума наряду', () => {
    // guards: BR-INV-002
    it('без ПДВ: рядки без ПДВ, ставка 0, Σ = сума наряду', () => {
      const source = wo([[2, 100]], [[1, 500]], { totalNet: 700, totalAmount: 700 });

      const lines = buildInvoiceLinesFromWorkOrder(source, NONE);

      expect(lines).toHaveLength(2);
      for (const l of lines) {
        expect(l.vatRate).toBe(0);
        expect(l.vatAmount).toBe(0);
        expect(l.priceWithVat).toBe(l.priceWithoutVat);
      }
      expect(lines.map(l => l.priceWithVat)).toEqual([200, 500]);
      expectLinesMatchWorkOrder(lines, source);
    });

    // guards: BR-INV-002
    it('ПДВ зверху 20%: рядок = сума без ПДВ + ПДВ, Σ з ПДВ = totalAmount наряду', () => {
      const source = wo([[2, 100]], [[1, 500]], { totalNet: 700, totalAmount: 840 });

      const lines = buildInvoiceLinesFromWorkOrder(source, EXCL20);

      expect(lines.map(l => [l.priceWithoutVat, l.vatAmount, l.priceWithVat, l.vatRate])).toEqual([
        [200, 40, 240, 20],
        [500, 100, 600, 20],
      ]);
      expectLinesMatchWorkOrder(lines, source);
    });

    // guards: BR-INV-002
    it('ПДВ у ціні 20%: ПДВ виділено з суми рядка, Σ з ПДВ = сума рядків наряду', () => {
      // 700 з ПДВ у ціні: ПДВ = 116.67, без ПДВ = 583.33.
      const source = wo([[2, 100]], [[1, 500]], { totalNet: 583.33, totalAmount: 700 });

      const lines = buildInvoiceLinesFromWorkOrder(source, INCL20);

      expect(lines.map(l => l.priceWithVat)).toEqual([200, 500]);
      expect(lines.map(l => l.vatRate)).toEqual([20, 20]);
      // Перший рядок рахується сам від себе: 200 − 200/1.2 = 33.33.
      expect(lines[0]).toMatchObject({ priceWithoutVat: 166.67, vatAmount: 33.33 });
      expectLinesMatchWorkOrder(lines, source);
    });
  });

  describe('копійчана різниця — в останній рядок', () => {
    // guards: BR-INV-002
    it('ПДВ зверху: три рядки по 33.33 — ПДВ від суми 20.00, Σ ПДВ рядків 20.01 → копійку знімає останній', () => {
      // Наряд: база 99.99, ПДВ = round(99.99 × 0.2) = 20.00 → до сплати 119.99.
      // Рядки кожен від себе: 33.33 × 0.2 = 6.67 (тричі = 20.01).
      const source = wo(
        [
          [1, 33.33],
          [1, 33.33],
        ],
        [[1, 33.33]],
        { totalNet: 99.99, totalAmount: 119.99 },
      );

      const lines = buildInvoiceLinesFromWorkOrder(source, EXCL20);

      expect(lines.map(l => [l.priceWithoutVat, l.vatAmount, l.priceWithVat])).toEqual([
        [33.33, 6.67, 40],
        [33.33, 6.67, 40],
        [33.33, 6.66, 39.99],
      ]);
      expectLinesMatchWorkOrder(lines, source);
    });

    // guards: BR-INV-002
    it('ПДВ у ціні: різницю і по ПДВ, і по сумі без ПДВ забирає останній рядок, сума з ПДВ не змінюється', () => {
      // 700 з ПДВ у ціні: наряд — ПДВ 116.67 / без ПДВ 583.33; рядки — 33.33 + 83.33 = 116.66.
      const source = wo([[2, 100]], [[1, 500]], { totalNet: 583.33, totalAmount: 700 });

      const lines = buildInvoiceLinesFromWorkOrder(source, INCL20);

      expect(lines[1]).toMatchObject({
        priceWithoutVat: 416.66,
        vatAmount: 83.34,
        priceWithVat: 500,
      });
      expectLinesMatchWorkOrder(lines, source);
    });

    // guards: BR-INV-002
    it('розбіжність рівно копійка на рядок — ще вирівнювання (межа допуску)', () => {
      // Два рядки на 700.00, наряд каже 700.02: по копійці на рядок.
      const source = wo([[2, 100]], [[1, 500]], { totalNet: 700.02, totalAmount: 700.02 });

      const lines = buildInvoiceLinesFromWorkOrder(source, NONE);

      expect(lines.map(l => l.priceWithVat)).toEqual([200, 500.02]);
      expectLinesMatchWorkOrder(lines, source);
    });

    // guards: BR-INV-002
    it("останній рядок нульовий (робота з 0 фактичних годин) → копійку знімає попередній, від'ємних сум немає", () => {
      // Ті самі 3 × 33.33 (Σ ПДВ рядків 20.01 проти 20.00 наряду), але останнім стоїть рядок на
      // 0 годин. Раніше копійку знімали з нього: рядок рахунку виходив [0, -0.01, -0.01].
      const source = wo(
        [
          [1, 33.33],
          [1, 33.33],
          [1, 33.33],
          [0, 500],
        ],
        [],
        { totalNet: 99.99, totalAmount: 119.99 },
      );

      const lines = buildInvoiceLinesFromWorkOrder(source, EXCL20);

      expect(lines.map(l => [l.priceWithoutVat, l.vatAmount, l.priceWithVat])).toEqual([
        [33.33, 6.67, 40],
        [33.33, 6.67, 40],
        [33.33, 6.66, 39.99],
        [0, 0, 0],
      ]);
      expectLinesMatchWorkOrder(lines, source);
    });

    // guards: BR-INV-002
    it("останній рядок замалий для різниці по ПДВ (його ПДВ округлився до 0) → ПДВ не стає від'ємним", () => {
      // Запчастина 0.086 × 0.36 = 0.03, ПДВ 7% від неї = 0.00; наряд рахує ПДВ від суми і
      // виходить на копійку менше за Σ ПДВ рядків. Раніше останній рядок отримував ПДВ -0.01.
      const works: Row[] = [
        [2.56, 2.78],
        [2.78, 3.5],
      ];
      const parts: Row[] = [
        [1.397, 3.38],
        [0.497, 2.6],
        [1.804, 2.18],
        [0.725, 2.31],
        [0.28, 1.28],
        [0.086, 0.36],
      ];
      const source = wo(works, parts, totalsLikeRecalc(works, parts, 'EXCLUSIVE', 7));

      const lines = buildInvoiceLinesFromWorkOrder(source, { vatMode: 'EXCLUSIVE', vatRate: 7 });

      for (const l of lines) {
        expect(l.priceWithoutVat).toBeGreaterThanOrEqual(0);
        expect(l.vatAmount).toBeGreaterThanOrEqual(0);
      }
      expect(lines[lines.length - 1]).toMatchObject({ priceWithoutVat: 0.03, vatAmount: 0 });
      expectLinesMatchWorkOrder(lines, source);
    });
  });

  describe('режим і ставку ПДВ визначає наряд, а не поточні налаштування', () => {
    // guards: BR-INV-002
    it('наряд «старої моделі» (налаштування — ПДВ зверху 20%, але totalNet = totalAmount) → рядки без ПДВ', () => {
      const source = wo([[2, 100]], [[1, 500]], { totalNet: 700, totalAmount: 700 });

      const lines = buildInvoiceLinesFromWorkOrder(source, EXCL20);

      for (const l of lines) {
        expect(l.vatRate).toBe(0);
        expect(l.vatAmount).toBe(0);
        expect(l.priceWithVat).toBe(l.priceWithoutVat);
      }
      // Клієнтові нараховано 700 — рахунок не дорожчає на ставку з налаштувань.
      expect(sum(lines, 'priceWithVat')).toBe(700);
      expectLinesMatchWorkOrder(lines, source);
    });

    // guards: BR-INV-002
    it('ставку змінили після завершення (налаштування 7%, наряд рахований на 20%) → ставка з наряду', () => {
      const source = wo([[2, 100]], [[1, 500]], { totalNet: 700, totalAmount: 840 });

      const lines = buildInvoiceLinesFromWorkOrder(source, { vatMode: 'EXCLUSIVE', vatRate: 7 });

      expect(lines.map(l => [l.vatRate, l.vatAmount, l.priceWithVat])).toEqual([
        [20, 40, 240],
        [20, 100, 600],
      ]);
      expectLinesMatchWorkOrder(lines, source);
    });

    // guards: BR-INV-002
    it('ПДВ в організації вимкнули після завершення наряду з ПДВ → рядки з ПДВ наряду', () => {
      const source = wo([[2, 100]], [[1, 500]], { totalNet: 700, totalAmount: 840 });

      const lines = buildInvoiceLinesFromWorkOrder(source, NONE);

      expect(lines.map(l => l.vatRate)).toEqual([20, 20]);
      expect(sum(lines, 'priceWithVat')).toBe(840);
      expectLinesMatchWorkOrder(lines, source);
    });

    // guards: BR-INV-002
    it('налаштування — ПДВ зверху, а наряд рахований «ПДВ у ціні» → рядки за режимом наряду', () => {
      // Сума рядків 700 = totalAmount наряду (ПДВ у ціні), а не totalNet.
      const source = wo([[2, 100]], [[1, 500]], { totalNet: 583.33, totalAmount: 700 });

      const lines = buildInvoiceLinesFromWorkOrder(source, EXCL20);

      expect(lines.map(l => l.priceWithVat)).toEqual([200, 500]);
      expect(sum(lines, 'vatAmount')).toBe(116.67);
      expectLinesMatchWorkOrder(lines, source);
    });
  });

  describe('тотали наряду не відповідають рядкам → помилка, а не вирівнювання', () => {
    // guards: BR-INV-002
    it('наряд без ПДВ: сума наряду 1000 при рядках на 700 → WorkOrderTotalsMismatchError', () => {
      const source = wo([[2, 100]], [[1, 500]], { totalNet: 1000, totalAmount: 1000 });

      expect(() => buildInvoiceLinesFromWorkOrder(source, NONE)).toThrow(
        WorkOrderTotalsMismatchError,
      );
    });

    // guards: BR-INV-002
    it('наряд із ПДВ: ні сума без ПДВ (650), ні до сплати (780) не збігаються з рядками на 700 → помилка', () => {
      const source = wo([[2, 100]], [[1, 500]], { totalNet: 650, totalAmount: 780 });

      expect(() => buildInvoiceLinesFromWorkOrder(source, EXCL20)).toThrow(
        WorkOrderTotalsMismatchError,
      );
    });

    // guards: BR-INV-002
    it('розбіжність понад копійку на рядок (два рядки, 3 копійки) → помилка', () => {
      const source = wo([[2, 100]], [[1, 500]], { totalNet: 700.03, totalAmount: 700.03 });

      expect(() => buildInvoiceLinesFromWorkOrder(source, NONE)).toThrow(
        WorkOrderTotalsMismatchError,
      );
    });

    // guards: BR-INV-002
    it('порожній наряд із ненульовою сумою → помилка (рахунок на суму без рядків не виставляється)', () => {
      const source = wo([], [], { totalNet: 500, totalAmount: 500 });

      expect(() => buildInvoiceLinesFromWorkOrder(source, NONE)).toThrow(
        WorkOrderTotalsMismatchError,
      );
    });
  });

  describe('перенесення рядків', () => {
    // guards: BR-INV-002
    it('порожній наряд із нульовою сумою → []', () => {
      const source = wo([], [], { totalNet: 0, totalAmount: 0 });

      expect(buildInvoiceLinesFromWorkOrder(source, EXCL20)).toEqual([]);
    });

    // guards: BR-INV-002
    it('порядок: спершу роботи, потім запчастини; sortOrder наскрізний від 0', () => {
      const source = wo(
        [
          [1, 100],
          [1, 200],
        ],
        [
          [1, 300],
          [1, 400],
        ],
        { totalNet: 1000, totalAmount: 1000 },
      );

      const lines = buildInvoiceLinesFromWorkOrder(source, NONE);

      expect(lines.map(l => l.description)).toEqual([
        'Робота 0',
        'Робота 1',
        'Запчастина 0',
        'Запчастина 1',
      ]);
      expect(lines.map(l => l.sortOrder)).toEqual([0, 1, 2, 3]);
      expect(lines.map(l => l.workId ?? null)).toEqual(['w-0', 'w-1', null, null]);
      expect(lines.map(l => l.goodId ?? null)).toEqual([null, null, 'g-0', 'g-1']);
    });

    // guards: BR-INV-002
    it('quantity і unitPrice переносяться як є (не перераховуються з суми рядка)', () => {
      // 2.5 год × 333.33 = 833.325 → 833.33; 3 шт × 0.33 = 0.99.
      const source = wo([[2.5, 333.33]], [[3, 0.33]], { totalNet: 834.32, totalAmount: 834.32 });

      const lines = buildInvoiceLinesFromWorkOrder(source, NONE);

      expect(lines.map(l => [l.quantity, l.unitPrice])).toEqual([
        [2.5, 333.33],
        [3, 0.33],
      ]);
      expect(lines.map(l => l.priceWithVat)).toEqual([833.33, 0.99]);
    });

    // guards: BR-INV-002
    it('рядок без назви роботи/товару все одно отримує непорожній опис', () => {
      const source: WorkOrderForInvoice = {
        totalNet: 300,
        totalAmount: 300,
        lines: [{ workId: null, name: null, quantity: 1, unitPrice: 100 }],
        parts: [{ goodId: null, name: null, quantity: 1, unitPrice: 200 }],
      };

      const lines = buildInvoiceLinesFromWorkOrder(source, NONE);

      expect(lines).toHaveLength(2);
      for (const l of lines) expect(l.description.trim().length).toBeGreaterThan(0);
    });
  });

  describe('інваріант (property-based)', () => {
    // Ціни — у копійках; години/кількість — із двома знаками, як у формах наряду.
    const price = fc.integer({ min: 100, max: 5_000_000 }).map(c => c / 100);
    const qty = fc.integer({ min: 1, max: 5_000 }).map(c => c / 100);
    const row = fc.tuple(qty, price);
    const mode = fc.constantFrom<VatMode>('NONE', 'EXCLUSIVE', 'INCLUSIVE');
    const rate = fc.constantFrom(7, 14, 20);

    // guards: BR-INV-002
    it('для тоталів, порахованих як у наряді, Σ рядків рахунку = тотали наряду в усіх режимах', () => {
      fc.assert(
        fc.property(
          fc.array(row, { minLength: 0, maxLength: 12 }),
          fc.array(row, { minLength: 0, maxLength: 12 }),
          mode,
          rate,
          (works, parts, vatMode, vatRate) => {
            fc.pre(works.length + parts.length > 0);
            const settingsRate = vatMode === 'NONE' ? 0 : vatRate;
            const totals = totalsLikeRecalc(works, parts, vatMode, settingsRate);
            const source = wo(works, parts, totals);

            const lines = buildInvoiceLinesFromWorkOrder(source, {
              vatMode,
              vatRate: settingsRate,
            });

            expect(lines).toHaveLength(works.length + parts.length);
            expectLinesMatchWorkOrder(lines, source);
          },
        ),
        { numRuns: 500 },
      );
    });
  });

  // guards: BR-INV-002
  it("копійчаний наряд «ПДВ у ціні» (10 × 0.06): режим — за ближчою сумою, від'ємних рядків немає", () => {
    // ПДВ наряду 0.10 менший за допуск «копійка на рядок», тож і сума без ПДВ (0.50), і сума до
    // сплати (0.60) «збігаються» із сумою рядків 0.60. Раніше перемагала перша перевірка
    // (EXCLUSIVE), і останній рядок виходив [-0.04, 0.01, -0.03].
    const parts = Array.from({ length: 10 }, (_, i) => ({
      goodId: `g${i}`,
      name: `Запчастина ${i}`,
      quantity: 1,
      unitPrice: 0.06,
    }));
    const lines = buildInvoiceLinesFromWorkOrder(
      { totalNet: 0.5, totalAmount: 0.6, lines: [], parts },
      { vatMode: 'INCLUSIVE', vatRate: 20 },
    );

    for (const l of lines) {
      expect(l.priceWithoutVat).toBeGreaterThanOrEqual(0);
      expect(l.vatAmount).toBeGreaterThanOrEqual(0);
      expect(l.priceWithVat).toBeGreaterThan(0);
    }
    // «ПДВ у ціні»: сума рядка з ПДВ = кількість × ціна
    expect(lines.slice(0, -1).every(l => l.priceWithVat === 0.06)).toBe(true);
    const sum = (k: 'priceWithoutVat' | 'priceWithVat') =>
      Math.round(lines.reduce((s, l) => s + l[k], 0) * 100) / 100;
    expect(sum('priceWithVat')).toBe(0.6);
    expect(sum('priceWithoutVat')).toBe(0.5);
  });
});
