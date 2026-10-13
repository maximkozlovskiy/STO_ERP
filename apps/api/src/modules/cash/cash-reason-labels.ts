import type { CashOperationReason } from '@prisma/client';
import { CASH_REASON_LABELS } from '@sto/shared';

/**
 * Назва приводу для ТЕКСТІВ ПОМИЛОК api. Перелік назв — `CASH_REASON_LABELS` у `@sto/shared`
 * (єдине джерело; web-каталог `cash.json` зведено з ним тестом-інваріантом).
 */
export function cashReasonLabel(reason: CashOperationReason, locale: string): string {
  const labels = locale === 'en' ? CASH_REASON_LABELS.en : CASH_REASON_LABELS.uk;
  return labels[reason] ?? reason;
}
