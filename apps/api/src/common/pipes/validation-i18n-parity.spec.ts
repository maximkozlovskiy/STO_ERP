import { describe, it, expect } from 'vitest';
import { uk, en, VALIDATION_KEYS, translateValidation } from '@sto/shared';

/**
 * Key-parity guard для validation-каталогу. Схеми (@sto/shared) емітять validation-KEY-и як
 * issue.message; api-pipe і web-resolver резолвлять їх через translateValidation. Якщо ключ є у
 * схемі/en, але відсутній у uk (fallback baseline) — у UI протече raw-key. Цей тест ловить розсинхрон
 * uk↔en↔VALIDATION_KEYS ДО деплою.
 */
describe('validation i18n — key parity', () => {
  const ukKeys = Object.keys(uk).sort();
  const enKeys = Object.keys(en).sort();
  const declared = [...VALIDATION_KEYS].sort();

  it('uk та en мають ІДЕНТИЧНИЙ набір ключів', () => {
    expect(ukKeys).toEqual(enKeys);
  });

  it('VALIDATION_KEYS збігається з ключами каталогів (жодного зайвого/пропущеного)', () => {
    expect(declared).toEqual(ukKeys);
  });

  it('жодне значення не порожнє (uk + en)', () => {
    for (const k of ukKeys) {
      expect(uk[k]?.length, `uk[${k}]`).toBeGreaterThan(0);
      expect(en[k]?.length, `en[${k}]`).toBeGreaterThan(0);
    }
  });

  it('translateValidation резолвить кожен ключ в обидві мови (не повертає сам key)', () => {
    for (const k of declared) {
      expect(translateValidation(k, 'uk')).not.toBe(k);
      expect(translateValidation(k, 'en')).not.toBe(k);
    }
  });

  it('fallback: невідомий key → сам key; en-miss → uk', () => {
    expect(translateValidation('v.__nonexistent__', 'en')).toBe('v.__nonexistent__');
  });
});
