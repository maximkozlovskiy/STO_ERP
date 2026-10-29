'use client';

import type {
  HTMLAttributes,
  MouseEvent,
  ReactNode,
  ThHTMLAttributes,
  TdHTMLAttributes,
} from 'react';
import { ArrowUp, ArrowDown, ChevronsUpDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { SortState } from '@/hooks/useSortState';

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
  TableCell,
  MoneyCell,
  MONEY_HEAD_CLASS,
  DocLink,
  DOC_LINK_CLASS,
  TableCaption,
};
