import type { TFunction } from 'i18next';

/** Чому сервер зняв механіка з перетягнутого запису (BR-CAL-012, `mechanicDroppedReason`). */
export type MechanicDroppedReason = 'ON_LEAVE' | 'NOT_ON_LIFT' | 'UNAVAILABLE';

/** Відповідь `PATCH /calendar/slots/:id` з `dropMechanicNotOnLift` — лише поля зняття механіка. */
export interface MechanicDropResponse {
  mechanicDropped?: boolean;
  mechanicDroppedReason?: MechanicDroppedReason;
}

/**
 * Текст тосту «Механіка знято: …» за причиною з відповіді (рішення власника 2026-10-16, друге):
 * у відпустці — окремий текст; «не закріплений за підйомником» — лише коли справді не
 * закріплений; звільнений чи не механік — «недоступний». Відповідь без причини (старіший сервер)
 * — як раніше, «не закріплений». Ім'я — з блоку запису; звільненого механіка блок не має
 * (BR-CAL-011), тож для нього — варіант без імені.
 */
export function mechanicDroppedText(
  t: TFunction,
  reason: MechanicDroppedReason | undefined,
  name: string | null | undefined,
  lift: string,
): string {
  if (reason === 'ON_LEAVE')
    return name
      ? t('slot.mechanicDroppedOnLeave', { name })
      : t('slot.mechanicDroppedOnLeaveNoName');
  if (reason === 'UNAVAILABLE')
    return name
      ? t('slot.mechanicDroppedUnavailable', { name })
      : t('slot.mechanicDroppedUnavailableNoName');
  return name
    ? t('slot.mechanicDropped', { name, lift })
    : t('slot.mechanicDroppedNoName', { lift });
}
