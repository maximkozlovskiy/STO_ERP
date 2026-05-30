import type { HTMLAttributes, ThHTMLAttributes, TdHTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/utils';

// ─── Base table (existing, unchanged) ────────────────────────────────────────

function Table({ className, children, ...props }: HTMLAttributes<HTMLTableElement>) {
  return (
    <div className="w-full overflow-auto rounded-lg border border-border">
      <table className={cn('w-full text-[13px] text-foreground border-collapse', className)} {...props}>
        {children}
      </table>
    </div>
  );
}

function TableHeader({ className, children, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <thead className={cn('bg-secondary border-b border-border', className)} {...props}>
      {children}
    </thead>
  );
}

function TableBody({ className, children, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <tbody className={cn('divide-y divide-border bg-surface', className)} {...props}>
      {children}
    </tbody>
  );
}

function TableRow({ className, children, onClick, ...props }: HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr
      className={cn(
        'transition-colors duration-100',
        onClick && 'cursor-pointer hover:bg-secondary active:bg-muted',
        !onClick && 'hover:bg-secondary/50',
        className,
      )}
      onClick={onClick}
      {...props}
    >
      {children}
    </tr>
  );
}

function TableHead({ className, children, ...props }: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={cn(
        'px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-[0.06em]',
        'text-foreground-muted whitespace-nowrap',
        className,
      )}
      {...props}
    >
      {children}
    </th>
  );
}

function TableCell({ className, children, ...props }: TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td className={cn('px-4 py-3 align-middle', className)} {...props}>
      {children}
    </td>
  );
}

function TableCaption({ className, children, ...props }: HTMLAttributes<HTMLTableCaptionElement>) {
  return (
    <caption className={cn('mt-2 text-[12px] text-muted-foreground', className)} {...props}>
      {children}
    </caption>
  );
}

// ─── DataTable — new pattern from design spec ─────────────────────────────────
//
// Variants:
//   1. Compact zebra   — dark header, alternating rows, no gaps
//   2. Grouped rows    — dark header, primary-colored group headers, rows nested below
//   3. With footer     — dark header + dark footer with totals
//
// Usage:
//   <DataTable columns={[{ key, label, align?, width? }]} rows={items} footer={[...]} />
//   <DataTable columns={...} groups={[{ label, count, rows }]} />

export interface DataTableColumn {
  key: string;
  label: string;
  align?: 'left' | 'right' | 'center';
  width?: string;
}

export interface DataTableFooterCell {
  key: string;
  value: ReactNode;
  align?: 'left' | 'right' | 'center';
}

interface DataTableRowProps {
  id: string;
  [key: string]: ReactNode;
}

interface DataTableGroupProps {
  key: string;
  label: string;
  count?: number;
  rows: DataTableRowProps[];
  defaultOpen?: boolean;
}

interface DataTableProps {
  columns: DataTableColumn[];
  rows?: DataTableRowProps[];
  groups?: DataTableGroupProps[];
  footer?: DataTableFooterCell[];
  onRowClick?: (row: DataTableRowProps) => void;
  selectable?: boolean;
  selectedIds?: Set<string>;
  onSelectRow?: (id: string) => void;
  onSelectAll?: () => void;
  className?: string;
  emptyText?: string;
}

function DataTableHeaderRow({
  columns,
  selectable,
  allSelected,
  someSelected,
  onSelectAll,
}: {
  columns: DataTableColumn[];
  selectable?: boolean;
  allSelected?: boolean;
  someSelected?: boolean;
  onSelectAll?: () => void;
}) {
  return (
    <thead>
      <tr className="bg-[hsl(222_47%_18%)] dark:bg-[hsl(222_47%_12%)]">
        {selectable && (
          <th className="w-10 px-4 py-3">
            <input
              type="checkbox"
              checked={allSelected}
              ref={el => { if (el) el.indeterminate = !!someSelected && !allSelected; }}
              onChange={onSelectAll}
              className="h-3.5 w-3.5 accent-primary rounded"
            />
          </th>
        )}
        {columns.map(col => (
          <th
            key={col.key}
            style={col.width ? { width: col.width } : undefined}
            className={cn(
              'px-4 py-3 text-[12px] font-semibold text-white whitespace-nowrap',
              col.align === 'right' && 'text-right',
              col.align === 'center' && 'text-center',
              !col.align && 'text-left',
            )}
          >
            {col.label}
          </th>
        ))}
      </tr>
    </thead>
  );
}

function DataTableBodyRow({
  row,
  columns,
  selectable,
  selected,
  onSelect,
  onClick,
}: {
  row: DataTableRowProps;
  columns: DataTableColumn[];
  selectable?: boolean;
  selected?: boolean;
  onSelect?: () => void;
  onClick?: (row: DataTableRowProps) => void;
}) {
  return (
    <tr
      className={cn(
        'border-b border-border transition-colors',
        onClick && 'cursor-pointer hover:bg-secondary',
        selected && 'bg-primary/5',
      )}
      onClick={onClick ? () => onClick(row) : undefined}
    >
      {selectable && (
        <td className="w-10 px-4 py-3">
          <input
            type="checkbox"
            checked={selected}
            onChange={e => { e.stopPropagation(); onSelect?.(); }}
            onClick={e => e.stopPropagation()}
            className="h-3.5 w-3.5 accent-primary rounded"
          />
        </td>
      )}
      {columns.map(col => (
        <td
          key={col.key}
          className={cn(
            'px-4 py-3 text-[13px] text-foreground align-middle',
            col.align === 'right' && 'text-right tabular-nums',
            col.align === 'center' && 'text-center',
          )}
        >
          {row[col.key] as ReactNode}
        </td>
      ))}
    </tr>
  );
}

function DataTableGroupRow({
  group,
  columns,
  selectable,
  selectedIds,
  onSelectRow,
  onRowClick,
}: {
  group: DataTableGroupProps;
  columns: DataTableColumn[];
  selectable?: boolean;
  selectedIds?: Set<string>;
  onSelectRow?: (id: string) => void;
  onRowClick?: (row: DataTableRowProps) => void;
}) {
  const colSpan = columns.length + (selectable ? 1 : 0);
  return (
    <>
      {/* Group header row */}
      <tr className="bg-primary">
        <td colSpan={colSpan} className="px-4 py-2.5">
          <div className="flex items-center gap-2">
            {selectable && (
              <input type="checkbox" className="h-3.5 w-3.5 accent-white rounded" />
            )}
            <span className="text-[13px] font-medium text-white">
              {group.label}
              {group.count != null && (
                <span className="ml-1.5 opacity-75">({group.count})</span>
              )}
            </span>
          </div>
        </td>
      </tr>
      {/* Group body rows */}
      {group.rows.map(row => (
        <DataTableBodyRow
          key={row.id as string}
          row={row}
          columns={columns}
          selectable={selectable}
          selected={selectedIds?.has(row.id as string)}
          onSelect={() => onSelectRow?.(row.id as string)}
          onClick={onRowClick}
        />
      ))}
    </>
  );
}

function DataTable({
  columns,
  rows,
  groups,
  footer,
  onRowClick,
  selectable,
  selectedIds,
  onSelectRow,
  onSelectAll,
  className,
  emptyText = 'Нічого не знайдено',
}: DataTableProps) {
  const allSelected = !!(rows && selectedIds && rows.length > 0 && rows.every(r => selectedIds.has(r.id as string)));
  const someSelected = !!(rows && selectedIds && rows.some(r => selectedIds.has(r.id as string)));

  return (
    <div className={cn('w-full overflow-auto rounded-xl border border-border', className)}>
      <table className="w-full border-collapse">
        <DataTableHeaderRow
          columns={columns}
          selectable={selectable}
          allSelected={allSelected}
          someSelected={someSelected}
          onSelectAll={onSelectAll}
        />

        <tbody className="bg-surface">
          {/* Flat rows */}
          {rows && rows.length === 0 && (
            <tr>
              <td
                colSpan={columns.length + (selectable ? 1 : 0)}
                className="px-4 py-10 text-center text-[13px] text-muted-foreground"
              >
                {emptyText}
              </td>
            </tr>
          )}
          {rows && rows.map(row => (
            <DataTableBodyRow
              key={row.id as string}
              row={row}
              columns={columns}
              selectable={selectable}
              selected={selectedIds?.has(row.id as string)}
              onSelect={() => onSelectRow?.(row.id as string)}
              onClick={onRowClick}
            />
          ))}

          {/* Grouped rows */}
          {groups && groups.map(group => (
            <DataTableGroupRow
              key={group.key}
              group={group}
              columns={columns}
              selectable={selectable}
              selectedIds={selectedIds}
              onSelectRow={onSelectRow}
              onRowClick={onRowClick}
            />
          ))}
        </tbody>

        {/* Footer */}
        {footer && footer.length > 0 && (
          <tfoot>
            <tr className="bg-[hsl(222_47%_18%)] dark:bg-[hsl(222_47%_12%)]">
              {selectable && <td className="w-10" />}
              {columns.map((col, idx) => {
                const cell = footer.find(f => f.key === col.key);
                return (
                  <td
                    key={col.key}
                    className={cn(
                      'px-4 py-3 text-[13px] font-semibold text-white',
                      idx === 0 && 'font-bold',
                      (cell?.align ?? col.align) === 'right' && 'text-right tabular-nums',
                      (cell?.align ?? col.align) === 'center' && 'text-center',
                    )}
                  >
                    {cell?.value ?? null}
                  </td>
                );
              })}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

export {
  // Base components (backward compat)
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell, TableCaption,
  // New DataTable
  DataTable,
};
