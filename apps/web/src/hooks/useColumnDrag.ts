'use client';

import { useRef, useCallback, type DragEvent } from 'react';

/**
 * Provides drag-and-drop handlers for table column headers.
 * Works together with useTableColumns.reorder().
 *
 * Usage:
 *   const { dragProps } = useColumnDrag(visibleColumns, reorder, orderedColumns);
 *   // In JSX:
 *   <TableHead {...dragProps(col.key)}>{col.label}</TableHead>
 *
 * @param visibleColumns  - visible columns in current order (for drag index resolution)
 * @param reorder         - useTableColumns.reorder — expects the FULL column order array
 * @param allColumns      - orderedColumns from useTableColumns (all columns, incl. hidden)
 *                          Required to preserve hidden column positions after reorder.
 */
export function useColumnDrag(
  visibleColumns: { key: string }[],
  reorder: (newOrder: string[]) => void,
  allColumns: { key: string }[],
) {
  const dragKey = useRef<string | null>(null);
  const dragOverKey = useRef<string | null>(null);

  const dragProps = useCallback((key: string) => ({
    draggable: true as const,
    onDragStart: (e: DragEvent) => {
      dragKey.current = key;
      e.dataTransfer.effectAllowed = 'move';
      // Ghost image: use the th element itself
      e.dataTransfer.setDragImage(e.currentTarget, 0, 0);
    },
    onDragOver: (e: DragEvent) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      dragOverKey.current = key;
      // Highlight drop target
      (e.currentTarget as HTMLElement).dataset.dragover = 'true';
    },
    onDragLeave: (e: DragEvent) => {
      delete (e.currentTarget as HTMLElement).dataset.dragover;
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      delete (e.currentTarget as HTMLElement).dataset.dragover;
      const from = dragKey.current;
      const to = dragOverKey.current;
      if (!from || !to || from === to) return;

      // Reorder within visible columns, then merge hidden columns back into their
      // relative positions so hidden-column order is not lost.
      const visibleKeys = visibleColumns.map(c => c.key);
      const fromIdx = visibleKeys.indexOf(from);
      const toIdx = visibleKeys.indexOf(to);
      if (fromIdx === -1 || toIdx === -1) return;

      visibleKeys.splice(fromIdx, 1);
      visibleKeys.splice(toIdx, 0, from);

      // Rebuild the full order: interleave hidden keys at their original slots.
      // Walk allColumns to place each key: visible keys in their new reordered
      // sequence, hidden keys at the same relative slot they occupied before.
      const visibleSet = new Set(visibleKeys);
      let visibleIdx = 0;
      const fullOrder: string[] = allColumns.map(c => c.key).map(k =>
        visibleSet.has(k) ? visibleKeys[visibleIdx++] : k,
      );

      reorder(fullOrder);

      dragKey.current = null;
      dragOverKey.current = null;
    },
    onDragEnd: (e: DragEvent) => {
      delete (e.currentTarget as HTMLElement).dataset.dragover;
      dragKey.current = null;
      dragOverKey.current = null;
    },
    // cursor is handled entirely by CSS:
    //   th[draggable="true"]        { cursor: grab }
    //   th[draggable="true"]:active { cursor: grabbing }
    // No inline style — inline specificity would prevent :active from applying.
  }), [visibleColumns, reorder, allColumns]);

  return { dragProps };
}
