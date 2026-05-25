'use client';

import { useState, useCallback, useEffect, useRef } from 'react';

interface UseDirtyFormOptions {
  enabled?: boolean;
}

/**
 * Tracks whether a form has unsaved changes.
 * When enabled, warns the user before closing the modal or navigating away.
 *
 * Usage:
 *   const { isDirty, markDirty, resetDirty, confirmClose } = useDirtyForm({ enabled: features.unsavedGuardEnabled });
 *   // Call markDirty() on any form field change
 *   // Call confirmClose() before calling onClose — returns true if safe to close
 */
export function useDirtyForm({ enabled = true }: UseDirtyFormOptions = {}) {
  const [isDirty, setIsDirty] = useState(false);
  const isDirtyRef = useRef(false);

  const markDirty = useCallback(() => {
    setIsDirty(true);
    isDirtyRef.current = true;
  }, []);

  const resetDirty = useCallback(() => {
    setIsDirty(false);
    isDirtyRef.current = false;
  }, []);

  const confirmClose = useCallback((): boolean => {
    if (!enabled || !isDirtyRef.current) return true;
    return window.confirm('Є незбережені зміни. Покинути без збереження?');
  }, [enabled]);

  // Warn on browser tab/window close
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

  return { isDirty, markDirty, resetDirty, confirmClose };
}
