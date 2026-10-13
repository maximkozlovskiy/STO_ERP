/**
 * Кеш клієнтських оплат. Окремих сторінок оплат більше немає (оплату вносять у рахунку або в
 * касі), тож хуків списку й картки тут не лишилось — лише ключ, під яким оплати інвалідує
 * `invalidatePaymentSideEffects` (`lib/cache-invalidation.ts`). Повтор фіскального чека —
 * `useRetryCashFiscal` у `useCash.ts`.
 */
export const paymentsKeys = {
  all: ['payments'] as const,
};
