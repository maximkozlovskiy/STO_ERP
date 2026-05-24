'use client';

import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

type Variant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'destructive' | 'link';
type Size    = 'xs' | 'sm' | 'md' | 'lg' | 'icon-xs' | 'icon-sm' | 'icon';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
}

const base =
  'inline-flex items-center justify-center gap-2 font-medium select-none whitespace-nowrap ' +
  'rounded-[var(--radius)] transition-all duration-150 ' +
  'disabled:opacity-50 disabled:pointer-events-none ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-ring)]';

const variants: Record<Variant, string> = {
  primary:
    'bg-[var(--color-primary)] text-white shadow-[0_1px_2px_rgb(0_0_0/0.12)] ' +
    'hover:bg-[var(--color-primary-hover)] active:scale-[0.98]',
  secondary:
    'bg-[var(--color-secondary)] text-[var(--color-secondary-foreground)] ' +
    'hover:bg-[hsl(210_40%_92%)] active:scale-[0.98]',
  outline:
    'border border-[var(--color-border)] bg-white text-[var(--color-foreground)] ' +
    'hover:bg-[var(--color-secondary)] hover:border-[var(--color-border-hover)] active:scale-[0.98]',
  ghost:
    'text-[var(--color-foreground-muted)] ' +
    'hover:bg-[var(--color-secondary)] hover:text-[var(--color-foreground)] active:scale-[0.98]',
  destructive:
    'bg-[var(--color-destructive)] text-white shadow-[0_1px_2px_rgb(0_0_0/0.12)] ' +
    'hover:bg-[hsl(0_84%_52%)] active:scale-[0.98]',
  link:
    'text-[var(--color-primary)] underline-offset-4 hover:underline p-0 h-auto',
};

const sizes: Record<Size, string> = {
  xs:        'h-6   px-2   text-[11px]',
  sm:        'h-8   px-3   text-[13px]',
  md:        'h-9   px-4   text-[14px]',
  lg:        'h-11  px-5   text-[15px]',
  'icon-xs': 'h-6   w-6    p-0',
  'icon-sm': 'h-8   w-8    p-0',
  'icon':    'h-9   w-9    p-0',
};

const BtnSpinner = ({ sm }: { sm?: boolean }) => (
  <svg className={cn('animate-spin shrink-0', sm ? 'h-3.5 w-3.5' : 'h-4 w-4')}
    xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
  </svg>
);

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'primary', size = 'md', loading, leftIcon, rightIcon, children, disabled, ...props }, ref) => (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(base, variants[variant], sizes[size], className)}
      {...props}
    >
      {loading
        ? <BtnSpinner sm={size === 'sm' || size === 'xs'} />
        : leftIcon
          ? <span className="shrink-0 [&>svg]:h-4 [&>svg]:w-4">{leftIcon}</span>
          : null}
      {children}
      {!loading && rightIcon && (
        <span className="shrink-0 [&>svg]:h-4 [&>svg]:w-4">{rightIcon}</span>
      )}
    </button>
  ),
);
Button.displayName = 'Button';

export { Button };
export type { ButtonProps, Variant as ButtonVariant, Size as ButtonSize };
