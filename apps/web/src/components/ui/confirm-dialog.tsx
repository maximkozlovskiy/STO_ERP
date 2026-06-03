'use client';

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
  confirmLabel = 'Так',
  cancelLabel = 'Скасувати',
  variant = 'default',
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  // Bug #ANIM-1: НЕ робимо `if (!open) return null` — Modal сам тримає DOM
  // на час exit-анімації через useAnimatedPresence. Раннє null-повернення
  // тут скидало state без анімації виходу.
  return (
    <Modal open={open} onClose={onCancel ?? (() => {})} title={title} size="sm">
      {message && <p className="text-sm text-muted-foreground mb-4">{message}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onCancel}>
          {cancelLabel}
        </Button>
        <Button variant={variant === 'destructive' ? 'destructive' : 'default'} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}
