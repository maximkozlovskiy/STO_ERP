import { BadRequestException } from '@nestjs/common';
import { err } from '../../common/utils/err';
import { changesTimeOrLift } from '../calendar/calendar-chain';
import {
  overflowEnd,
  splitByWorkHours,
  type TimeSegment,
  type WorkHours,
} from '../../common/utils/work-hours';

/**
 * BR-WO-024: зміна запису календаря, що належить наряду, — через дати наряду. Функції шляху
 * «запис змінено → наряд» без звернень до БД: чи зміна його стосується, межі ланцюжка після зміни,
 * вікно запису з перевіркою дат (`slotWindow` — 400 на невалідні) і кінець, що виходить за робочий день.
 */

/** Збережений запис календаря — те, з чим порівнюється зміна. */
export interface SlotState {
  workOrderId: string | null;
  startAt: Date;
  endAt: Date;
  liftId: string | null;
}

/** Зміна запису: тіло `PATCH /calendar/slots/:id` або запис синхронізації з планшета. */
export interface SlotChange {
  startAt?: string | Date | undefined;
  endAt?: string | Date | undefined;
  liftId?: string | null | undefined;
  workOrderId?: string | null | undefined;
}

/**
 * Зміна змінює час чи підйомник запису наряду. Порівнюється зі збереженим, а не «поле є в
 * запиті»: форма шле час і підйомник щоразу, і зміна лише примітки чи механіка лишається на
 * записі. Перев'язка запису до іншого наряду чи відв'язка — окремий шлях (`relinksSlot`).
 */
export function movesWorkOrderSlot(slot: SlotState, change: SlotChange): boolean {
  if (!slot.workOrderId) return false;
  if (change.workOrderId !== undefined && (change.workOrderId ?? null) !== slot.workOrderId)
    return false;
  return changesTimeOrLift(slot, change);
}

/**
 * Зміна дає запису інший наряд (BR-WO-028) або відв'язує його від наряду: `workOrderId` у зміні
 * відрізняється від збереженого. Форма шле наряд щоразу, тож той самий наряд — не перев'язка.
 */
export function relinksSlot(slot: Pick<SlotState, 'workOrderId'>, change: SlotChange): boolean {
  return change.workOrderId !== undefined && (change.workOrderId ?? null) !== slot.workOrderId;
}

// Межі ланцюжка й розпочатий ланцюжок — спільні з ручним записом календаря (BR-CAL-020).
export {
  assertChainStartKept,
  bounds,
  chainBounds,
  changesTimeOrLift,
} from '../calendar/calendar-chain';

/** Підйомник запису після зміни: `liftId` у зміні або збережений. */
export const nextLift = (
  change: Pick<SlotChange, 'liftId'>,
  slot: Pick<SlotState, 'liftId'>,
): string | null => (change.liftId !== undefined ? (change.liftId ?? null) : slot.liftId);

/** Механік запису після зміни: `employeeId` у зміні або збережений. */
export const nextMechanic = (
  change: { employeeId?: string | null | undefined },
  slot: { employeeId: string | null },
): string | null => (change.employeeId !== undefined ? change.employeeId : slot.employeeId);

/**
 * Проміжок запису після зміни — час зі зміни чи збережений (`stored`): 400, якщо дата не
 * розбирається або кінець не пізніше за початок. Кінець, що виходить за робочий день, переходить
 * на наступний (`overflowEnd`).
 */
export function slotWindow(
  change: Pick<SlotChange, 'startAt' | 'endAt'>,
  stored: TimeSegment | null,
  hours: WorkHours,
): TimeSegment {
  const startAt = change.startAt != null ? new Date(change.startAt) : stored?.startAt;
  const rawEnd = change.endAt != null ? new Date(change.endAt) : stored?.endAt;
  if (!startAt || !rawEnd || Number.isNaN(startAt.getTime()) || Number.isNaN(rawEnd.getTime()))
    throw new BadRequestException(err('err.calendar.invalidDateFormat'));
  if (rawEnd <= startAt) throw new BadRequestException(err('err.calendar.endBeforeStart'));
  return { startAt, endAt: overflowEnd(startAt, rawEnd, hours) };
}

/**
 * Робочі години між датами (у межах годин філії, без вихідних філії — BR-WO-019), до сотих —
 * те, що картка наряду показує в «Нормогодин» і перераховує при зміні дат (`calcPlannedHours`
 * у web). Зміна меж запису змінює тривалість наряду, тож і його планові нормогодини (Bug #903).
 */
export function workHoursBetween(start: Date, end: Date, hours: WorkHours): number {
  const ms = splitByWorkHours(start, end, hours).reduce(
    (sum, s) => sum + (s.endAt.getTime() - s.startAt.getTime()),
    0,
  );
  return Math.round((ms / 3_600_000) * 100) / 100;
}
