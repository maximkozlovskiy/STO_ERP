'use client';

import * as React from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  error?: boolean;
  errorMessage?: string;
  placeholder?: string;
}

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, error, errorMessage, placeholder, children, ...props }, ref) => {
    return (
      <div className="flex flex-col gap-1">
        <div className="relative">
          <select
            ref={ref}
            className={cn(
              'flex h-9 w-full appearance-none rounded-lg border bg-white px-3 py-2 pr-8 text-sm',
              'transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:border-blue-500',
              'disabled:cursor-not-allowed disabled:opacity-50 disabled:bg-gray-50',
              error
                ? 'border-red-400 focus-visible:ring-red-400'
                : 'border-gray-300',
              className,
            )}
            {...props}
          >
            {placeholder && (
              <option value="">{placeholder}</option>
            )}
            {children}
          </select>
          <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
        </div>
        {error && errorMessage && (
          <p className="text-xs text-red-600">{errorMessage}</p>
        )}
      </div>
    );
  },
);

Select.displayName = 'Select';
