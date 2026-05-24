'use client';

import { useEffect, useCallback, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

type ModalSize = 'sm' | 'md' | 'lg' | 'xl' | 'full';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: ModalSize;
  className?: string;
  hideClose?: boolean;
}

const sizes: Record<ModalSize, string> = {
  sm:   'max-w-sm',
  md:   'max-w-lg',
  lg:   'max-w-2xl',
  xl:   'max-w-4xl',
  full: 'max-w-[95vw]',
};

export function Modal({
  open, onClose, title, description, children, footer, size = 'md', className, hideClose,
}: ModalProps) {
  const [mounted, setMounted] = useState(false);

  const handleKey = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
  }, [onClose]);

  useEffect(() => { setMounted(true); }, []);

  useEffect(() => {
    if (!open) return;
    document.addEventListener('keydown', handleKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', handleKey);
      document.body.style.overflow = '';
    };
  }, [open, handleKey]);

  if (!open || !mounted) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby={title ? 'modal-title' : undefined}
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-[2px] animate-in fade-in duration-150"
        onClick={onClose}
      />

      {/* Panel */}
      <div
        className={cn(
          'relative z-10 w-full rounded-xl bg-white',
          'shadow-xl border border-border',
          'flex flex-col max-h-[90vh]',
          'animate-in fade-in zoom-in-95 duration-200',
          sizes[size],
          className,
        )}
      >
        {/* Header */}
        {(title || !hideClose) && (
          <div className="flex items-start justify-between gap-3 px-6 pt-5 pb-4 border-b border-border shrink-0">
            <div className="flex flex-col gap-1">
              {title && (
                <h2 id="modal-title" className="text-[16px] font-semibold text-foreground leading-tight tracking-[-0.01em]">
                  {title}
                </h2>
              )}
              {description && (
                <p className="text-[13px] text-muted-foreground">{description}</p>
              )}
            </div>
            {!hideClose && (
              <button
                onClick={onClose}
                className={cn(
                  'shrink-0 rounded p-1.5 -mr-1 -mt-0.5',
                  'text-muted-foreground',
                  'hover:bg-secondary hover:text-foreground',
                  'transition-colors duration-150',
                )}
                aria-label="Закрити"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        )}

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {children}
        </div>

        {/* Footer */}
        {footer && (
          <div className="shrink-0 flex items-center justify-end gap-2 px-6 py-4 border-t border-border bg-secondary rounded-b-xl">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

export function ModalFooter({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex items-center justify-end gap-2 w-full', className)}>{children}</div>;
}
