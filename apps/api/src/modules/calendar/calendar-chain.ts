import { BadRequestException } from '@nestjs/common';
import { err } from '../../common/utils/err';
import type { TimeSegment } from '../../common/utils/work-hours';

/**
 * Межі ланцюжка запису календаря (якір і продовження) — спільні для запису наряду (BR-WO-024,
 * `WorkOrdersService`) і ручного запису (BR-CAL-020, `CalendarService.updateSlot`), без звернень
 * до БД.
 */

/**
 * Межі ланцюжка (якір і продовження), коли запис `editedId` отримав проміжок `edited`:
 * найраніший початок і найпізніше завершення. Тому зміна меж крайнього запису змінює тривалість
 * ланцюжка (для наряду — його планові дати). Внутрішню межу багатоденного ланцюжка (кінець не
 * останнього дня, початок продовження) ставлять робочі години (BR-WO-020, BR-CAL-007) — її зміна
 * 400 `err.calendar.chainInnerEdge` (BR-WO-024, BR-CAL-020; TECH-DEBT (б) №66, №92).
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

/**
 * Розпочатий запис (BR-CAL-020, BR-WO-024; рішення власника 2026-11-14, TECH-DEBT (б) №97): початок
 * ланцюжка (`storedStart` — початок першої частини), що вже минув, не змінюється — ні перенесенням,
 * ні ручкою, ні формою; 400 `err.calendar.chainStarted`. Кінець останнього дня змінюється.
 * `now` — мить перевірки (спеки підміняють час `vi.useFakeTimers`).
 */
export function assertChainStartKept(storedStart: Date, nextStart: Date, now = new Date()): void {
  if (nextStart.getTime() !== storedStart.getTime() && storedStart.getTime() < now.getTime())
    throw new BadRequestException(err('err.calendar.chainStarted'));
}

/** Час чи підйомник запису у зміні: межі запису й підйомник. */
export interface SlotTimeChange {
  startAt?: string | Date | undefined;
  endAt?: string | Date | undefined;
  liftId?: string | null | undefined;
}

const instant = (v: string | Date): number => new Date(v).getTime();

/**
 * Зміна змінює час чи підйомник запису. Порівнюється зі збереженим, а не «поле є в запиті»: форма
 * шле час і підйомник щоразу, і зміна лише примітки чи механіка лишається на записі.
 */
export function changesTimeOrLift(
  slot: { startAt: Date; endAt: Date; liftId: string | null },
  change: SlotTimeChange,
): boolean {
  return (
    (change.startAt != null && instant(change.startAt) !== slot.startAt.getTime()) ||
    (change.endAt != null && instant(change.endAt) !== slot.endAt.getTime()) ||
    (change.liftId !== undefined && (change.liftId ?? null) !== slot.liftId)
  );
}

/** Найраніший початок і найпізніше завершення записів (межі ланцюжка). */
export function bounds(parts: readonly TimeSegment[]): { start: Date; end: Date } {
  return {
    start: new Date(Math.min(...parts.map(s => s.startAt.getTime()))),
    end: new Date(Math.max(...parts.map(s => s.endAt.getTime()))),
  };
}
