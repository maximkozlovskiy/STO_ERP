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
  transitions: Record<S, S[]>,
  from: S,
  to: S,
): void {
  const allowed = transitions[from] ?? ([] as S[]);
  if (!(allowed as string[]).includes(to)) {
    throw new BadRequestException(
      translateError('err.fsm.transitionNotAllowed', getLocale(), { from, to }),
    );
  }
}
