import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type BadgeVariant =
  | 'default'
  | 'secondary'
  | 'outline'
  | 'success'
  | 'warning'
  | 'destructive'
  | 'info'
  | 'purple';

interface BadgeProps {
  variant?: BadgeVariant;
  className?: string;
  children: ReactNode;
  dot?: boolean;
}

const variants: Record<BadgeVariant, string> = {
  default: 'bg-brand-100 text-brand-800 border-brand-200',
  secondary: 'bg-secondary text-foreground-muted border-transparent',
  outline: 'bg-transparent text-foreground-muted border-border',
  success: 'bg-success-subtle text-success-text border-success-border',
  warning: 'bg-warning-subtle text-warning-text border-warning-border',
  destructive: 'bg-destructive-subtle text-destructive-text border-destructive-border',
  info: 'bg-info-subtle text-info-text border-info-border',
  purple: 'bg-[hsl(270_100%_97%)] text-[hsl(262_83%_44%)] border-[hsl(270_88%_82%)]',
};

const dotColors: Record<BadgeVariant, string> = {
  default: 'bg-brand-500',
  secondary: 'bg-foreground-muted',
  outline: 'bg-foreground-muted',
  success: 'bg-success',
  warning: 'bg-warning',
  destructive: 'bg-destructive',
  info: 'bg-info',
  purple: 'bg-[hsl(262_83%_58%)]',
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
      {dot && <span className={cn('h-1.5 w-1.5 rounded-full shrink-0', dotColors[variant])} />}
      {children}
    </span>
  );
}

export { Badge };
export type { BadgeProps };
