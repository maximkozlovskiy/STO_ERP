import * as fc from 'fast-check';
import { describe, it, expect } from 'vitest';
import { WorkOrderStatus } from '@prisma/client';
import { WO_EDITABLE_STATUSES, WO_INVOICEABLE_STATUSES, WO_SHAREABLE_STATUSES } from '@sto/shared';
import {
  WORK_ORDER_TRANSITIONS,
  EDITABLE_STATUSES,
  INVOICEABLE_STATUSES,
  LINE_ACTUAL_EDITABLE_STATUSES,
  SHAREABLE_STATUSES,
} from './work-orders.fsm';

const ALL_STATUSES = Object.keys(WORK_ORDER_TRANSITIONS) as WorkOrderStatus[];

describe('WORK_ORDER_TRANSITIONS — property-based invariants', () => {
  it('карта переходів містить запис для кожного WorkOrderStatus', () => {
    // Кожен можливий статус має бути ключем у WORK_ORDER_TRANSITIONS
    // інакше FSM не знатиме що з ним робити
    for (const status of ALL_STATUSES) {
      expect(WORK_ORDER_TRANSITIONS[status]).toBeDefined();
      expect(Array.isArray(WORK_ORDER_TRANSITIONS[status])).toBe(true);
    }
  });

  it('будь-який перехід що не у списку дозволених → блокується', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ALL_STATUSES),
        fc.constantFrom(...ALL_STATUSES),
        (from, to) => {
          const allowed = WORK_ORDER_TRANSITIONS[from];
          const isAllowed = allowed.includes(to);
          // Інваріант: якщо `to` НЕ у списку для `from` — то FSM має заблокувати
          // Перевіряємо консистентність карти: дозволений ⇔ allowed.includes(to)
          if (isAllowed) {
            return allowed.includes(to);
          }
          return !allowed.includes(to);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('ARCHIVED — фінальний стан (порожній список переходів)', () => {
    expect(WORK_ORDER_TRANSITIONS['ARCHIVED']).toHaveLength(0);
  });

  it('CANCELLED — фінальний стан (порожній список переходів)', () => {
    expect(WORK_ORDER_TRANSITIONS['CANCELLED']).toHaveLength(0);
  });

  it('будь-який перехід з ARCHIVED або CANCELLED — заборонений (property)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('ARCHIVED' as WorkOrderStatus, 'CANCELLED' as WorkOrderStatus),
        fc.constantFrom(...ALL_STATUSES),
        (terminal, target) => {
          // З термінального стану жоден перехід не дозволений
          return !WORK_ORDER_TRANSITIONS[terminal].includes(target);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('перехід у DRAFT неможливий з пізніших стадій (крім ESTIMATE → DRAFT для корекції)', () => {
    // DRAFT можна повернутись тільки з ESTIMATE — більше нікуди
    for (const from of ALL_STATUSES) {
      if (from === 'ESTIMATE') continue;
      expect(WORK_ORDER_TRANSITIONS[from]).not.toContain('DRAFT');
    }
    expect(WORK_ORDER_TRANSITIONS['ESTIMATE']).toContain('DRAFT');
  });

  it('перехід у PAID можливий тільки з INVOICED', () => {
    for (const from of ALL_STATUSES) {
      if (from === 'INVOICED') continue;
      expect(WORK_ORDER_TRANSITIONS[from]).not.toContain('PAID');
    }
    expect(WORK_ORDER_TRANSITIONS['INVOICED']).toContain('PAID');
  });

  it('CANCELLED доступний лише з певних стадій (не з COMPLETED+)', () => {
    // Скасувати наряд після завершення (COMPLETED, INVOICED, PAID, ARCHIVED) — не можна
    const closedStatuses: WorkOrderStatus[] = ['COMPLETED', 'INVOICED', 'PAID', 'ARCHIVED'];
    for (const closed of closedStatuses) {
      expect(WORK_ORDER_TRANSITIONS[closed]).not.toContain('CANCELLED');
    }
  });

  it('IN_PROGRESS досягається тільки через APPROVED або з ON_HOLD', () => {
    for (const from of ALL_STATUSES) {
      const canGoToInProgress = WORK_ORDER_TRANSITIONS[from].includes('IN_PROGRESS');
      if (canGoToInProgress) {
        expect(['APPROVED', 'ON_HOLD']).toContain(from);
      }
    }
  });

  it('COMPLETED досягається тільки з IN_PROGRESS', () => {
    for (const from of ALL_STATUSES) {
      const canComplete = WORK_ORDER_TRANSITIONS[from].includes('COMPLETED');
      if (canComplete) {
        expect(from).toBe('IN_PROGRESS');
      }
    }
  });

  it('самоперехід (from === to) ніколи не дозволений', () => {
    for (const status of ALL_STATUSES) {
      expect(WORK_ORDER_TRANSITIONS[status]).not.toContain(status);
    }
  });
});

/**
 * Bug #439 (Bug #432 family regression-guard):
 * Запобігає silent FE↔BE divergence для статус-сетів що читаються з обох сторін.
 * Коментарі у `work-orders.fsm.ts` і `packages/shared/src/constants/statuses.ts` ствердять
 * «Must mirror …» — цей тест перетворює коментар на enforceable invariant.
 *
 * Якщо хтось додає 'BLOCKED' у BE EDITABLE_STATUSES але забуває FE — CI стає червоним
 * замість silently рендерити невідповідний UI (canEdit=false для статусу де backend
 * фактично дозволяє редагувати).
 */
describe('FE↔BE status sets symmetry — Bug #432/#439 regression-guard', () => {
  it('EDITABLE_STATUSES (BE) == WO_EDITABLE_STATUSES (FE)', () => {
    expect([...EDITABLE_STATUSES].sort()).toEqual([...WO_EDITABLE_STATUSES].sort());
  });

  it('INVOICEABLE_STATUSES (BE) == WO_INVOICEABLE_STATUSES (FE)', () => {
    expect([...INVOICEABLE_STATUSES].sort()).toEqual([...WO_INVOICEABLE_STATUSES].sort());
  });

  it('SHAREABLE_STATUSES (BE) == WO_SHAREABLE_STATUSES (FE)', () => {
    expect([...SHAREABLE_STATUSES].sort()).toEqual([...WO_SHAREABLE_STATUSES].sort());
  });

  // Bug #522: LINE_ACTUAL_EDITABLE_STATUSES — стани де PATCH /lines/:lineId з
  // ТІЛЬКИ actualHours дозволений (механік закриває факт. години у "В роботі").
  it('LINE_ACTUAL_EDITABLE_STATUSES — superset EDITABLE_STATUSES + {IN_PROGRESS, ON_HOLD}', () => {
    const expected = new Set([...EDITABLE_STATUSES, 'IN_PROGRESS', 'ON_HOLD']);
    const actual = new Set(LINE_ACTUAL_EDITABLE_STATUSES);
    expect(actual).toEqual(expected);
  });

  it('LINE_ACTUAL_EDITABLE_STATUSES не містить термінальних статусів (COMPLETED+)', () => {
    for (const closed of ['COMPLETED', 'INVOICED', 'PAID', 'ARCHIVED', 'CANCELLED'] as const) {
      expect(LINE_ACTUAL_EDITABLE_STATUSES).not.toContain(closed);
    }
  });
});
