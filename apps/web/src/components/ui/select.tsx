'use client';

import { forwardRef, type SelectHTMLAttributes } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  errorMessage?: string;
  hint?: string;
}

const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, label, errorMessage, hint, id, children, ...props }, ref) => {
    const selectId = id ?? label?.toLowerCase().replace(/\s+/g, '-');
    const hasError = !!errorMessage;

    return (
      <div className="flex flex-col gap-1">
        {label && (
          <label
            htmlFor={selectId}
            className="text-[13px] font-medium text-foreground leading-none"
          >
            {label}
            {props.required && <span className="ml-0.5 text-destructive">*</span>}
          </label>
        )}
        <div className="relative">
          <select
            ref={ref}
            id={selectId}
            className={cn(
              'h-9 w-full appearance-none rounded-(--radius) border text-[14px] text-foreground',
              'bg-white px-3 py-2 pr-8 outline-none transition-all duration-150',
              'border-(--color-border)',
              'hover:border-border-hover',
              'focus:border-(--color-primary) focus:ring-3 focus:ring-brand-100',
              'disabled:bg-(--color-secondary) disabled:opacity-60 disabled:cursor-not-allowed',
              hasError && 'border-destructive focus:ring-[hsl(0_86%_93%)]',
              className,
            )}
            aria-invalid={hasError}
            aria-describedby={hasError ? `${selectId}-error` : hint ? `${selectId}-hint` : undefined}
            {...props}
          >
            {children}
          </select>
          <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        </div>
        {hasError && (
          <p id={`${selectId}-error`} className="text-[12px] text-destructive leading-tight">
            {errorMessage}
          </p>
        )}
        {!hasError && hint && (
          <p id={`${selectId}-hint`} className="text-[12px] text-muted-foreground leading-tight">
            {hint}
          </p>
        )}
      </div>
    );
  },
);
Select.displayName = 'Select';

export { Select };
export type { SelectProps };
