import { describe, it, expect } from 'vitest';
import {
  WORK_ORDER_TRANSITIONS,
  EDITABLE_STATUSES,
  SHAREABLE_STATUSES,
  INVOICEABLE_STATUSES,
} from './work-orders.fsm';
import {
  WO_STATUS_TRANSITIONS,
  WO_EDITABLE_STATUSES,
  WO_SHAREABLE_STATUSES,
  WO_INVOICEABLE_STATUSES,
} from '@sto/shared';

/**
 * A5: gate-множини тепер мають ЄДИНЕ джерело у @sto/shared (backend їх імпортує). Ці assert-и
 * фіксують контракт backend↔shared: gate-сети ідентичні (бо імпортовані), а FSM-transition-мапа
 * (яка лишається двома представленнями — typed backend Record + string shared) НЕ має розходитись.
 * Раніше синхрон тримався лише коментарем «Must mirror» — тепер це regression-guard.
 */
describe('FSM contract backend ↔ @sto/shared (A5)', () => {
  it('gate-множини backend = shared (єдине джерело)', () => {
    expect([...EDITABLE_STATUSES].sort()).toEqual([...WO_EDITABLE_STATUSES].sort());
    expect([...SHAREABLE_STATUSES].sort()).toEqual([...WO_SHAREABLE_STATUSES].sort());
    expect([...INVOICEABLE_STATUSES].sort()).toEqual([...WO_INVOICEABLE_STATUSES].sort());
  });

  it('FSM-transition-мапа backend = shared (жодного drift)', () => {
    const backendKeys = Object.keys(WORK_ORDER_TRANSITIONS).sort();
    const sharedKeys = Object.keys(WO_STATUS_TRANSITIONS).sort();
    expect(backendKeys).toEqual(sharedKeys);
    for (const status of backendKeys) {
      expect(
        [...WORK_ORDER_TRANSITIONS[status as keyof typeof WORK_ORDER_TRANSITIONS]].sort(),
        `переходи для ${status} мають збігатися backend↔shared`,
      ).toEqual([...WO_STATUS_TRANSITIONS[status]].sort());
    }
  });
});
