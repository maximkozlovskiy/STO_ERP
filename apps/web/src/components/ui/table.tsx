'use client';

import type {
  HTMLAttributes,
  MouseEvent,
  ReactNode,
  ThHTMLAttributes,
  TdHTMLAttributes,
} from 'react';
import { useEffect, useRef } from 'react';
import { ArrowUp, ArrowDown, ChevronsUpDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { SortState } from '@/hooks/useSortState';
import { Spinner } from './spinner';

/**
 * Table wrapper.
 *
 * When used inside TableContainer the outer div is overflow-auto and
 * thead is sticky top-0. The scrollbar track starts at the top of the
 * scroll container which visually overlaps thead. To prevent this,
 * TableContainer uses overflow-hidden + flex-col structure where the
 * scroll div starts below the thead row — see table-container.tsx.
 */
function Table({ className, children, ...props }: HTMLAttributes<HTMLTableElement>) {
  return (
    <table
      className={cn('w-full text-[13px] text-foreground border-collapse', className)}
      {...props}
    >
      {children}
    </table>
  );
}

function TableHeader({ className, children, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <thead
      className={cn('bg-secondary border-b border-border sticky top-0 z-10', className)}
      {...props}
    >
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
        'px-4 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.06em]',
        'text-foreground-muted whitespace-nowrap',
        className,
      )}
      {...props}
    >
      {children}
    </th>
  );
}

interface SortableHeadProps extends ThHTMLAttributes<HTMLTableCellElement> {
  sortKey: string;
  currentSort: SortState;
  onSort: (key: string) => void;
}

function SortableHead({
  sortKey,
  currentSort,
  onSort,
  children,
  className,
  ...props
}: SortableHeadProps) {
  const isActive = currentSort.sortBy === sortKey;
  return (
    <th
      className={cn(
        'px-4 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.06em]',
        'text-foreground-muted whitespace-nowrap cursor-pointer select-none group',
        'hover:text-foreground transition-colors',
        isActive && 'text-foreground',
        className,
      )}
      data-sortable="true"
      onClick={() => onSort(sortKey)}
      {...props}
    >
      <span className="inline-flex items-center gap-1">
        {children}
        {isActive ? (
          currentSort.sortDir === 'asc' ? (
            <ArrowUp className="h-3 w-3 text-primary" />
          ) : (
            <ArrowDown className="h-3 w-3 text-primary" />
          )
        ) : (
          <ChevronsUpDown className="h-3 w-3 opacity-0 group-hover:opacity-40 transition-opacity" />
        )}
      </span>
    </th>
  );
}

interface ColumnHeadProps extends ThHTMLAttributes<HTMLTableCellElement> {
  /** Ключ сортування колонки; без нього — звичайний заголовок без сортування. */
  sortKey?: string | undefined;
  currentSort: SortState;
  onSort: (key: string) => void;
}

/**
 * Заголовок колонки списку з налаштовуваними колонками: сортований, коли колонці дали `sortKey`,
 * інакше — звичайний. Одне місце замість гілки `SortableHead : TableHead` у кожному списку.
 */
function ColumnHead({ sortKey, currentSort, onSort, ...props }: ColumnHeadProps) {
  return sortKey ? (
    <SortableHead sortKey={sortKey} currentSort={currentSort} onSort={onSort} {...props} />
  ) : (
    <TableHead {...props} />
  );
}

function TableCell({ className, children, ...props }: TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td className={cn('px-4 py-2 align-middle', className)} {...props}>
      {children}
    </td>
  );
}

/**
 * Комірка суми у списку: праворуч, цифри однакової ширини і без переносу — «₴» не падає на новий
 * рядок (UX-огляд 2026-10-29). Заголовок такої колонки — `TableHead`/`SortableHead` з
 * `MONEY_HEAD_CLASS`, щоб підпис стояв над числами.
 */
function MoneyCell({ className, children, ...props }: TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td
      data-money-cell=""
      className={cn('px-4 py-2 align-middle text-right tabular-nums whitespace-nowrap', className)}
      {...props}
    >
      {children}
    </td>
  );
}

/** Заголовок колонки сум — вирівняний праворуч, як `MoneyCell`. */
const MONEY_HEAD_CLASS = 'text-right';

/** Вигляд номера документа / імені контрагента у списках — один для всіх списків. */
const DOC_LINK_CLASS =
  'text-[13px] font-semibold text-primary whitespace-nowrap hover:underline underline-offset-2 ' +
  'focus-visible:outline-none focus-visible:underline';

interface DocLinkProps {
  /** Адреса картки (`?open=<id>`) — для середньої кнопки миші й «Відкрити в новій вкладці». */
  href: string;
  /** Відкрити картку на цій сторінці. */
  onOpen: () => void;
  children: ReactNode;
  className?: string;
  title?: string;
}

/**
 * Номер документа чи ім'я контрагента в рядку списку: клік відкриває КАРТКУ, а клік по решті рядка
 * — як і раніше бічну панель (UX-огляд 2026-10-29). Справжнє посилання: Ctrl/⌘/Shift-клік і
 * середня кнопка лишаються браузеру (нова вкладка відкриє ту саму картку за адресою).
 */
function DocLink({ href, onOpen, children, className, title }: DocLinkProps) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    e.stopPropagation();
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    onOpen();
  };
  return (
    <a
      href={href}
      data-doc-link=""
      title={title}
      className={cn(DOC_LINK_CLASS, className)}
      onClick={onClick}
    >
      {children}
    </a>
  );
}

interface SelectAllHeadProps {
  /** Стан масового вибору списку (`useBulkSelect`). */
  bulk: { allSelected: boolean; someSelected: boolean; toggleAll: () => void };
  /** Доступна назва прапорця («Вибрати всі»). */
  label: string;
}

/**
 * Заголовок колонки масового вибору: прапорець «вибрати всі на сторінці». Частковий вибір
 * показує сам (`indeterminate` — лише властивість DOM, атрибута для нього немає).
 */
function SelectAllHead({ bulk, label }: SelectAllHeadProps) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = bulk.someSelected;
  }, [bulk.someSelected]);
  return (
    <TableHead className="w-9 pr-0">
      <input
        type="checkbox"
        checked={bulk.allSelected}
        ref={ref}
        onChange={bulk.toggleAll}
        className="h-3.5 w-3.5 rounded border-border"
        aria-label={label}
      />
    </TableHead>
  );
}

interface ListTableHeaderProps {
  /** Стан списку (`useListPage()`): видимі колонки, перетягування, увімкнені можливості. */
  list: {
    visibleColumns: ReadonlyArray<{ key: string; label: string }>;
    dragProps: (key: string) => ThHTMLAttributes<HTMLTableCellElement>;
    features: { bulkActionsEnabled: boolean };
  };
  /** Сортування списку (`useSortState()`). */
  sorting: { sort: SortState; toggle: (key: string) => void };
  /** Колонка → поле сортування на сервері; колонки поза мапою не сортуються. */
  sortKeys: Readonly<Partial<Record<string, string>>>;
  /** Колонки чисел/сум — підпис праворуч, над числами. */
  rightAligned?: readonly string[];
  /** Масовий вибір (`useBulkSelect`); прапорець є, лише коли масові дії увімкнені. */
  bulk: SelectAllHeadProps['bulk'];
  /** Доступна назва прапорця «вибрати всі». */
  selectAllLabel: string;
  /** Заголовок колонки дій рядка; типово порожній. */
  actionsHead?: ReactNode;
}

/**
 * Шапка таблиці списку з налаштовуваними колонками: прапорець «вибрати всі», колонки (сортовані —
 * за `sortKeys`, перетягувані), колонка дій. Одна розмітка для всіх списків документів.
 */
function ListTableHeader({
  list,
  sorting,
  sortKeys,
  rightAligned,
  bulk,
  selectAllLabel,
  actionsHead,
}: ListTableHeaderProps) {
  return (
    <TableHeader>
      <TableRow>
        {list.features.bulkActionsEnabled && <SelectAllHead bulk={bulk} label={selectAllLabel} />}
        {list.visibleColumns.map(col => (
          <ColumnHead
            key={col.key}
            sortKey={sortKeys[col.key]}
            currentSort={sorting.sort}
            onSort={sorting.toggle}
            className={rightAligned?.includes(col.key) ? MONEY_HEAD_CLASS : undefined}
            {...list.dragProps(col.key)}
          >
            {col.label}
          </ColumnHead>
        ))}
        {actionsHead ?? <TableHead />}
      </TableRow>
    </TableHeader>
  );
}

/** Рядок «завантаження» списку: спінер по центру на всю ширину таблиці. */
function TableLoadingRow({ colSpan, className }: { colSpan: number; className?: string }) {
  return (
    <TableRow>
      <TableCell colSpan={colSpan} className={cn('py-12 text-center', className)}>
        <div className="flex justify-center">
          <Spinner size="md" />
        </div>
      </TableCell>
    </TableRow>
  );
}

function TableCaption({ className, children, ...props }: HTMLAttributes<HTMLTableCaptionElement>) {
  return (
    <caption className={cn('mt-2 text-[12px] text-muted-foreground', className)} {...props}>
      {children}
    </caption>
  );
}

export {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  SortableHead,
  ColumnHead,
  TableCell,
  TableLoadingRow,
  SelectAllHead,
  ListTableHeader,
  MoneyCell,
  MONEY_HEAD_CLASS,
  DocLink,
  DOC_LINK_CLASS,
  TableCaption,
};
