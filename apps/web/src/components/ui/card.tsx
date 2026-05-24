import { cn } from '@/lib/utils';

/* ── Card ── */
function Card({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-white',
        'shadow-[var(--shadow-xs)]',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

function CardHeader({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('flex flex-col gap-1 px-5 pt-5 pb-4 border-b border-[var(--color-border)]', className)} {...props}>
      {children}
    </div>
  );
}

function CardTitle({ className, children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h3
      className={cn('text-[15px] font-semibold text-[var(--color-foreground)] leading-tight tracking-[-0.01em]', className)}
      {...props}
    >
      {children}
    </h3>
  );
}

function CardDescription({ className, children, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p className={cn('text-[13px] text-[var(--color-muted-foreground)]', className)} {...props}>
      {children}
    </p>
  );
}

function CardContent({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('px-5 py-4', className)} {...props}>
      {children}
    </div>
  );
}

function CardFooter({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('flex items-center px-5 py-3 border-t border-[var(--color-border)] bg-[var(--color-secondary)] rounded-b-[var(--radius-lg)]', className)}
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
  icon: React.ReactNode;
  colorClass?: string; // e.g. 'kpi-card-blue'
  trend?: { value: string; up?: boolean };
  className?: string;
}

function KpiCard({ label, value, icon, colorClass = 'kpi-card-blue', trend, className }: KpiCardProps) {
  return (
    <div
      className={cn(
        'rounded-[var(--radius-lg)] border p-5 flex items-start justify-between gap-3',
        colorClass,
        'bg-[var(--kpi-bg)] border-[var(--kpi-border)]',
        className,
      )}
    >
      <div className="flex flex-col gap-1 min-w-0">
        <span className="text-[12px] font-medium text-[var(--color-foreground-muted)] uppercase tracking-[0.05em]">
          {label}
        </span>
        <span className="text-[28px] font-bold text-[var(--color-foreground)] leading-none tracking-tight">
          {value}
        </span>
        {trend && (
          <span className={cn(
            'text-[12px] font-medium mt-0.5',
            trend.up ? 'text-[var(--color-success)]' : 'text-[var(--color-destructive)]',
          )}>
            {trend.up ? '↑' : '↓'} {trend.value}
          </span>
        )}
      </div>
      <span className="shrink-0 rounded-[var(--radius-md)] p-2.5 text-[var(--kpi-icon)] bg-white/60 [&>svg]:h-5 [&>svg]:w-5">
        {icon}
      </span>
    </div>
  );
}

export { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter, KpiCard };
