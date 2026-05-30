'use client';

import { useState, useCallback, useRef } from 'react';

export interface InlineEditState {
  rowId: string;
  field: string;
  value: string;
}

interface UseInlineEditOptions {
  enabled?: boolean;
  onSave: (rowId: string, field: string, value: string) => Promise<void>;
}

/**
 * Manages inline editing state for table cells.
 *
 * Usage:
 *   const { editing, startEdit, commitEdit, cancelEdit, isEditing } = useInlineEdit({ onSave });
 *   // In cell: onClick={() => startEdit(row.id, 'name', row.name)}
 *   // In edit cell: <InlineEditCell editing={editing} onCommit={commitEdit} onCancel={cancelEdit} />
 */
export function useInlineEdit({ enabled = true, onSave }: UseInlineEditOptions) {
  const [editing, setEditing] = useState<InlineEditState | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  const startEdit = useCallback(
    (rowId: string, field: string, value: string) => {
      if (!enabled) return;
      setEditing({ rowId, field, value });
    },
    [enabled],
  );

  const cancelEdit = useCallback(() => {
    if (savingRef.current) return;
    setEditing(null);
  }, []);

  const commitEdit = useCallback(
    async (value: string) => {
      if (!editing || savingRef.current) return;
      const trimmed = value.trim();
      if (trimmed === editing.value) {
        setEditing(null);
        return;
      }

      savingRef.current = true;
      setSaving(true);
      try {
        await onSave(editing.rowId, editing.field, trimmed);
        setEditing(null);
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    },
    [editing, onSave],
  );

  const isEditing = useCallback(
    (rowId: string, field: string) => editing?.rowId === rowId && editing?.field === field,
    [editing],
  );

  return { editing, saving, startEdit, commitEdit, cancelEdit, isEditing };
}
