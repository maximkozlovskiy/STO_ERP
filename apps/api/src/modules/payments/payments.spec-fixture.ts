/**
 * Спільний мок ExchangeRatesService для спеків PaymentsService.
 *
 * НАВІЩО. `payments.service.spec.ts` був 1720 рядків із 5 незалежними top-level
 * describe; `exchangeRatesMock()` використовувався у чотирьох із них, тож при
 * розбитті за аспектами став би чотирма копіями з self-referencing closure.
 *
 * ВЖЕ FACTORY, і це важливо: `apps/api/vitest.config.ts` має `isolate: false` без
 * `clearMocks`, тож module-level `const` зі спільним `vi.fn()` тік би між файлами
 * одного воркера. Тут кожен виклик створює свіжий набір моків — переносимо як є.
 *
 * DI-DRIFT GUARD. Без цього провайдера `Test.createTestingModule().compile()` падає
 * з UnknownDependenciesException — тобто нова залежність у конструкторі валить усі
 * спеки модуля одразу, і це корисно: видно відразу, а не через місяць.
 */
import { vi } from 'vitest';

// Дефолтний мок конвертації: базова валюта (rate=1, amountBase=amount). Дзеркалить поведінку для
// орг без мультивалюти — 4 describe-блоки нижче будують PaymentsService і всі потребують цей provider
// (DI-drift guard: без нього Test.createTestingModule.compile() падає з UnknownDependency).
export const exchangeRatesMock = () => {
  const m = {
    // Promise.resolve, а не `async () => ({...})`: у *.spec.ts eslint це пропускає
    // (правило послаблене), а у звичайному .ts `require-await` — error. Та сама пастка,
    // що вже спіймала purchase-orders.spec-fixture. Поведінка ідентична.
    resolveBaseConversion: vi
      .fn()
      .mockImplementation((_o: string, _c: string, _d: Date, amount: number) =>
        Promise.resolve({ rateUsed: 1, amountBase: amount }),
      ),
    getBaseCurrency: vi.fn().mockResolvedValue({ id: null, code: 'UAH' }),
    requireBaseCurrencyId: vi.fn().mockResolvedValue('base-cur-id'),
    // Реальна логіка sameCurrency (Фаза 5 консолідація) поверх мокнутого getBaseCurrency —
    // читає base у момент виклику, тож перевизначення getBaseCurrency у тесті працює.
    sameCurrency: vi.fn(async (org: string, a: string | null, b: string | null) => {
      if (a === b) return true;
      const baseId = (await m.getBaseCurrency(org)).id;
      const norm = (v: string | null) => v ?? baseId;
      return norm(a) === norm(b);
    }),
  };
  return m;
};
