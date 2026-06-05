import { cn } from '@/lib/utils';
import type { HTMLAttributes } from 'react';

interface TableContainerProps extends HTMLAttributes<HTMLDivElement> {
  constrainWidth?: boolean;
}

/**
 * Table container where the scrollbar track starts below thead.
 *
 * Uses `-webkit-scrollbar-track { margin-top: 33px }` (defined in globals.css
 * under `.table-scroll-container`) to offset the track below the sticky thead.
 * The 33px matches the thead row height (py-2 + text-[11px] line ≈ 33px).
 *
 * @example
 * <div className="flex flex-1 min-h-0">
 *   <TableContainer>
 *     <Table>
 *       <TableHeader>...</TableHeader>
 *       <TableBody>...</TableBody>
 *     </Table>
 *   </TableContainer>
 * </div>
 */
export function TableContainer({
  className,
  children,
  constrainWidth = true,
}: TableContainerProps) {
  return (
    <div
      className={cn(
        'table-scroll-container',
        'flex-1 min-h-0',
        constrainWidth && 'min-w-0',
        'overflow-auto border border-border rounded-xl',
        className,
      )}
    >
      {children}
    </div>
  );
}
