import { BadRequestException } from '@nestjs/common';
import { MONEY_AMOUNT_MAX, translateError } from '@sto/shared';
import { roundMoney } from './math';
import { getLocale, type Locale } from '../tenant/tenant-context';

/**
 * Брендований тип для грошових сум.
 *
 * ПРОБЛЕМА, яку він вирішує (аудит 2026-10). Гроші у схемі — `Decimal(12,2)`, але всі
 * обчислення (ПДВ, суми рядків, собівартість) ідуть у JS `number`. Коректність тримається
 * на дисципліні: `roundMoney()` треба викликати на КОЖНОМУ кроці. Пропустив — компілятор
 * промовчить, а бухгалтер клієнта побачить розбіжність на копійку через місяць.
 * У коді 222 конверсії `Number()`/`toNumber()` у 55 файлах — ручним оглядом це не тримається.
 *
 * ЧОМУ БРЕНД, А НЕ МІГРАЦІЯ НА Decimal. Повний перехід на `Decimal` наскрізно зачіпає
 * 103 файли і транспортний шар (JSON-число вже втратило точність до того, як web його
 * побачив). Це окрема велика робота. Бренд дає більшу частину захисту поступово:
 * рантайм не змінюється, міграція йде модуль за модулем, і там, де тип застосовано,
 * пропущене округлення стає ПОМИЛКОЮ ТИПУ.
 *
 * ЯК ПРАЦЮЄ. `Money` — це `number` із фантомним полем, тож:
 *  · звичайний `number` НЕ присвоюється у `Money` без явного `money()`;
 *  · `Money` вільно читається як `number` (арифметика, порівняння, передача у Prisma);
 *  · результат арифметики (`a + b`) — це вже `number`, не `Money`, тож щоб покласти його
 *    назад у грошове поле, потрібен повторний `money()` — саме там і спрацьовує округлення.
 *
 * ОБМЕЖЕННЯ, яке треба знати: бренд не ловить випадок, коли проміжну суму записали в БД
 * як сирий `number` в обхід типу. Він робить правильний шлях найлегшим, а не єдиним.
 */
declare const moneyBrand: unique symbol;

export type Money = number & { readonly [moneyBrand]: 'Money' };

/**
 * Єдиний конструктор `Money`: округлює до копійок (half-away-from-zero) і брендує.
 *
 * Застосовувати до кожного грошового результату перед записом і при сумуванні —
 * як і `roundMoney` раніше, але тепер пропуск видно компілятору.
 */
export function money(value: number): Money {
  return roundMoney(value) as Money;
}

/** Нуль як `Money` — щоб не писати `money(0)` у кожному редюсері. */
export const ZERO_MONEY = money(0);

/**
 * Сума рядка документа: кількість × ціна, округлена до копійки (BR-WO-007: сума документа — це
 * сума ОКРУГЛЕНИХ рядків). Одна формула для тоталів наряду, його PDF, акта, кошторису з огляду й
 * рядків робіт; для роботи кількість — `actualHours ?? normoHours` (факт) або `normoHours` (план).
 */
export function lineAmount(quantity: number, price: number): Money {
  return money(quantity * price);
}

/**
 * BR-FIN-MONEYCAP (M3, рішення власника 2026-10-24): грошова сума, що лягає в колонку `Decimal(12,2)`,
 * мусить вміститися в її місткість (`MONEY_AMOUNT_MAX = 9 999 999 999,99`), інакше — **400** із
 * назвою поля, а не безіменна 500 `numeric field overflow`.
 *
 * ЧОМУ ОКРЕМО ВІД ПОЛЬОВИХ СТЕЛЬ. Кількість (`QTY_MAX`) і ціна (`MONEY_AMOUNT_MAX`) обмежені
 * кожна окремо у спільних Zod-схемах, але їхній ДОБУТОК (сума рядка `quantity × unitPrice`) усе
 * одно може перевищити колонку: 1 000 000 × 10 000 = 10 000 000 000. Та сама діра, що її закрив
 * `assertAmountBaseFits` для base-конвертації виписки (BR-BANK-042) — тут один спільний помічник
 * для рядків наряду, рахунку й будь-якого похідного тоталу, що лягає в `Decimal(12,2)`.
 *
 * Порівнюємо ОКРУГЛЕНЕ до копійки абсолютне значення — саме так воно ляже в колонку. `field`
 * іде в повідомлення, щоб користувач бачив, яка саме сума завелика.
 */
export function assertMoneyFits(amount: number, field?: string): void {
  const stored = Math.round(Math.abs(amount) * 100) / 100;
  if (!Number.isFinite(stored) || stored > MONEY_AMOUNT_MAX) {
    // `{{field}}` завжди підставляється (навіть порожнім), щоб плейсхолдер не протік у текст.
    throw new BadRequestException(
      translateError('err.money.lineAmountOverflow', getLocale(), {
        field: field ? ` (${field})` : '',
      }),
    );
  }
}

/**
 * Сума ВЖЕ-ОКРУГЛЕНИХ грошових значень (рядки документа з БД, `Decimal(12,2)`).
 *
 * Округлює РАЗ у кінці — це точніше за покрокове округлення. Виміряно на 200 000
 * випадкових наборів:
 *  · входи вже округлені до копійок (наш випадок — рядки з БД): стратегії дають
 *    ІДЕНТИЧНИЙ результат у 100% випадків;
 *  · входи сирі (неокруглені проміжні обчислення): розходяться на копійку у ~51%
 *    випадків, і покрокове округлення накопичує помилку.
 * Тож для сум рядків документа різниці немає, а для сирих значень цей варіант кращий.
 *
 * Дзеркалить поведінку `sumLineTotals` у `vat.ts` — там та сама стратегія, і це свідомо:
 * `Σ(рядки) === total` має триматись незалежно від того, яким із суматорів порахували.
 */
export function sumMoney(values: readonly number[]): Money {
  let acc = 0;
  for (const v of values) acc += v;
  return money(acc);
}

/**
 * Перетворення Prisma `Decimal` (або будь-чого числоподібного) у `Money`.
 *
 * Замінює розсипані `Number(row.amount)`: там конверсія була безумовною і без округлення,
 * хоча `Decimal(12,2)` із БД уже округлений — проблема виникала далі, коли результат
 * обчислення писали назад без `roundMoney`.
 *
 * ЧОМУ ПРИЙМАЄ І `toString`, А НЕ ЛИШЕ `toNumber` (знайдено падінням payroll-специв):
 * ця функція стоїть РІВНО там, де раніше був `Number(x)`, а `Number()` конвертує через
 * `toString`. Якщо вимагати тільки `toNumber`, кожен такий виклик стає латентним
 * `TypeError` на значенні, яке `Number()` обробляв: Prisma `Decimal` має обидва методи,
 * але не кожне числоподібне значення в коді є справжнім `Decimal` (raw-SQL рядки,
 * `::text`-касти, Decimal-подібні обгортки). Контракт мусить бути НЕ вужчим за той,
 * який ця функція заміняє.
 */
export function moneyFromDecimal(
  value: { toNumber(): number } | { toString(): string } | number | string | null | undefined,
): Money {
  if (value == null) return ZERO_MONEY;
  if (typeof value === 'number') return money(value);
  if (typeof value === 'string') return money(Number(value));
  if ('toNumber' in value && typeof value.toNumber === 'function') {
    // Bug #776: `toNumber()` викликаємо захищено. `Number(x)`, яку ця функція заміняє,
    // НІКОЛИ не звертається до `toNumber` (лише valueOf/toString), тож ніколи не падала
    // на обгортці з бракованим `toNumber`. Якщо вимагати toNumber і кидати exception
    // далі — контракт стає ВУЖЧИМ за Number() (порушення докблоку) і гроші падають
    // TypeError-ом на спільному шляху 44 викликів. Fallback на Number()-шлях (toString)
    // зберігає стару поведінку; якщо й він не дасть число — roundMoney→0 (гроші не NaN).
    try {
      return money(value.toNumber());
    } catch {
      return money(Number(value));
    }
  }
  // `Number(obj)` використає valueOf/toString — той самий шлях, що й до міграції.
  return money(Number(value));
}

const MESSAGE_MONEY_FMT: Record<Locale, Intl.NumberFormat> = {
  uk: new Intl.NumberFormat('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  en: new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
};

/**
 * Сума для тексту помилки: розряди й рівно дві копійки за мовою запиту («5 680,49» / «5,680.49»),
 * а не сирий `number` («5680.49», «9999999»). Валюту викликач підставляє окремо (`{{currency}}`).
 */
export function formatMoneyForMessage(amount: number, locale: Locale): string {
  return MESSAGE_MONEY_FMT[locale].format(amount);
}
