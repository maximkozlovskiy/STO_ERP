import { addDaysKyiv, kyivYmd } from '../../common/utils/kyiv-date';
import { kyivHourOnDay, type TimeSegment, type WorkHours } from '../../common/utils/work-hours';

/**
 * BR-WO-024: зміна запису календаря, що належить наряду, — через дати наряду. Чисті функції
 * шляху «запис змінено → наряд»: чи зміна його стосується, межі ланцюжка після зміни і кінець
 * запису форми, що виходить за робочий день.
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
 * записі. Перев'язка запису до іншого наряду чи відв'язка — не зміна запису наряду (як раніше).
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
 * Межі ланцюжка (якір і продовження), коли запис `editedId` отримав проміжок `edited`:
 * найраніший початок і найпізніше завершення — нові планові дати наряду. Тому зміна меж крайнього
 * запису змінює тривалість наряду, а внутрішня межа багатоденного ланцюжка — ні: її знову ставлять
 * робочі години (BR-WO-020).
 */
export function chainBounds(
  chain: readonly ({ id: string } & TimeSegment)[],
  editedId: string,
  edited: TimeSegment,
): { start: Date; end: Date } {
  const parts = [...chain.filter(s => s.id !== editedId), edited];
  return {
    start: new Date(Math.min(...parts.map(s => s.startAt.getTime()))),
    end: new Date(Math.max(...parts.map(s => s.endAt.getTime()))),
  };
}

/**
 * Кінець запису, що починається в робочий день і закінчується після його закриття: форма шле
 * «початок + тривалість» на тому ж дні, а залишок переходить на наступний день від відкриття —
 * так само, як `CalendarService.createSlot` ділить новий запис (BR-CAL-007). Запис наряду інакше
 * отримав би завершення поза робочими годинами (400 BR-WO-019).
 */
export function overflowEnd(startAt: Date, endAt: Date, hours: WorkHours): Date {
  const close = kyivHourOnDay(kyivYmd(startAt), hours.endHour);
  if (!(startAt < close && endAt > close)) return endAt;
  const nextOpen = kyivHourOnDay(kyivYmd(addDaysKyiv(startAt, 1)), hours.startHour);
  return new Date(nextOpen.getTime() + (endAt.getTime() - close.getTime()));
}
