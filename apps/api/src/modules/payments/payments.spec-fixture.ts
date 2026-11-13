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
import { baseCurrencyRatesMock } from '../exchange-rates/exchange-rates.testing';

// Дефолтний мок конвертації: базова валюта (rate=1, amountBase=amount). Дзеркалить поведінку для
// орг без мультивалюти — 4 describe-блоки нижче будують PaymentsService і всі потребують цей provider
// (DI-drift guard: без нього Test.createTestingModule.compile() падає з UnknownDependency).
export const exchangeRatesMock = () => baseCurrencyRatesMock();
