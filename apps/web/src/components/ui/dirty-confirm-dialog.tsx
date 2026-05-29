'use client';

import { ConfirmDialog } from './confirm-dialog';

interface DirtyConfirmDialogProps {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Drop-in dialog for useDirtyForm — spread dirty.dialogProps */
export function DirtyConfirmDialog({ open, onConfirm, onCancel }: DirtyConfirmDialogProps) {
  return (
    <ConfirmDialog
      open={open}
      title="Є незбережені зміни"
      message="Покинути без збереження?"
      confirmLabel="Покинути"
      variant="destructive"
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}
