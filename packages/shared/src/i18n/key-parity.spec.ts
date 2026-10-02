import { describe, it, expect } from 'vitest';
import { uk } from './messages.uk';
import { en } from './messages.en';
import { VALIDATION_KEYS } from './keys';

/**
 * Парність i18n-ключів uk ↔ en ↔ VALIDATION_KEYS.
 *
 * Перший тест у `packages/shared` взагалі: пакет містить бізнес-константи, FSM-копії та
 * тексти валідації, але не мав ні тестів, ні скрипта `test` (аудит 2026-10).
 *
 * Коментар у `messages.uk.ts` обіцяє: «Ключі мусять збігатися 1:1 з messages.en.ts
 * (перевіряється key-parity тестом/санітаркою)» — самого тесту не існувало.
 *
 * Чому це важливо: відсутній ключ не ламає ні збірку, ні типи. Користувач en-локалі
 * побачить сирий ключ (`v.good.name.required`) замість повідомлення, і дізнаємось ми про
 * це зі скарги, а не з CI.
 */
describe('i18n key parity', () => {
  const ukKeys = Object.keys(uk).sort();
  const enKeys = Object.keys(en).sort();

  it('uk і en мають однаковий набір ключів', () => {
    expect(ukKeys).toEqual(enKeys);
  });

  it('жоден ключ не має порожнього значення', () => {
    const empty = [
      ...Object.entries(uk)
        .filter(([, v]) => !v.trim())
        .map(([k]) => `uk:${k}`),
      ...Object.entries(en)
        .filter(([, v]) => !v.trim())
        .map(([k]) => `en:${k}`),
    ];
    expect(empty).toEqual([]);
  });

  it('кожен ключ із VALIDATION_KEYS має переклад в обох локалях', () => {
    const missing = VALIDATION_KEYS.flatMap(k => [
      ...(k in uk ? [] : [`uk:${k}`]),
      ...(k in en ? [] : [`en:${k}`]),
    ]);
    expect(missing).toEqual([]);
  });

  it('плейсхолдери {{…}} збігаються між uk і en', () => {
    // Розбіжність тут — не косметика: `translateError` підставляє саме ці імена, тож
    // зайвий плейсхолдер в одній локалі віддасть користувачу «{{max}}» у тексті.
    const holders = (s: string): string[] =>
      [...s.matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]!).sort();

    const mismatched = ukKeys
      .filter(k => k in en)
      .map(k => ({ k, u: holders(uk[k]!), e: holders(en[k]!) }))
      .filter(({ u, e }) => u.join(',') !== e.join(','))
      .map(({ k, u, e }) => `${k}: uk[${u.join(',')}] vs en[${e.join(',')}]`);

    expect(mismatched).toEqual([]);
  });
});
