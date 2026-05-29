'use client';

import { useState, useCallback, useEffect, useRef } from 'react';

interface UseDirtyFormOptions {
  enabled?: boolean;
}

/**
 * Tracks unsaved changes and shows a ConfirmDialog before closing.
 *
 * Usage:
 *   const { isDirty, markDirty, resetDirty, confirmClose } = useDirtyForm({ enabled: features.unsavedGuardEnabled });
 *
 *   // On field change:
 *   dirty.markDirty()
 *
 *   // Before closing (async — await required):
 *   const closeModal = async () => {
 *     if (!(await dirty.confirmClose())) return;
 *     setShowModal(false);
 *   };
 *
 *   // In Modal onClose — wrap in async arrow:
 *   <Modal onClose={async () => { if (!(await dirty.confirmClose())) return; setModal(false); }} />
 *
 *   // Render confirm dialog in JSX:
 *   <DirtyConfirmDialog {...dirty.dialogProps} />
 */
export function useDirtyForm({ enabled = true }: UseDirtyFormOptions = {}) {
  const [isDirty, setIsDirty] = useState(false);
  const isDirtyRef = useRef(false);

  // Dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const resolveRef = useRef<((ok: boolean) => void) | null>(null);

  const markDirty = useCallback(() => {
    setIsDirty(true);
    isDirtyRef.current = true;
  }, []);

  const resetDirty = useCallback(() => {
    setIsDirty(false);
    isDirtyRef.current = false;
  }, []);

  /** Returns Promise<true> if safe to close (no unsaved changes or user confirmed). */
  const confirmClose = useCallback((): Promise<boolean> => {
    if (!enabled || !isDirtyRef.current) return Promise.resolve(true);
    return new Promise<boolean>(resolve => {
      resolveRef.current = resolve;
      setDialogOpen(true);
    });
  }, [enabled]);

  const handleConfirm = useCallback(() => {
    setDialogOpen(false);
    resolveRef.current?.(true);
    resolveRef.current = null;
  }, []);

  const handleCancel = useCallback(() => {
    setDialogOpen(false);
    resolveRef.current?.(false);
    resolveRef.current = null;
  }, []);

  // Props to spread on <DirtyConfirmDialog>
  const dialogProps = { open: dialogOpen, onConfirm: handleConfirm, onCancel: handleCancel };

  // Warn on browser tab close
  useEffect(() => {
    if (!enabled) return;
    const handler = (e: BeforeUnloadEvent) => {
      if (!isDirtyRef.current) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [enabled]);

  return { isDirty, markDirty, resetDirty, confirmClose, dialogProps };
}
