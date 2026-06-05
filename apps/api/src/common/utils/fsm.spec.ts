import { describe, it, expect } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { assertFsmTransition } from './fsm';

const TRANSITIONS = {
  DRAFT: ['ESTIMATE', 'CANCELLED'],
  ESTIMATE: ['APPROVED', 'DRAFT', 'CANCELLED'],
  APPROVED: ['IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['COMPLETED', 'ON_HOLD'],
  ON_HOLD: ['IN_PROGRESS', 'CANCELLED'],
  COMPLETED: ['INVOICED'],
  INVOICED: ['PAID'],
  PAID: ['ARCHIVED'],
  ARCHIVED: [],
  CANCELLED: [],
} as const;

type Status = keyof typeof TRANSITIONS;

describe('assertFsmTransition', () => {
  it('не кидає виключення коли перехід дозволений', () => {
    expect(() =>
      assertFsmTransition(TRANSITIONS, 'DRAFT' as Status, 'ESTIMATE' as Status),
    ).not.toThrow();
  });

  it('не кидає виключення для кожного дозволеного переходу DRAFT', () => {
    for (const to of TRANSITIONS.DRAFT) {
      expect(() => assertFsmTransition(TRANSITIONS, 'DRAFT' as Status, to as Status)).not.toThrow();
    }
  });

  it('кидає BadRequestException для забороненого переходу', () => {
    expect(() =>
      assertFsmTransition(TRANSITIONS, 'DRAFT' as Status, 'COMPLETED' as Status),
    ).toThrow(BadRequestException);
  });

  it('кидає BadRequestException для термінального статусу з переходом', () => {
    expect(() => assertFsmTransition(TRANSITIONS, 'ARCHIVED' as Status, 'DRAFT' as Status)).toThrow(
      BadRequestException,
    );
  });

  it('кидає BadRequestException коли from відсутній у transitions', () => {
    const minimal = { A: ['B'] } as Record<string, string[]>;
    expect(() => assertFsmTransition(minimal, 'UNKNOWN' as 'A', 'B' as 'A')).toThrow(
      BadRequestException,
    );
  });

  it('повідомлення помилки містить from і to статуси', () => {
    try {
      assertFsmTransition(TRANSITIONS, 'DRAFT' as Status, 'PAID' as Status);
    } catch (e) {
      expect(e).toBeInstanceOf(BadRequestException);
      const message = (e as BadRequestException).message;
      expect(message).toContain('DRAFT');
      expect(message).toContain('PAID');
    }
  });

  it('дозволяє self-loop якщо є у transitions', () => {
    const withLoop = { A: ['A', 'B'] } as Record<string, string[]>;
    expect(() => assertFsmTransition(withLoop, 'A' as 'A', 'A' as 'A')).not.toThrow();
  });
});
