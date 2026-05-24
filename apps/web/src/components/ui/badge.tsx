import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type BadgeVariant =
  | 'default' | 'secondary' | 'outline'
  | 'success' | 'warning' | 'destructive' | 'info' | 'purple';

interface BadgeProps {
  variant?: BadgeVariant;
  className?: string;
  children: ReactNode;
  dot?: boolean;
}

const variants: Record<BadgeVariant, string> = {
  default:     'bg-[var(--color-brand-100)] text-[var(--color-brand-800)] border-[var(--color-brand-200)]',
  secondary:   'bg-[var(--color-secondary)] text-[var(--color-foreground-muted)] border-transparent',
  outline:     'bg-transparent text-[var(--color-foreground-muted)] border-[var(--color-border)]',
  success:     'bg-[var(--color-success-subtle)] text-[hsl(142_71%_30%)] border-[hsl(142_71%_78%)]',
  warning:     'bg-[var(--color-warning-subtle)] text-[hsl(26_83%_30%)] border-[hsl(38_92%_72%)]',
  destructive: 'bg-[var(--color-destructive-subtle)] text-[hsl(0_84%_42%)] border-[hsl(0_84%_80%)]',
  info:        'bg-[var(--color-info-subtle)] text-[hsl(199_89%_30%)] border-[hsl(199_89%_72%)]',
  purple:      'bg-[hsl(270_100%_97%)] text-[hsl(262_83%_44%)] border-[hsl(270_88%_82%)]',
};

const dotColors: Record<BadgeVariant, string> = {
  default:     'bg-[var(--color-brand-500)]',
  secondary:   'bg-[var(--color-foreground-muted)]',
  outline:     'bg-[var(--color-foreground-muted)]',
  success:     'bg-[var(--color-success)]',
  warning:     'bg-[var(--color-warning)]',
  destructive: 'bg-[var(--color-destructive)]',
  info:        'bg-[var(--color-info)]',
  purple:      'bg-[hsl(262_83%_58%)]',
};

function Badge({ variant = 'default', className, children, dot }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full',
        'px-2.5 py-0.5 text-[11px] font-medium border',
        'whitespace-nowrap leading-tight',
        variants[variant],
        className,
      )}
    >
      {dot && (
        <span className={cn('h-1.5 w-1.5 rounded-full shrink-0', dotColors[variant])} />
      )}
      {children}
    </span>
  );
}

export { Badge };
export type { BadgeProps };
