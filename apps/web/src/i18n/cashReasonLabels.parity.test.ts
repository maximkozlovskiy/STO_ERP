// Інваріант: назви приводів касової операції у каталозі інтерфейсу (cash.json) збігаються з
// `CASH_REASON_LABELS` із @sto/shared, які api підставляє в тексти помилок. Інакше користувач
// бачить у списку «Видача», а в повідомленні про відмову — інакше названий привід.
import { describe, it, expect } from 'vitest';
import { CASH_REASON_LABELS, CASH_REASON_VALUES } from '@sto/shared';
import ukCash from './locales/uk/cash.json';
import enCash from './locales/en/cash.json';

describe('назви приводів: каталог web ↔ @sto/shared', () => {
  it.each([
    ['uk', ukCash],
    ['en', enCash],
  ] as const)('%s: reasons.* == CASH_REASON_LABELS', (locale, catalog) => {
    const fromCatalog = (catalog as { reasons: Record<string, string> }).reasons;
    expect(Object.keys(fromCatalog).sort()).toEqual([...CASH_REASON_VALUES].sort());
    for (const reason of CASH_REASON_VALUES) {
      expect(fromCatalog[reason], `${locale}:${reason}`).toBe(CASH_REASON_LABELS[locale][reason]);
    }
  });
});
