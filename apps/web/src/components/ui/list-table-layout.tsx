'use client';

import type { ReactNode } from 'react';
import { ListBulkActions, type BulkAction } from './bulk-actions-bar';
import { Table } from './table';
import { TableContainer } from './table-container';

interface ListTableLayoutProps {
  /** Стан списку (`useListPage()`): чи увімкнені масові дії. */
  list: { features: { bulkActionsEnabled: boolean } };
  /** Масовий вибір (`useBulkSelect`). */
  bulk: { count: number; selected: ReadonlySet<string>; clear: () => void };
  bulkActions: BulkAction[];
  /** Бокова панель вибраного рядка — праворуч від таблиці. */
  panel?: ReactNode;
  /** Шапка й тіло таблиці. */
  children: ReactNode;
}

/**
 * Каркас таблиці списку документів: панель масових дій, таблиця в картці з прокруткою і бокова
 * панель праворуч. Шапку (`ListTableHeader`) і рядки сторінка передає всередину.
 */
export function ListTableLayout({
  list,
  bulk,
  bulkActions,
  panel,
  children,
}: ListTableLayoutProps) {
  return (
    <>
      <ListBulkActions list={list} bulk={bulk} actions={bulkActions} />
      <div className="flex flex-1 min-h-0">
        <TableContainer>
          <Table>{children}</Table>
        </TableContainer>
        {panel}
      </div>
    </>
  );
}
