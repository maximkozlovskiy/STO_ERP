/**
 * Спільний мок `ExchangeRatesService` для фікстур спеків: базова валюта (rate=1, amountBase=amount).
 * Раніше — трьома копіями у фікстурах рахунків, оплат постачальнику й замовлень (клон jscpd).
 */
import { vi } from 'vitest';

export function baseCurrencyRatesMock() {
  const useValue = {
    // Promise.resolve, а не `async`: у звичайному .ts eslint `require-await` — error.
    resolveBaseConversion: vi
      .fn()
      .mockImplementation((_o: string, _c: string, _d: Date, amount: number) =>
        Promise.resolve({ rateUsed: 1, amountBase: amount }),
      ),
    getBaseCurrency: vi.fn().mockResolvedValue({ id: null, code: 'UAH' }),
    requireBaseCurrencyId: vi.fn().mockResolvedValue('base-cur-id'),
    // Реальна логіка sameCurrency поверх мокнутого getBaseCurrency: базу читає в момент виклику,
    // тож спеки FX, що перевизначають getBaseCurrency (Bug #745, BR-SUPPAY-018), впливають і на неї.
    sameCurrency: vi.fn(async (org: string, a: string | null, b: string | null) => {
      if (a === b) return true;
      const baseId = ((await useValue.getBaseCurrency(org)) as { id: string | null }).id;
      const norm = (v: string | null) => v ?? baseId;
      return norm(a) === norm(b);
    }),
  };
  return useValue;
}
