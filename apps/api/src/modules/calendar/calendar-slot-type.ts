import { BadRequestException } from '@nestjs/common';
import { CalendarSlotType } from '@prisma/client';
import { err } from '../../common/utils/err';

/** Прив'язки запису до клієнта, автомобіля чи наряду; `null` — зняти прив'язку. */
export interface SlotLinks {
  workOrderId?: string | null | undefined;
  counterpartyId?: string | null | undefined;
  vehicleId?: string | null | undefined;
}

/**
 * BR-CAL-003: службовий запис (обслуговування, перерва, нарада — будь-який тип, крім «Робота»)
 * не прив'язується до клієнта, автомобіля чи наряду — при створенні, зміні й перев'язці (і з
 * планшета). Порожнє значення чи `null` дозволено; тип без значення — «Робота» (типовий).
 */
export function assertServiceSlotUnlinked(
  type: CalendarSlotType | null | undefined,
  links: SlotLinks,
): void {
  if (!type || type === CalendarSlotType.WORK) return;
  if (links.workOrderId || links.counterpartyId || links.vehicleId)
    throw new BadRequestException(err('err.calendar.serviceSlotNoClient'));
}
