'use client';

import { forwardRef, type InputHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  errorMessage?: string;
  hint?: string;
  leftElement?: React.ReactNode;
  rightElement?: React.ReactNode;
}

const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, label, errorMessage, hint, leftElement, rightElement, id, ...props }, ref) => {
    const inputId = id ?? label?.toLowerCase().replace(/\s+/g, '-');
    const hasError = !!errorMessage;

    return (
      <div className="flex flex-col gap-1">
        {label && (
          <label
            htmlFor={inputId}
            className="text-[13px] font-medium text-[var(--color-foreground)] leading-none"
          >
            {label}
            {props.required && <span className="ml-0.5 text-[var(--color-destructive)]">*</span>}
          </label>
        )}
        <div className="relative flex items-center">
          {leftElement && (
            <span className="pointer-events-none absolute left-3 flex items-center text-[var(--color-muted-foreground)] [&>svg]:h-4 [&>svg]:w-4">
              {leftElement}
            </span>
          )}
          <input
            ref={ref}
            id={inputId}
            className={cn(
              'h-9 w-full rounded-[var(--radius)] border text-[14px] text-[var(--color-foreground)]',
              'bg-white placeholder:text-[var(--color-muted-foreground)]',
              'px-3 py-2 outline-none transition-all duration-150',
              'border-[var(--color-border)]',
              'hover:border-[var(--color-border-hover)]',
              'focus:border-[var(--color-primary)] focus:ring-3 focus:ring-[var(--color-brand-100)]',
              'disabled:bg-[var(--color-secondary)] disabled:opacity-60 disabled:cursor-not-allowed',
              hasError && 'border-[var(--color-destructive)] focus:ring-[hsl(0_86%_93%)]',
              leftElement  && 'pl-9',
              rightElement && 'pr-9',
              className,
            )}
            aria-invalid={hasError}
            aria-describedby={hasError ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined}
            {...props}
          />
          {rightElement && (
            <span className="absolute right-3 flex items-center text-[var(--color-muted-foreground)] [&>svg]:h-4 [&>svg]:w-4">
              {rightElement}
            </span>
          )}
        </div>
        {hasError && (
          <p id={`${inputId}-error`} className="text-[12px] text-[var(--color-destructive)] leading-tight">
            {errorMessage}
          </p>
        )}
        {!hasError && hint && (
          <p id={`${inputId}-hint`} className="text-[12px] text-[var(--color-muted-foreground)] leading-tight">
            {hint}
          </p>
        )}
      </div>
    );
  },
);
Input.displayName = 'Input';

export { Input };
export type { InputProps };
