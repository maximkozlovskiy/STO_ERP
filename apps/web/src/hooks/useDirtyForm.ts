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

  // Value-based baseline (fingerprint of "clean" form state). Coupled with
  // syncDirty() this replaces the fragile time-gated `baselineReadyRef +
  // setTimeout(0)` approach: dirtiness is decided by comparing VALUES, not by a
  // race between a macrotask flag flip and React's deferred passive-effect
  // flush. A re-render that hands `form` a new object reference with identical
  // values no longer produces a false «Є незбережені зміни» prompt.
  const baselineRef = useRef<string | null>(null);

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
    baselineRef.current = null;
  }, []);

  /**
   * Records the current serialized form state as the "clean" baseline.
   * Call once after reset (create) or after data load (edit) has settled.
   * Snapshot must be a stable serialization of the meaningful fields
   * (e.g. JSON.stringify({ ...form, lines })).
   */
  const captureBaseline = useCallback((snapshot: string) => {
    baselineRef.current = snapshot;
    setIsDirty(false);
    isDirtyRef.current = false;
  }, []);

  /**
   * Recomputes dirtiness by comparing the current snapshot against the captured
   * baseline. No-op until a baseline is captured (guards the pre-baseline
   * window). Immune to reference-only churn and to macrotask/microtask ordering
   * races, so a clean form never false-positives.
   */
  const syncDirty = useCallback((snapshot: string) => {
    if (baselineRef.current === null) return;
    const nextDirty = snapshot !== baselineRef.current;
    isDirtyRef.current = nextDirty;
    setIsDirty(nextDirty);
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

  return {
    isDirty,
    markDirty,
    resetDirty,
    captureBaseline,
    syncDirty,
    confirmClose,
    dialogProps,
  };
}
