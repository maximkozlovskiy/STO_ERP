/**
 * `makeService` для `work-orders.service.spec.ts`: справжні WorkOrdersService, його
 * WorkOrderStockEffectsService і WorkOrderTotalsService на prisma-моку тесту; решта залежностей —
 * заглушки. Винесено з спеку, що дійшов до порогу моноліту (900 рядків).
 *
 * DI-DRIFT GUARD: нова залежність у конструкторі WorkOrdersService правиться тут.
 */
import { vi } from 'vitest';
import { WorkOrdersService } from './work-orders.service';
import { WorkOrderTotalsService } from './work-order-totals.service';
import { WorkOrderStockEffectsService } from './work-order-stock-effects.service';
import type { PrismaService } from '../../prisma/prisma.service';

export function makeService(prisma: PrismaService): WorkOrdersService {
  // findAll only touches `this.prisma`; інші deps null. events — мок з emit (transition-тести
  // double-CHARGE через цей же helper емітять доменні події після коміту).
  // A3: transition() делегує stock-ефекти у WorkOrderStockEffectsService — будуємо РЕАЛЬНИЙ на тому ж
  // prisma-моку з no-op inventory/settlements, щоб reserveParts/writeOff справді читали workOrderPart
  // (transition-тести перевіряють делегацію за фактом workOrderPart.findMany).
  const stockEffects = new WorkOrderStockEffectsService(
    prisma,
    {
      createMovement: vi.fn().mockResolvedValue({ consumed: [], weightedCostPrice: null }),
    } as never,
    { createTransaction: vi.fn().mockResolvedValue({}) } as never,
    null as never, // exchangeRates — курсова різниця (BR-PAY-022) тут не задіяна,
    {
      onWorkOrderClosed: () => Promise.resolve(),
      onWorkOrderPartsChanged: () => Promise.resolve(),
    } as never /* purchaseLists (BR-PL-013) */,
  );
  const exchangeRates = {
    resolveBaseConversion: vi
      .fn()
      .mockImplementation((_o: string, _c: string, _d: Date, amount: number) =>
        Promise.resolve({ rateUsed: 1, amountBase: amount }),
      ),
    getBaseCurrency: vi.fn().mockResolvedValue({ id: null, code: 'UAH' }),
    requireBaseCurrencyId: vi.fn().mockResolvedValue('base-cur-id'),
  } as never;
  return new WorkOrdersService(
    prisma,
    stockEffects,
    null as never, // docNumbers
    null as never, // pdf
    null as never, // audit
    null as never, // settingsService
    // exchangeRates (Фаза 3): default base-конвертація (rate=1, amountBase=amount)
    exchangeRates,
    { emit: vi.fn() } as never, // events (EventEmitter2)
    new WorkOrderTotalsService(null as never, exchangeRates),
    null as never, // orgPrintInfo
    { removeWorkOrderSlots: vi.fn().mockResolvedValue(undefined) } as never, // calendar, BR-WO-022
  );
}
