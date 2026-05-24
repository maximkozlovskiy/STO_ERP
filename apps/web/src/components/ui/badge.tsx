import * as React from 'react';
import { cn } from '@/lib/utils';

export type BadgeVariant =
  | 'default'
  | 'secondary'
  | 'destructive'
  | 'outline'
  | 'success'
  | 'warning';

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
}

const variantClasses: Record<BadgeVariant, string> = {
  default:     'bg-blue-100 text-blue-700 border-transparent',
  secondary:   'bg-gray-100 text-gray-700 border-transparent',
  destructive: 'bg-red-100 text-red-700 border-transparent',
  outline:     'bg-transparent text-gray-700 border-gray-300',
  success:     'bg-green-100 text-green-700 border-transparent',
  warning:     'bg-amber-100 text-amber-700 border-transparent',
};

export function Badge({ className, variant = 'default', children, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium',
        'transition-colors',
        variantClasses[variant],
        className,
      )}
      {...props}
    >
      {children}
    </span>
  );
}
