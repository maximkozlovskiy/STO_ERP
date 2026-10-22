'use client';

import { ConfirmDialog } from './confirm-dialog';
import { useTranslation } from 'react-i18next';

interface DirtyConfirmDialogProps {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Drop-in dialog for useDirtyForm — spread dirty.dialogProps */
export function DirtyConfirmDialog({ open, onConfirm, onCancel }: DirtyConfirmDialogProps) {
  const { t } = useTranslation('common');
  return (
    <ConfirmDialog
      open={open}
      title={t('dirtyConfirm.title')}
      message={t('dirtyConfirm.message')}
      confirmLabel={t('dirtyConfirm.confirm')}
      variant="destructive"
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}
