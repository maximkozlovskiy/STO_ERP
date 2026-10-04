import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { money, sumMoney, moneyFromDecimal, ZERO_MONEY } from './money';
import { roundMoney } from './math';

/**
 * Property-based інваріанти грошей.
 *
 * Навіщо property-тести, а не приклади: float-дрейф проявляється на конкретних
 * «незручних» значеннях (0.1+0.2, 1.005, 300.3*0.2), і вгадати їх прикладами складно.
 * fast-check перебирає сотні комбінацій і сам шукає контрприклад.
 *
 * Головний інваріант — `Σ(рядки) === total`: саме його розходження на копійку бачить
 * бухгалтер, і саме воно описане в докблоці `roundMoney` як реальна проблема (WO-H2/FIN-H1).
 */

/** Генератор реалістичних грошових сум: до 999 999.99, обидва знаки (повернення/сторно). */
const amount = fc.double({
  min: -999_999.99,
  max: 999_999.99,
  noNaN: true,
  noDefaultInfinity: true,
});

describe('money — інваріанти', () => {
  it('money() завжди дає не більше 2 знаків після коми', () => {
    fc.assert(
      fc.property(amount, v => {
        const m = money(v);
        // Перевіряємо через ціле число копійок: порівняння рядків ламалось би на
        // експоненційній нотації для малих значень.
        expect(Number.isInteger(Math.round(m * 100))).toBe(true);
        expect(Math.abs(m * 100 - Math.round(m * 100))).toBeLessThan(1e-6);
      }),
      { numRuns: 300 },
    );
  });

  it('money() ідемпотентна: money(money(x)) === money(x)', () => {
    // Якби не була — повторне збереження суми змінювало б її.
    fc.assert(
      fc.property(amount, v => {
        expect(money(money(v))).toBe(money(v));
      }),
      { numRuns: 300 },
    );
  });

  it('money() збігається з roundMoney (бренд не змінює арифметику)', () => {
    fc.assert(
      fc.property(amount, v => {
        expect(money(v)).toBe(roundMoney(v));
      }),
      { numRuns: 200 },
    );
  });

  it('ГОЛОВНИЙ ІНВАРІАНТ: sumMoney узгоджена з sumLineTotals (Σ(рядки) === total)', () => {
    // Саме це бачить бухгалтер: сума рядків документа мусить дорівнювати total.
    // У проєкті два суматори — sumMoney тут і sumLineTotals у vat.ts. Якщо вони
    // розійдуться, та сама сума порахується по-різному залежно від шляху коду.
    // Обидва округлюють РАЗ у кінці; тест стереже цю узгодженість.
    const sumLikeVatUtil = (lines: readonly number[]): number =>
      roundMoney(lines.reduce((acc, l) => acc + l, 0));

    fc.assert(
      fc.property(fc.array(amount, { minLength: 0, maxLength: 60 }), lines => {
        const rounded = lines.map(l => money(l));
        expect(sumMoney(rounded)).toBe(sumLikeVatUtil(rounded));
      }),
      { numRuns: 300 },
    );
  });

  it('для вже-округлених рядків покрокове округлення дає те саме (виміряно)', () => {
    // Доказ твердження з докблоку sumMoney: на входах, округлених до копійок (рядки з
    // БД, Decimal(12,2)), стратегія округлення не впливає на результат. Саме тому
    // перехід sumMoney на «округлення в кінці» безпечний для наявних даних.
    fc.assert(
      fc.property(fc.array(amount, { minLength: 1, maxLength: 40 }), raw => {
        const rounded = raw.map(r => money(r));
        let perStep = 0;
        for (const r of rounded) perStep = roundMoney(perStep + r);
        expect(sumMoney(rounded)).toBe(perStep);
      }),
      { numRuns: 400 },
    );
  });

  it('sumMoney порожнього списку = 0 (не NaN)', () => {
    expect(sumMoney([])).toBe(0);
  });

  it('sumMoney не дає дрейфу на класичних проблемних значеннях', () => {
    // Регресійні приклади з докблоку roundMoney і типові float-пастки.
    expect(sumMoney([0.1, 0.2])).toBe(0.3);
    expect(sumMoney([300.3 * 0.2])).toBe(60.06);
    expect(money(1.005)).toBe(1.01); // half-away-from-zero, не 1.00
    expect(money(-1.005)).toBe(-1.01); // симетрично для від'ємних
  });

  it('moneyFromDecimal: null/undefined → 0, Decimal → значення', () => {
    expect(moneyFromDecimal(null)).toBe(0);
    expect(moneyFromDecimal(undefined)).toBe(0);
    expect(moneyFromDecimal(12.345)).toBe(12.35);
    expect(moneyFromDecimal({ toNumber: () => 99.994 })).toBe(99.99);
  });

  it('moneyFromDecimal НЕ вужча за Number(), яку вона заміняє', () => {
    // Регресія: функція вимагала toNumber і падала TypeError на Decimal-подібному
    // значенні лише з toString — хоча Number() його обробляв. Кожен виклик
    // moneyFromDecimal стоїть там, де був Number(x), тож контракт мусить бути не вужчим.
    expect(moneyFromDecimal({ toString: () => '350' })).toBe(350);
    expect(moneyFromDecimal('42.555')).toBe(42.56);
    // `valueOf` не входить у union-підпис, але Number() його використає — каст
    // відображає саме цей рантайм-шлях (див. докблок moneyFromDecimal).
    expect(moneyFromDecimal({ valueOf: () => 7.891 } as unknown as number)).toBe(7.89);
    // toNumber має пріоритет, якщо є обидва (справжній Prisma Decimal)
    expect(moneyFromDecimal({ toNumber: () => 1.5, toString: () => '999' })).toBe(1.5);
  });

  it('moneyFromDecimal не протікає NaN на несумісному вході', () => {
    // Number('abc') = NaN; roundMoney ловить !isFinite → 0. Гроші НІКОЛИ не NaN,
    // інакше NaN потрапив би у Decimal-колонку і зламав агрегації.
    expect(moneyFromDecimal('не число')).toBe(0);
    expect(moneyFromDecimal({ toString: () => 'abc' })).toBe(0);
    expect(moneyFromDecimal({ toNumber: () => Number.NaN })).toBe(0);
  });

  it('moneyFromDecimal на рядковому представленні === на числовому', () => {
    // Prisma віддає Decimal то як обгортку, то як рядок (raw SQL, ::text) — обидва
    // шляхи мусять давати ІДЕНТИЧНУ суму, інакше та сама сума порахується по-різному.
    fc.assert(
      fc.property(amount, v => {
        const viaNumber = moneyFromDecimal(v);
        const viaString = moneyFromDecimal(String(v));
        const viaWrapper = moneyFromDecimal({ toNumber: () => v });
        expect(viaString).toBe(viaNumber);
        expect(viaWrapper).toBe(viaNumber);
      }),
      { numRuns: 300 },
    );
  });

  it('ZERO_MONEY — справжній нуль і придатний як початок редюсера', () => {
    expect(ZERO_MONEY).toBe(0);
    expect(sumMoney([ZERO_MONEY, money(10), money(0.01)])).toBe(10.01);
  });

  it('нескінченність і NaN не протікають (контракт roundMoney)', () => {
    expect(money(Number.POSITIVE_INFINITY)).toBe(0);
    expect(money(Number.NaN)).toBe(0);
  });

  it('moneyFromDecimal: крайові входи ніколи не дають NaN/Infinity/-0', () => {
    // Входи, яких спеки ще не покривали (запит QA). Гроші НІКОЛИ не NaN/Infinity,
    // а -0 нормалізовано в 0 (roundMoney `+ 0`), інакше Object.is-порівняння ламаються.
    expect(moneyFromDecimal('')).toBe(0); // Number('') === 0
    expect(moneyFromDecimal('  12.3  ')).toBe(12.3); // Number() тримить пробіли
    expect(moneyFromDecimal('\t\n 7.005 ')).toBe(7.01); // whitespace + half-up
    expect(Object.is(moneyFromDecimal(-0), 0)).toBe(true); // -0 → +0
    expect(Object.is(moneyFromDecimal({ toNumber: () => -0 }), 0)).toBe(true);
    expect(Object.is(moneyFromDecimal({ toString: () => '-0' }), 0)).toBe(true);
    expect(moneyFromDecimal(Number.POSITIVE_INFINITY)).toBe(0);
    expect(moneyFromDecimal(Number.NEGATIVE_INFINITY)).toBe(0);
    expect(moneyFromDecimal({ toNumber: () => Number.POSITIVE_INFINITY })).toBe(0);
    expect(moneyFromDecimal('Infinity')).toBe(0); // Number('Infinity') === Infinity → 0
    expect(moneyFromDecimal({ toString: () => 'NaN' })).toBe(0); // Decimal-подібне 'NaN'
    expect(moneyFromDecimal({ toNumber: () => Number.NaN, toString: () => 'NaN' })).toBe(0);
  });

  it('Bug #776: moneyFromDecimal не падає на обгортці з toNumber, що кидає', () => {
    // `Number(x)`, яку ця функція заміняє, НІКОЛИ не кличе toNumber — лише valueOf/toString.
    // Тож обгортка з бракованим toNumber але валідним toString/valueOf працювала під
    // Number() і мусить працювати тут (контракт НЕ вужчий за Number). Інакше гроші падають
    // TypeError-ом на спільному шляху 44 викликів замість повернути число.
    const throwing = {
      toNumber: () => {
        throw new TypeError('broken decimal');
      },
      toString: () => '350.126',
    };
    expect(() => moneyFromDecimal(throwing)).not.toThrow();
    expect(moneyFromDecimal(throwing)).toBe(350.13); // fallback через toString

    // toNumber кидає, валідного числового представлення немає → 0 (не NaN, не throw).
    const throwingNoString = {
      toNumber: () => {
        throw new Error('boom');
      },
      toString: () => 'не число',
    };
    expect(() => moneyFromDecimal(throwingNoString)).not.toThrow();
    expect(moneyFromDecimal(throwingNoString)).toBe(0);

    // valueOf-fallback теж працює (Number() пробує valueOf першим).
    const throwingValueOf = {
      toNumber: () => {
        throw new Error('x');
      },
      valueOf: () => 12.5,
    };
    expect(moneyFromDecimal(throwingValueOf as unknown as { toNumber(): number })).toBe(12.5);
  });
});
