import { describe, it, expect } from 'vitest';
import {
  WO_STATUS_TRANSITIONS,
  INVOICE_STATUS_TRANSITIONS,
  PO_STATUS_TRANSITIONS,
  STOCK_DOC_STATUS_TRANSITIONS,
} from '@sto/shared';
import { WORK_ORDER_TRANSITIONS } from './work-orders.fsm';
import { INV_TRANSITIONS } from '../invoices/invoices.service';
import { PO_TRANSITIONS } from '../purchase-orders/purchase-orders.service';
import { DOC_TRANSITIONS } from '../stock-documents/stock-documents.service';

/**
 * Парність FSM: бек ↔ shared.
 *
 * Транзиції живуть у ДВОХ місцях: бек вирішує, що дозволено насправді, а shared-копія
 * підказує UI, які кнопки показати. Досі синхронізація трималась ЛИШЕ на коментарі
 * («must mirror backend… Backend is authoritative») — механічної перевірки не було
 * (аудит 2026-10).
 *
 * Ціна розходження несиметрична й тиха:
 *  - shared дозволяє більше → UI показує кнопку, API відповідає 400 «перехід заборонено»;
 *  - shared дозволяє менше → користувач не бачить дозволеного переходу і вважає, що
 *    система зламана.
 * У жодному з випадків нічого не падає на збірці — саме тому потрібен тест.
 *
 * Бек тут АВТОРИТЕТНИЙ: якщо тест упав, виправляти слід shared-копію, а не бек
 * (якщо, звісно, змінювати правила переходів не було самою метою правки).
 */

/** Порівняння без огляду на порядок: мапи — множини дозволених переходів, не списки. */
const normalize = (m: Record<string, readonly string[]>): Record<string, string[]> =>
  Object.fromEntries(Object.entries(m).map(([k, v]) => [k, [...v].sort()]));

describe('FSM parity: backend ↔ @sto/shared', () => {
  const cases: Array<{
    name: string;
    backend: Record<string, readonly string[]>;
    shared: Record<string, readonly string[]>;
  }> = [
    { name: 'WorkOrder', backend: WORK_ORDER_TRANSITIONS, shared: WO_STATUS_TRANSITIONS },
    { name: 'Invoice', backend: INV_TRANSITIONS, shared: INVOICE_STATUS_TRANSITIONS },
    { name: 'PurchaseOrder', backend: PO_TRANSITIONS, shared: PO_STATUS_TRANSITIONS },
    { name: 'StockDocument', backend: DOC_TRANSITIONS, shared: STOCK_DOC_STATUS_TRANSITIONS },
  ];

  for (const { name, backend, shared } of cases) {
    it(`${name}: shared-копія збігається з беком`, () => {
      expect(normalize(shared)).toEqual(normalize(backend));
    });

    it(`${name}: набір статусів однаковий`, () => {
      // Окремий асерт: різниця саме у КЛЮЧАХ (забутий новий статус) читається у звіті
      // краще, ніж діф цілих об'єктів.
      expect(Object.keys(shared).sort()).toEqual(Object.keys(backend).sort());
    });

    it(`${name}: кожна ціль переходу є відомим статусом`, () => {
      const known = new Set(Object.keys(backend));
      const unknown = Object.values(backend)
        .flat()
        .filter(target => !known.has(target));
      expect(unknown).toEqual([]);
    });
  }
});
