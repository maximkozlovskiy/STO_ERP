'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  error?: boolean;
  errorMessage?: string;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, error, errorMessage, type = 'text', ...props }, ref) => {
    return (
      <div className="flex flex-col gap-1">
        <input
          type={type}
          ref={ref}
          className={cn(
            'flex h-9 w-full rounded-lg border bg-white px-3 py-2 text-sm',
            'placeholder:text-gray-400',
            'transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:border-blue-500',
            'disabled:cursor-not-allowed disabled:opacity-50 disabled:bg-gray-50',
            error
              ? 'border-red-400 focus-visible:ring-red-400'
              : 'border-gray-300',
            className,
          )}
          {...props}
        />
        {error && errorMessage && (
          <p className="text-xs text-red-600">{errorMessage}</p>
        )}
      </div>
    );
  },
);

Input.displayName = 'Input';
