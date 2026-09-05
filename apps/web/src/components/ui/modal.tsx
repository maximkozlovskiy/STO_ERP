'use client';

import {
  useEffect,
  useCallback,
  useState,
  useRef,
  useId,
  type ReactNode,
  type CSSProperties,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAnimatedPresence } from '@/hooks/useAnimatedPresence';
import { useUiFeatures } from '@/hooks/useUiFeatures';

type ModalSize = 'sm' | 'md' | 'lg' | 'xl' | 'full' | 'content';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: ModalSize;
  minHeight?: number | string;
  bodyMinHeight?: number | string;
  className?: string;
  hideClose?: boolean;
  /** Extra action buttons rendered to the left of the × close button */
  extraHeaderActions?: ReactNode;
  /** Extra content rendered below the title row, inside the header border */
  headerContent?: ReactNode;
  /**
   * Ctrl+Enter (Cmd+Enter на mac) — «зберегти» без миші. Викликається лише коли
   * features.keyboardShortcutsEnabled увімкнено. Хендлер сам вирішує, чи форма
   * валідна/не в процесі збереження (тобто безпечно повторний виклик).
   */
  onSubmit?: () => void;
}

// Pixel max-width per size — used for smooth CSS transition via inline style
const sizeWidths: Record<ModalSize, string> = {
  sm: '384px',
  md: '512px',
  lg: '672px',
  xl: '896px',
  full: '95vw',
  content: 'calc(100vw - 216px)',
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
  bodyStyle,
}: {
  children: ReactNode;
  className?: string;
  fill?: boolean;
  bodyStyle?: CSSProperties;
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
      <div ref={outerRef} className="flex-1 min-h-0 overflow-y-auto" style={bodyStyle}>
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

// Ctrl+Enter / Cmd+Enter → submit. Винесено в окремий компонент, який монтується
// ЛИШЕ коли Modal отримав onSubmit — так `useUiFeatures()` (3 window-listeners +
// можливий fetch) не викликається у кожній модалці (пікери/ConfirmDialog без
// onSubmit його не платять). Escape лишається у base Modal для всіх.
function ModalSubmitKeys({
  open,
  onSubmit,
  panelRef,
}: {
  open: boolean;
  onSubmit: () => void;
  panelRef: RefObject<HTMLDivElement | null>;
}) {
  const { keyboardShortcutsEnabled } = useUiFeatures();
  // onSubmit у ref — keydown-ефект не переприв'язується на кожен ре-рендер
  // (onSubmit зазвичай інлайн-стрілка, нова ідентичність щоразу).
  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;

  useEffect(() => {
    if (!open || !keyboardShortcutsEnabled) return;
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        // Скоуп на ЦЮ модалку: подія має походити з її панелі — інакше вкладені
        // модалки (обидві слухають document) подвоюють submit.
        const target = e.target as Node | null;
        if (target && panelRef.current && !panelRef.current.contains(target)) return;
        e.preventDefault();
        onSubmitRef.current();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, keyboardShortcutsEnabled, panelRef]);

  return null;
}

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
  minHeight,
  bodyMinHeight,
  className,
  hideClose,
  extraHeaderActions,
  headerContent,
  onSubmit,
}: ModalProps) {
  const [mounted, setMounted] = useState(false);
  const { visible, state } = useAnimatedPresence(open);
  // Bug fix (sto-tester): unique title id per Modal instance — without useId() multiple
  // nested modals (e.g. CreateInvoiceModal opening SearchPickerModal) shared the same
  // `id="modal-title"`, causing aria-labelledby ID collision: ALL dialogs adopted the
  // FIRST h2 with that ID as their accessible name. E2E tests filtering by accessible
  // name (`dialog "Оберіть товар"`) matched the wrong modal.
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);

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
      aria-labelledby={title ? titleId : undefined}
    >
      {/* Backdrop — анімується через [data-state] > [data-backdrop] у globals.css */}
      <div
        data-backdrop
        className="absolute inset-0 bg-black/40 backdrop-blur-[2px]"
        onClick={onClose}
      />

      {/* Panel — анімується через [data-state] у globals.css */}
      <div
        ref={panelRef}
        className={cn(
          'relative z-10 w-full rounded-xl bg-surface',
          'shadow-xl border border-border',
          'flex flex-col max-h-[90dvh]',
          className,
        )}
        style={{
          maxWidth: sizeWidths[size],
          minHeight: minHeight ?? undefined,
          transition: `max-width 280ms ${TRANSITION}`,
        }}
      >
        {onSubmit && <ModalSubmitKeys open={open} onSubmit={onSubmit} panelRef={panelRef} />}
        {/* Header */}
        {(title || !hideClose || headerContent) && (
          <div className="px-6 pt-5 pb-4 border-b border-border shrink-0">
            <div className="flex items-start justify-between gap-3">
              <div className="flex flex-col gap-1">
                {title && (
                  <h2
                    id={titleId}
                    className="text-[16px] font-semibold text-foreground leading-tight tracking-[-0.01em]"
                  >
                    {title}
                  </h2>
                )}
                {description && <p className="text-[13px] text-muted-foreground">{description}</p>}
              </div>
              {(!hideClose || extraHeaderActions) && (
                <div className="flex items-center gap-1 shrink-0 -mr-1 -mt-0.5">
                  {extraHeaderActions}
                  {!hideClose && (
                    <button
                      onClick={onClose}
                      className={cn(
                        'rounded p-1.5',
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
            </div>
            {headerContent && <div className="mt-3">{headerContent}</div>}
          </div>
        )}

        {/* Body — fill remaining space у flex-col панелі; outer сам скролить */}
        <AnimatedBody
          fill
          className="px-6 py-5"
          bodyStyle={bodyMinHeight ? { minHeight: bodyMinHeight } : undefined}
        >
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
