import { type LucideIcon, Inbox } from 'lucide-react';
import { cn } from '@/lib/utils';

interface EmptyStateProps {
  icon?: LucideIcon;
  title?: string;
  description?: string;
  action?: React.ReactNode;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

const sizes = {
  sm: { wrap: 'py-8', icon: 'h-10 w-10', iconInner: 'h-5 w-5', title: 'text-[13px]', desc: 'text-[12px]' },
  md: { wrap: 'py-14', icon: 'h-14 w-14', iconInner: 'h-6 w-6', title: 'text-[14px]', desc: 'text-[13px]' },
  lg: { wrap: 'py-20', icon: 'h-16 w-16', iconInner: 'h-7 w-7', title: 'text-[15px]', desc: 'text-[13px]' },
};

function EmptyState({
  icon: Icon = Inbox,
  title = 'Нічого не знайдено',
  description,
  action,
  size = 'md',
  className,
}: EmptyStateProps) {
  const s = sizes[size];
  return (
    <div className={cn('flex flex-col items-center justify-center gap-3 px-6 text-center', s.wrap, className)}>
      <div className={cn(
        'flex items-center justify-center rounded-full',
        'bg-(--color-secondary) border border-(--color-border)',
        s.icon,
      )}>
        <Icon className={cn(s.iconInner, 'text-muted-foreground')} />
      </div>
      <div className="flex flex-col gap-1 max-w-xs">
        <p className={cn('font-semibold text-foreground', s.title)}>{title}</p>
        {description && (
          <p className={cn('text-muted-foreground leading-snug', s.desc)}>{description}</p>
        )}
      </div>
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

export { EmptyState };
export type { EmptyStateProps };
