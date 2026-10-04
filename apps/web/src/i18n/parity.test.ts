import { describe, it, expect } from 'vitest';
import { resources } from './resources';

/**
 * Паритет каталогів uk ↔ en.
 *
 * НАВІЩО ОКРЕМИЙ ТЕСТ. Під час міграції toast-ів на i18n (2026-10-04) виявилось, що
 * такого тесту не існувало: `vitest run src/i18n` ганяв лише `enumLabel.test.ts`, тож
 * «паритет зелений» нічого не стверджував про ключі. Ключ, доданий лише в один каталог,
 * проходив би tsc, лінт і всі тести — а en-користувач побачив би сам ключ
 * («toast.invoiceSaved») замість повідомлення.
 *
 * ТРИ ПЕРЕВІРКИ, кожна ловить свій клас помилки:
 *  1. набір ключів однаковий — пропущений переклад;
 *  2. набір {{плейсхолдерів}} однаковий — en-повідомлення без номера документа
 *     («Invoice created» замість «Invoice 00123 created») проходить перевірку (1);
 *  3. жодного порожнього рядка — порожній переклад виглядає як зникле повідомлення.
 */

type Catalog = Record<string, unknown>;

/** Плоскі `a.b.c` → значення; лише рядкові листки (вкладеність i18next довільна). */
function flatten(obj: Catalog, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') out.set(key, v);
    else if (v && typeof v === 'object') {
      for (const [ck, cv] of flatten(v as Catalog, key)) out.set(ck, cv);
    }
  }
  return out;
}

const placeholders = (s: string): string[] =>
  [...s.matchAll(/\{\{\s*(\w+)/g)].map(m => m[1]).sort();

const namespaces = Object.keys(resources.uk) as Array<keyof typeof resources.uk>;

describe('i18n — паритет каталогів uk ↔ en', () => {
  it('усі неймспейси присутні в обох мовах', () => {
    expect(Object.keys(resources.en).sort()).toEqual(Object.keys(resources.uk).sort());
  });

  it.each(namespaces)('%s: набір ключів однаковий', ns => {
    const uk = [...flatten(resources.uk[ns] as Catalog).keys()].sort();
    const en = [...flatten(resources.en[ns] as Catalog).keys()].sort();
    // toEqual на масивах дає читабельний діф із конкретними ключами, що розійшлись.
    expect(en).toEqual(uk);
  });

  it.each(namespaces)('%s: {{плейсхолдери}} збігаються', ns => {
    const uk = flatten(resources.uk[ns] as Catalog);
    const en = flatten(resources.en[ns] as Catalog);
    const mismatched: string[] = [];
    for (const [key, ukValue] of uk) {
      const enValue = en.get(key);
      if (enValue === undefined) continue; // покрито тестом ключів вище
      const a = placeholders(ukValue);
      const b = placeholders(enValue);
      if (a.join(',') !== b.join(',')) {
        mismatched.push(`${key}: uk[${a.join(',')}] ≠ en[${b.join(',')}]`);
      }
    }
    expect(mismatched).toEqual([]);
  });

  it.each(namespaces)('%s: немає порожніх рядків', ns => {
    const empty: string[] = [];
    for (const lang of ['uk', 'en'] as const) {
      for (const [key, value] of flatten(resources[lang][ns] as Catalog)) {
        if (value.trim() === '') empty.push(`${lang}:${key}`);
      }
    }
    expect(empty).toEqual([]);
  });
});
