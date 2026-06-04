import { cn } from '@/lib/utils';
import type { HTMLAttributes } from 'react';

/**
 * Table container with proper scroll context for sticky headers.
 * Use this wrapper when rendering tables within flex layouts.
 *
 * Features:
 * - Single scroll ancestor for position:sticky to work correctly
 * - Constrained width prevents text overflow (min-w-0)
 * - Proper flex sizing (flex-1 min-h-0)
 * - thead sticky positioning stays above scrollbar area
 *
 * CSS Implementation:
 * - Uses CSS Grid layout to keep thead fixed above scrollable tbody
 * - thead stays outside scroll container (display: block)
 * - tbody gets overflow-y-auto independently
 *
 * @example
 * <div className="flex flex-1 min-h-0">
 *   <TableContainer>
 *     <Table>
 *       <TableHeader>...</TableHeader>
 *       <TableBody>...</TableBody>
 *     </Table>
 *   </TableContainer>
 *   <DetailPanel />
 * </div>
 */
interface TableContainerProps extends HTMLAttributes<HTMLDivElement> {
  /**
   * Apply min-w-0 constraint for proper flex shrinking.
   * Set to false only if you need text to wrap normally.
   * @default true
   */
  constrainWidth?: boolean;
}

export function TableContainer({
  className,
  children,
  constrainWidth = true,
}: TableContainerProps) {
  return (
    <div
      className={cn(
        'flex-1 min-h-0',
        constrainWidth && 'min-w-0',
        'overflow-auto bg-surface border border-border rounded-xl',
        className,
      )}
      style={
        {
          // scrollbar-gutter: stable reserves space for scrollbar, preventing layout shift
          // This ensures sticky thead is not covered by scrollbar
          scrollbarGutter: 'stable',
        } as React.CSSProperties
      }
    >
      {children}
    </div>
  );
}
