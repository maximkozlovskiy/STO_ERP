/**
 * Спільний DI-провайдер для спеків CounterpartiesService.
 *
 * НАВІЩО. `counterparties.service.spec.ts` був 1194 рядки з 5 незалежними top-level
 * describe; при розбитті за аспектами `statusesMock` повторився б у кожному з п'яти.
 *
 * ЧОМУ FACTORY, А НЕ `const`. У вихідному спеку це був module-level `const` зі спільним
 * `vi.fn()`:
 *
 *     const statusesMock = { provide: CounterpartyStatusesService,
 *                            useValue: { invalidateCache: vi.fn() } };
 *
 * В ОДНОМУ файлі це безпечно. У п'яти — ні: `apps/api/vitest.config.ts` має
 * `isolate: false` і НЕ має `clearMocks`/`restoreMocks`, тож module-level `vi.fn()` живе
 * спільно для всіх спеків одного воркера, і виклик з одного файлу лишався б видимим у
 * наступному. Зараз на `invalidateCache` ніхто не асертить, тож баг був би латентний —
 * саме тому його треба прибрати ДО того, як хтось додасть `expect(...).toHaveBeenCalled()`.
 *
 * DI-DRIFT GUARD (Bug #724). Цей провайдер з'явився саме через drift: сервіс отримав
 * 4-ту залежність (`CounterpartyStatusesService`) у фічі статусів-міток, а спек не
 * оновили → Nest не міг зібрати модуль, усі тести падали на wiring. Тепер нова залежність
 * валить усі спеки модуля одразу — і це корисно: видно відразу, а не через місяць.
 */
import { vi } from 'vitest';
import { CounterpartyStatusesService } from '../counterparty-statuses/counterparty-statuses.service';

/**
 * Мок CounterpartyStatusesService. Assign/unassign кличуть лише `invalidateCache`,
 * тож решти методів сервісу спекам не потрібно.
 */
export const statusesProvider = () => ({
  provide: CounterpartyStatusesService,
  useValue: { invalidateCache: vi.fn() },
});
