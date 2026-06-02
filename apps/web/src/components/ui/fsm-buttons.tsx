'use client';

import { Button } from '@/components/ui/button';

type ButtonVariant = 'default' | 'outline' | 'destructive' | 'ghost';

export interface FSMButtonsProps {
  status: string;
  transitions: Record<string, string[]>;
  labels: Record<string, string>;
  variants?: Record<string, ButtonVariant>;
  onTransition: (toStatus: string) => void;
  loading?: boolean;
  disabled?: boolean;
  size?: 'sm' | 'md';
  className?: string;
}

export function FSMButtons({
  status,
  transitions,
  labels,
  variants,
  onTransition,
  loading,
  disabled,
  size = 'sm' as const,
  className,
}: FSMButtonsProps) {
  const nextStatuses = transitions[status] ?? [];
  if (nextStatuses.length === 0) return null;
  return (
    <div className={`flex flex-col gap-2 ${className ?? ''}`}>
      {nextStatuses.map(s => (
        <Button
          key={s}
          type="button"
          variant={variants?.[s] ?? 'outline'}
          size={size}
          className="w-full"
          loading={loading}
          disabled={disabled}
          onClick={() => onTransition(s)}
        >
          {labels[s] ?? s}
        </Button>
      ))}
    </div>
  );
}
