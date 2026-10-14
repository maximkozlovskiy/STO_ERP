import { describe, it, expect, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { invalidatePaymentSideEffects, invalidatePurchaseSideEffects } from '../cache-invalidation';
import { cashKeys } from '@/hooks/api/useCash';

/**
 * Bug #848: оплата з рахунку («Оплатити») і оплата із замовлення постачальнику рухають готівку в
 * касі, але кеш каси не скидали — сторінка «Каса» ще до 5 хвилин показувала старий залишок і
 * історію без нового рядка (список кас має staleTime 5 хв).
 */
describe('cache-invalidation — оплата скидає кеш каси', () => {
  const invalidatedKeys = (run: (qc: QueryClient) => void) => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    run(qc);
    return spy.mock.calls.map(([filters]) => filters?.queryKey);
  };

  it('оплата клієнта (рахунок, наряд) скидає касу: залишок та історію', () => {
    expect(invalidatedKeys(invalidatePaymentSideEffects)).toContainEqual(cashKeys.all);
  });

  it('оплата постачальнику із замовлення скидає касу', () => {
    expect(invalidatedKeys(invalidatePurchaseSideEffects)).toContainEqual(cashKeys.all);
  });

  it('скинутий ключ — префікс і списку кас (залишок), і історії операцій', () => {
    expect(cashKeys.registers().slice(0, cashKeys.all.length)).toEqual([...cashKeys.all]);
    expect(cashKeys.operations('id', {}).slice(0, cashKeys.all.length)).toEqual([...cashKeys.all]);
  });
});
