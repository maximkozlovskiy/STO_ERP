import { BadRequestException } from '@nestjs/common';
import { err } from '../../common/utils/err';
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

const instant = (v: string | Date): number => new Date(v).getTime();

/**
 * Зміна змінює час чи підйомник запису наряду. Порівнюється зі збереженим, а не «поле є в
 * запиті»: форма шле час і підйомник щоразу, і зміна лише примітки чи механіка лишається на
 * записі. Перев'язка запису до іншого наряду чи відв'язка — окремий шлях (`relinksSlot`).
 */
export function movesWorkOrderSlot(slot: SlotState, change: SlotChange): boolean {
  if (!slot.workOrderId) return false;
  if (change.workOrderId !== undefined && (change.workOrderId ?? null) !== slot.workOrderId)
    return false;
  return (
    (change.startAt != null && instant(change.startAt) !== slot.startAt.getTime()) ||
    (change.endAt != null && instant(change.endAt) !== slot.endAt.getTime()) ||
    (change.liftId !== undefined && (change.liftId ?? null) !== slot.liftId)
  );
}

/**
 * Зміна дає запису інший наряд (BR-WO-028) або відв'язує його від наряду: `workOrderId` у зміні
 * відрізняється від збереженого. Форма шле наряд щоразу, тож той самий наряд — не перев'язка.
 */
export function relinksSlot(slot: Pick<SlotState, 'workOrderId'>, change: SlotChange): boolean {
  return change.workOrderId !== undefined && (change.workOrderId ?? null) !== slot.workOrderId;
}

/**
 * Межі ланцюжка (якір і продовження), коли запис `editedId` отримав проміжок `edited`:
 * найраніший початок і найпізніше завершення — нові планові дати наряду. Тому зміна меж крайнього
 * запису змінює тривалість наряду. Внутрішню межу багатоденного ланцюжка (кінець не останнього
 * дня, початок продовження) ставлять робочі години (BR-WO-020) — її зміна 400
 * `err.calendar.chainInnerEdge` (BR-WO-024, TECH-DEBT (б) №66; до 2026-11-06 мовчки відкочувалась).
 */
export function chainBounds(
  chain: readonly ({ id: string } & TimeSegment)[],
  editedId: string,
  edited: TimeSegment,
): { start: Date; end: Date } {
  const stored = chain.find(s => s.id === editedId);
  if (stored && chain.length > 1) {
    const outer = bounds(chain);
    const startMoved = edited.startAt.getTime() !== stored.startAt.getTime();
    const endMoved = edited.endAt.getTime() !== stored.endAt.getTime();
    if (
      (startMoved && stored.startAt.getTime() !== outer.start.getTime()) ||
      (endMoved && stored.endAt.getTime() !== outer.end.getTime())
    )
      throw new BadRequestException(err('err.calendar.chainInnerEdge'));
  }
  return bounds([...chain.filter(s => s.id !== editedId), edited]);
}

/** Найраніший початок і найпізніше завершення записів (межі ланцюжка). */
export function bounds(parts: readonly TimeSegment[]): { start: Date; end: Date } {
  return {
    start: new Date(Math.min(...parts.map(s => s.startAt.getTime()))),
    end: new Date(Math.max(...parts.map(s => s.endAt.getTime()))),
  };
}

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
