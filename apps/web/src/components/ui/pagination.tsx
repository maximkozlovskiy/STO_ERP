'use client';

import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';
import { cn } from '@/lib/utils';

interface PaginationProps {
  page: number;
  totalPages: number;
  onChange: (page: number) => void;
  className?: string;
}

/**
 * Windowed pagination with First / Prev / [pages] / Next / Last buttons.
 * Shows up to 7 page numbers around the current page; collapses distant pages with "…".
 * Returns null when totalPages <= 1.
 */
export function Pagination({ page, totalPages, onChange, className }: PaginationProps) {
  if (totalPages <= 1) return null;

  // Build the window: always show first, last, current ±2, fill with ellipsis
  const pages: (number | '…')[] = [];
  const WINDOW = 2;

  for (let p = 1; p <= totalPages; p++) {
    if (p === 1 || p === totalPages || (p >= page - WINDOW && p <= page + WINDOW)) {
      pages.push(p);
    } else if (pages[pages.length - 1] !== '…') {
      pages.push('…');
    }
  }

  const btnBase =
    'inline-flex items-center justify-center h-8 min-w-8 px-1 rounded-lg text-[13px] font-medium border transition-colors select-none';
  const btnPage = cn(
    btnBase,
    'border-border text-muted-foreground bg-surface hover:bg-secondary hover:text-foreground',
  );
  const btnActive = cn(btnBase, 'border-primary bg-primary text-primary-foreground cursor-default');
  const btnNav = cn(
    btnBase,
    'border-border text-muted-foreground bg-surface hover:bg-secondary hover:text-foreground disabled:opacity-40 disabled:pointer-events-none',
  );

  return (
    <div className={cn('shrink-0 flex items-center justify-center gap-1 pt-1', className)}>
      {/* First */}
      <button
        type="button"
        onClick={() => onChange(1)}
        disabled={page === 1}
        className={btnNav}
        title="Перша сторінка"
        aria-label="Перша сторінка"
      >
        <ChevronsLeft className="h-4 w-4" />
      </button>

      {/* Prev */}
      <button
        type="button"
        onClick={() => onChange(page - 1)}
        disabled={page === 1}
        className={btnNav}
        title="Попередня сторінка"
        aria-label="Попередня сторінка"
      >
        <ChevronLeft className="h-4 w-4" />
      </button>

      {/* Page numbers */}
      {pages.map((p, i) =>
        p === '…' ? (
          <span
            key={`ellipsis-${i}`}
            className="inline-flex items-center justify-center h-8 w-6 text-[13px] text-muted-foreground select-none"
          >
            …
          </span>
        ) : (
          <button
            key={p}
            type="button"
            onClick={() => p !== page && onChange(p)}
            className={p === page ? btnActive : btnPage}
            aria-current={p === page ? 'page' : undefined}
          >
            {p}
          </button>
        ),
      )}

      {/* Next */}
      <button
        type="button"
        onClick={() => onChange(page + 1)}
        disabled={page === totalPages}
        className={btnNav}
        title="Наступна сторінка"
        aria-label="Наступна сторінка"
      >
        <ChevronRight className="h-4 w-4" />
      </button>

      {/* Last */}
      <button
        type="button"
        onClick={() => onChange(totalPages)}
        disabled={page === totalPages}
        className={btnNav}
        title="Остання сторінка"
        aria-label="Остання сторінка"
      >
        <ChevronsRight className="h-4 w-4" />
      </button>
    </div>
  );
}
