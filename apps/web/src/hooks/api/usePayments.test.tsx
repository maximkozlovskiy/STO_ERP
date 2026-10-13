import { it, expect, describe } from 'vitest';
import { paymentsKeys } from './usePayments';

// Ключ оплат читає `invalidatePaymentSideEffects`: зміна рядка мовчки вимкнула б інвалідацію.
describe('paymentsKeys', () => {
  it('all → ["payments"]', () => {
    expect(paymentsKeys.all).toEqual(['payments']);
  });
});
