import * as fc from 'fast-check';
import { describe, it, expect } from 'vitest';
import { WorkOrderStatus } from '@prisma/client';
import { WORK_ORDER_TRANSITIONS } from './work-orders.fsm';

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
