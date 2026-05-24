import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/utils';

/* ── Card ── */
function Card({ className, children, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'rounded-lg border border-border bg-white',
        'shadow-(--shadow-xs)',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

function CardHeader({ className, children, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('flex flex-col gap-1 px-5 pt-5 pb-4 border-b border-border', className)} {...props}>
      {children}
    </div>
  );
}

function CardTitle({ className, children, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h3
      className={cn('text-[15px] font-semibold text-foreground leading-tight tracking-[-0.01em]', className)}
      {...props}
    >
      {children}
    </h3>
  );
}

function CardDescription({ className, children, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p className={cn('text-[13px] text-muted-foreground', className)} {...props}>
      {children}
    </p>
  );
}

function CardContent({ className, children, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('px-5 py-4', className)} {...props}>
      {children}
    </div>
  );
}

function CardFooter({ className, children, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('flex items-center px-5 py-3 border-t border-border bg-secondary rounded-b-lg', className)}
      {...props}
    >
      {children}
    </div>
  );
}

/* ── KPI Card ── */
interface KpiCardProps {
  label: string;
  value: string | number;
  icon: ReactNode;
  colorClass?: string; // e.g. 'kpi-card-blue'
  trend?: { value: string; up?: boolean };
  className?: string;
}

function KpiCard({ label, value, icon, colorClass = 'kpi-card-blue', trend, className }: KpiCardProps) {
  return (
    <div
      className={cn(
        'rounded-lg border p-5 flex items-start justify-between gap-3',
        colorClass,
        'bg-(--kpi-bg) border-(--kpi-border)',
        className,
      )}
    >
      <div className="flex flex-col gap-1 min-w-0">
        <span className="text-[12px] font-medium text-foreground-muted uppercase tracking-wider">
          {label}
        </span>
        <span className="text-[28px] font-bold text-foreground leading-none tracking-tight">
          {value}
        </span>
        {trend && (
          <span className={cn(
            'text-[12px] font-medium mt-0.5',
            trend.up ? 'text-success' : 'text-destructive',
          )}>
            {trend.up ? '↑' : '↓'} {trend.value}
          </span>
        )}
      </div>
      <span className="shrink-0 rounded-md p-2.5 text-(--kpi-icon) bg-white/60 [&>svg]:h-5 [&>svg]:w-5">
        {icon}
      </span>
    </div>
  );
}

export { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter, KpiCard };
