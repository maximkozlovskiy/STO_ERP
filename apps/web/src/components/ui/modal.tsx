'use client';

import { useEffect, useCallback, useState, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAnimatedPresence } from '@/hooks/useAnimatedPresence';

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

// Pixel max-width per size — used for smooth CSS transition via inline style
const sizeWidths: Record<ModalSize, string> = {
  sm: '384px',
  md: '512px',
  lg: '672px',
  xl: '896px',
  full: '95vw',
};

const TRANSITION = 'cubic-bezier(0.4,0,0.2,1)';

// Animates its height to match content via ResizeObserver.
// outer: overflow:hidden — clips during transition, no scrollbar flash.
// inner: holds padding + content, measured via scrollHeight.
// Exported for use in accordions / collapsible sections outside Modal.
//
// `fill` mode (used by Modal body): outer розтягується через flex-1 min-h-0
// у flex-col контейнері та сам стає скрол-вікном. JS-керування height
// ВИМКНЕНЕ — інакше outer.height = inner.scrollHeight ламає flex-розтягування
// (outer "застрягає" на висоті контенту замість заповнення вільного простору).
// `className` у fill-режимі живе на ВНУТРІШНЬОМУ div лише для padding —
// overflow і flex-розтягування контролюються outer.
export function AnimatedBody({
  children,
  className,
  fill = false,
}: {
  children: ReactNode;
  className?: string;
  fill?: boolean;
}) {
  const outerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    // У fill-режимі height керується flex-розтягуванням, JS не втручається.
    if (fill) return;

    const outer = outerRef.current;
    const inner = innerRef.current;
    if (!outer || !inner) return;

    // Set initial height instantly (no transition yet — avoids open animation fighting)
    outer.style.transition = 'none';
    outer.style.height = `${inner.scrollHeight}px`;
    // Re-enable transition on next frame — capture rAF id для cancel при rapid mount/unmount.
    // Без id-capture rapid toggle лишає pending rAF що може мутувати DOM після disconnect/unmount.
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      if (outerRef.current) outerRef.current.style.transition = `height 260ms ${TRANSITION}`;
    });

    const ro = new ResizeObserver(() => {
      if (outerRef.current && innerRef.current) {
        outerRef.current.style.height = `${innerRef.current.scrollHeight}px`;
      }
    });
    ro.observe(inner);
    return () => {
      ro.disconnect();
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [fill]);

  if (fill) {
    // Fill-режим: outer — flex-1, бере залишок висоти, сам скролить.
    // Inner — лише padding (через className), без власного overflow.
    return (
      <div ref={outerRef} className="flex-1 min-h-0 overflow-y-auto">
        <div ref={innerRef} className={className}>
          {children}
        </div>
      </div>
    );
  }

  return (
    // outer: clips content during animation — no scrollbar flash
    <div ref={outerRef} style={{ overflow: 'hidden' }}>
      {/* inner: padding lives here so it's included in scrollHeight measurement */}
      <div ref={innerRef} className={className}>
        {children}
      </div>
    </div>
  );
}

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
  className,
  hideClose,
}: ModalProps) {
  const [mounted, setMounted] = useState(false);
  const { visible, state } = useAnimatedPresence(open);

  const handleKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    },
    [onClose],
  );

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!open) return;
    document.addEventListener('keydown', handleKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', handleKey);
      document.body.style.overflow = '';
    };
  }, [open, handleKey]);

  if (!visible || !mounted) return null;

  return createPortal(
    <div
      data-animate
      data-state={state}
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby={title ? 'modal-title' : undefined}
    >
      {/* Backdrop — анімується через [data-state] > [data-backdrop] у globals.css */}
      <div
        data-backdrop
        className="absolute inset-0 bg-black/40 backdrop-blur-[2px]"
        onClick={onClose}
      />

      {/* Panel — анімується через [data-state] у globals.css */}
      <div
        className={cn(
          'relative z-10 w-full rounded-xl bg-surface',
          'shadow-xl border border-border',
          'flex flex-col max-h-[90dvh]',
          className,
        )}
        style={{
          maxWidth: sizeWidths[size],
          transition: `max-width 280ms ${TRANSITION}`,
        }}
      >
        {/* Header */}
        {(title || !hideClose) && (
          <div className="flex items-start justify-between gap-3 px-6 pt-5 pb-4 border-b border-border shrink-0">
            <div className="flex flex-col gap-1">
              {title && (
                <h2
                  id="modal-title"
                  className="text-[16px] font-semibold text-foreground leading-tight tracking-[-0.01em]"
                >
                  {title}
                </h2>
              )}
              {description && <p className="text-[13px] text-muted-foreground">{description}</p>}
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

        {/* Body — fill remaining space у flex-col панелі; outer сам скролить */}
        <AnimatedBody fill className="px-6 py-5">
          {children}
        </AnimatedBody>

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
  return (
    <div className={cn('flex items-center justify-end gap-2 w-full', className)}>{children}</div>
  );
}
