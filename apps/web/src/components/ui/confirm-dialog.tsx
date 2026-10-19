'use client';

import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from './modal';
import { Button } from './button';

interface ConfirmDialogProps {
  open: boolean;
  title?: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'default' | 'destructive';
  onConfirm?: () => void;
  onCancel?: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel: confirmLabelProp,
  cancelLabel: cancelLabelProp,
  variant = 'default',
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  // Bug #911: типові підписи — з локалі («Так» / «Скасувати», «Yes» / «Cancel»).
  const { t } = useTranslation('common');
  const confirmLabel = confirmLabelProp ?? t('yes');
  const cancelLabel = cancelLabelProp ?? t('cancel');
  // Зберігаємо останній відкритий стан щоб контент не зникав під час exit-анімації
  const lastRef = useRef({ title, message, confirmLabel, cancelLabel, variant });
  if (open) lastRef.current = { title, message, confirmLabel, cancelLabel, variant };
  const c = lastRef.current;

  return (
    <Modal open={open} onClose={onCancel ?? (() => {})} title={c.title} size="sm">
      {c.message && <p className="text-sm text-muted-foreground mb-4">{c.message}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onCancel}>
          {c.cancelLabel}
        </Button>
        <Button
          variant={c.variant === 'destructive' ? 'destructive' : 'default'}
          onClick={onConfirm}
        >
          {c.confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}
