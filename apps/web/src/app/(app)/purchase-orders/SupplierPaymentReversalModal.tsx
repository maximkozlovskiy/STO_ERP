'use client';

import { useTranslation } from 'react-i18next';
import { useReverseSupplierPayment } from '@/hooks/api/useSupplierPayments';
import {
  ReversalReasonModal,
  type PaymentReversalTarget,
} from '@/components/ui/PaymentReversalModal';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Оплата; батько тримає її й після закриття, щоб вміст не зникав під час анімації виходу. */
  payment: PaymentReversalTarget | null;
}

/**
 * Сторно банківської оплати постачальнику з причиною (BR-SUPPAY-017) — спільна картка сторно
 * (`ReversalReasonModal`) із запитом `POST /supplier-payments/:id/reverse` і текстами постачальника.
 * Відмову сервера (оплата з каси, рядок виписки рознесено на оплату) картка показує банером.
 */
export function SupplierPaymentReversalModal({ open, onClose, payment }: Props) {
  const { t } = useTranslation('supplierPayments');
  const reverse = useReverseSupplierPayment();
  const amount = payment?.amountText ?? '';
  return (
    <ReversalReasonModal
      open={open}
      onClose={onClose}
      payment={payment}
      reverse={args => reverse.mutateAsync(args)}
      pending={reverse.isPending}
      texts={{
        title: t('list.reversal.title'),
        partyLabel: t('list.reversal.party'),
        consequences: [
          t('list.reversal.consequence.common', { amount }),
          t('list.reversal.consequence.bankLine'),
          t('list.reversal.consequence.money'),
        ],
        reasonPlaceholder: t('list.reversal.reasonPlaceholder'),
        success: t('list.reversal.success'),
        error: t('list.reversal.error'),
      }}
    />
  );
}
