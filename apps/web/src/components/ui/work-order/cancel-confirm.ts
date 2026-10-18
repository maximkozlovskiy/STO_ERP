// BR-WO-025: підтвердження переходу наряду в «Скасовано» — однакове в картці наряду
// (`CreateWorkOrderModal`) і на сторінці наряду. Зі статусу «Виконано» скасування повертає товари
// на склад і сторнує борг клієнта (BR-WO-001, `returnPartsAndCredit`) — про це попереджає текст.

import type { TFunction } from 'i18next';
import { woStatusLabel } from '@/i18n/enumLabel';

export interface CancelConfirmOptions {
  title: string;
  message?: string;
  confirmLabel: string;
  cancelLabel: string;
  variant: 'destructive';
}

/** `t` — простір імен `workOrders`; `fromStatus` — поточний статус наряду. */
export function cancelConfirmOptions(t: TFunction, fromStatus: string): CancelConfirmOptions {
  return {
    title: t('detail.confirmTransition', { label: woStatusLabel('CANCELLED') }),
    ...(fromStatus === 'COMPLETED' && { message: t('detail.cancelCompletedWarning') }),
    confirmLabel: t('detail.cancelConfirmYes'),
    cancelLabel: t('detail.cancelConfirmNo'),
    variant: 'destructive',
  };
}
