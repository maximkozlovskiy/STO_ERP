/**
 * Спільний DI-провайдер для спеків PurchaseOrdersService.
 *
 * НАВІЩО. `purchase-orders.service.spec.ts` був 1960 рядків із 7 незалежними
 * describe-блоками (pricing / UoM / контракт / FSM / сортування / linked-docs /
 * Σ-totals). Кожен блок будував свій вузько-типізований prisma-мок — і це правильно,
 * блоки справді незалежні. А от `exchangeRatesProvider` повторювався в кожному, тож
 * при розбитті він став би сімома копіями. Тут він один.
 *
 * Більше сюди нічого не винесено СВІДОМО: решта провайдерів у кожному аспекті
 * різна (`PricingService` з реальними моками у pricing-спеку і `{}` у sort-спеку),
 * тож «універсальний» білдер модуля або приховав би цю різницю, або обріс
 * параметрами. Я спершу написав такий білдер — `knip` показав 0 використань.
 *
 * DI-DRIFT GUARD (клас Bug #724, #536). Якщо у конструктор `PurchaseOrdersService`
 * додається новий сервіс — усі 7 спеків впадуть із «Nest can't resolve dependencies».
 * Саме так сталося з `SettingsService` (Bug #536: додано у 60b25347, тест-модулі не
 * оновлено → 38/38 fail на compile). Це очікувана й корисна поведінка: падіння видно
 * одразу, а не через місяць.
 */
import { vi } from 'vitest';
import { ExchangeRatesService } from '../exchange-rates/exchange-rates.service';
import { PurchaseListLinkService } from '../purchase-lists/purchase-list-link.service';
import { PurchaseListReceiptService } from '../purchase-lists/purchase-list-receipt.service';
import { SupplierOrderOutboxService } from '../supplier-api/outbox/supplier-order-outbox.service';

/**
 * Мультивалюта (Фаза 3): PurchaseOrdersService набув ExchangeRatesService.
 * Дефолт — базова валюта: rate=1, amountBase=amount.
 */
export const exchangeRatesProvider = () => ({
  provide: ExchangeRatesService,
  useValue: {
    // Promise.resolve, а не `async () => ({...})`: у вихідному спеку це була async-стрілка
    // без await, і там eslint її не бачив (для *.spec.ts правило послаблене). У звичайному
    // .ts файлі `require-await` — error, і pre-commit хук це зловив. Поведінка та сама.
    resolveBaseConversion: vi
      .fn()
      .mockImplementation((_o: string, _c: string, _d: Date, amount: number) =>
        Promise.resolve({ rateUsed: 1, amountBase: amount }),
      ),
    getBaseCurrency: vi.fn().mockResolvedValue({ id: null, code: 'UAH' }),
    requireBaseCurrencyId: vi.fn().mockResolvedValue('base-cur-id'),
  },
});

/**
 * BR-PO-009/010: хуки позицій списків купівлі й розподіл отриманого — заглушки (ці спеки не про
 * списки; їх стережуть спеки purchase-lists/*). Factory: новий набір `vi.fn()` на кожен виклик.
 */
export const purchaseListProviders = () => [
  {
    provide: PurchaseListLinkService,
    useValue: {
      reconcileDraftOrder: vi.fn().mockResolvedValue(undefined),
      onOrderClosed: vi.fn().mockResolvedValue(undefined),
    },
  },
  {
    provide: PurchaseListReceiptService,
    useValue: {
      lockCandidateWorkOrders: vi.fn().mockResolvedValue(undefined),
      allocateOnReceipt: vi.fn().mockResolvedValue(undefined),
    },
  },
  // BR-PO-011/012: outbox передачі в API постачальника — його стереже supplier-api/outbox/*.
  {
    provide: SupplierOrderOutboxService,
    useValue: {
      onOrderedInTx: vi.fn().mockResolvedValue(false),
      afterCommit: vi.fn(),
      assertCancellable: vi.fn().mockResolvedValue(undefined),
    },
  },
];
