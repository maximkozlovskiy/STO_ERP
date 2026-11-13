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

/** Найраніший початок і найпізніше завершення записів (межі ланцюжка). */
export function bounds(parts: readonly TimeSegment[]): { start: Date; end: Date } {
  return {
    start: new Date(Math.min(...parts.map(s => s.startAt.getTime()))),
    end: new Date(Math.max(...parts.map(s => s.endAt.getTime()))),
  };
}
