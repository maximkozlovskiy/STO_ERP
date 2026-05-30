'use client';

import { useRef, useCallback } from 'react';

/**
 * Provides drag-and-drop handlers for table column headers.
 * Works together with useTableColumns.reorder().
 *
 * Usage:
 *   const { dragProps } = useColumnDrag(visibleColumns, reorder);
 *   // In JSX:
 *   <TableHead {...dragProps(col.key)}>{col.label}</TableHead>
 */
export function useColumnDrag(
  visibleColumns: { key: string }[],
  reorder: (newOrder: string[]) => void,
) {
  const dragKey = useRef<string | null>(null);
  const dragOverKey = useRef<string | null>(null);

  const dragProps = useCallback((key: string) => ({
    draggable: true as const,
    onDragStart: (e: React.DragEvent) => {
      dragKey.current = key;
      e.dataTransfer.effectAllowed = 'move';
      // Ghost image: use the th element itself
      e.dataTransfer.setDragImage(e.currentTarget, 0, 0);
    },
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      dragOverKey.current = key;
      // Highlight drop target
      (e.currentTarget as HTMLElement).dataset.dragover = 'true';
    },
    onDragLeave: (e: React.DragEvent) => {
      delete (e.currentTarget as HTMLElement).dataset.dragover;
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      delete (e.currentTarget as HTMLElement).dataset.dragover;
      const from = dragKey.current;
      const to = dragOverKey.current;
      if (!from || !to || from === to) return;

      // Reorder only within visible columns, then merge back with hidden ones
      const visibleKeys = visibleColumns.map(c => c.key);
      const fromIdx = visibleKeys.indexOf(from);
      const toIdx = visibleKeys.indexOf(to);
      if (fromIdx === -1 || toIdx === -1) return;

      visibleKeys.splice(fromIdx, 1);
      visibleKeys.splice(toIdx, 0, from);
      reorder(visibleKeys);

      dragKey.current = null;
      dragOverKey.current = null;
    },
    onDragEnd: (e: React.DragEvent) => {
      delete (e.currentTarget as HTMLElement).dataset.dragover;
      dragKey.current = null;
      dragOverKey.current = null;
    },
    style: { cursor: 'grab' } as React.CSSProperties,
  }), [visibleColumns, reorder]);

  return { dragProps };
}
