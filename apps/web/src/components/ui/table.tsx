import type { HTMLAttributes, ThHTMLAttributes, TdHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

function Table({ className, children, ...props }: HTMLAttributes<HTMLTableElement>) {
  return (
    <div className="w-full overflow-auto rounded-lg border border-border">
      <table
        className={cn('w-full text-[13px] text-foreground border-collapse', className)}
        {...props}
      >
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

function TableCell({ className, children, ...props }: TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td className={cn('px-4 py-2 align-middle', className)} {...props}>
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

export { Table, TableHeader, TableBody, TableRow, TableHead, TableCell, TableCaption };
