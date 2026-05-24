import { cn } from '@/lib/utils';

interface SpinnerProps extends React.SVGAttributes<SVGSVGElement> {
  size?: 'xs' | 'sm' | 'md' | 'lg';
}

const sizes = {
  xs: 'h-3 w-3',
  sm: 'h-4 w-4',
  md: 'h-5 w-5',
  lg: 'h-8 w-8',
};

function Spinner({ size = 'md', className, ...props }: SpinnerProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      className={cn('animate-spin text-(--color-primary)', sizes[size], className)}
      aria-label="Завантаження"
      role="status"
      {...props}
    >
      <circle
        className="opacity-20"
        cx="12" cy="12" r="10"
        stroke="currentColor"
        strokeWidth="3"
      />
      <path
        className="opacity-80"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}

function PageSpinner() {
  return (
    <div className="flex items-center justify-center py-24">
      <Spinner size="lg" />
    </div>
  );
}

function InlineSpinner({ text = 'Завантаження...' }: { text?: string }) {
  return (
    <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
      <Spinner size="sm" />
      <span>{text}</span>
    </div>
  );
}

export { Spinner, PageSpinner, InlineSpinner };
export type { SpinnerProps };
