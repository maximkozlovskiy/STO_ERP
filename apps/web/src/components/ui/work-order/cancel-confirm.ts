// BR-WO-025: підтвердження переходу наряду в «Скасовано» — однакове в картці наряду
// (`CreateWorkOrderModal`) і на сторінці наряду. Зі статусів «Виконано» й «Виставлено» (BR-WO-031)
// скасування повертає товари на склад, сторнує борг клієнта (BR-WO-001, `returnPartsAndCredit`) і
// скасовує рахунок наряду — про це попереджає текст.

import type { TFunction } from 'i18next';
import type { ConfirmOptions } from '@/hooks/useConfirm';
import { woStatusLabel } from '@/i18n/enumLabel';

/** `t` — простір імен `workOrders`; `fromStatus` — поточний статус наряду. */
export function cancelConfirmOptions(t: TFunction, fromStatus: string): ConfirmOptions {
  return {
    title: t('detail.confirmTransition', { label: woStatusLabel('CANCELLED') }),
    ...((fromStatus === 'COMPLETED' || fromStatus === 'INVOICED') && {
      message: t('detail.cancelCompletedWarning'),
    }),
    confirmLabel: t('detail.cancelConfirmYes'),
    cancelLabel: t('detail.cancelConfirmNo'),
    variant: 'destructive',
  };
}
