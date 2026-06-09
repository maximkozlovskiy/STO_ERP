'use client';

import type { ReactNode, HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';
import { Tooltip } from '@/components/ui/tooltip';

export type BadgeVariant =
  | 'default'
  | 'secondary'
  | 'outline'
  | 'success'
  | 'warning'
  | 'destructive'
  | 'info'
  | 'purple';

interface BadgeProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  variant?: BadgeVariant;
  className?: string;
  children: ReactNode;
  dot?: boolean;
  tooltip?: string;
}

const variants: Record<BadgeVariant, string> = {
  default: 'bg-brand-100 text-brand-800 border-brand-200',
  secondary: 'bg-secondary text-foreground-muted border-transparent',
  outline: 'bg-transparent text-foreground-muted border-border',
  success: 'bg-success-subtle text-success-text border-success-border',
  warning: 'bg-warning-subtle text-warning-text border-warning-border',
  destructive: 'bg-destructive-subtle text-destructive-text border-destructive-border',
  info: 'bg-info-subtle text-info-text border-info-border',
  purple: 'bg-purple-subtle text-purple-text border-purple-border',
};

const dotColors: Record<BadgeVariant, string> = {
  default: 'bg-brand-500',
  secondary: 'bg-foreground-muted',
  outline: 'bg-foreground-muted',
  success: 'bg-success',
  warning: 'bg-warning',
  destructive: 'bg-destructive',
  info: 'bg-info',
  purple: 'bg-purple',
};

function Badge({ variant = 'default', className, children, dot, tooltip, ...rest }: BadgeProps) {
  const badge = (
    <span
      {...rest}
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

  if (!tooltip) return badge;

  return <Tooltip content={tooltip}>{badge}</Tooltip>;
}

export { Badge };
export type { BadgeProps };
