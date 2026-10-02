import { BadRequestException } from '@nestjs/common';
import { translateError } from '@sto/shared';
import { getLocale } from '../tenant/tenant-context';

/**
 * Validates an FSM status transition and throws BadRequestException if not allowed.
 *
 * Usage:
 *   assertFsmTransition(WORK_ORDER_TRANSITIONS, wo.status, newStatus);
 *   assertFsmTransition(INV_TRANSITIONS, inv.status, newStatus);
 */
export function assertFsmTransition<S extends string>(
  // `readonly` навмисно: transition-мапи оголошені через `as const` (їх НЕ можна мутувати),
  // і мутабельний `S[]` змушував кожен виклик та кожен тест робити зайвий каст.
  transitions: Readonly<Record<S, readonly S[]>>,
  from: S,
  to: S,
): void {
  const allowed: readonly S[] = transitions[from] ?? [];
  if (!(allowed as readonly string[]).includes(to)) {
    throw new BadRequestException(
      translateError('err.fsm.transitionNotAllowed', getLocale(), { from, to }),
    );
  }
}
