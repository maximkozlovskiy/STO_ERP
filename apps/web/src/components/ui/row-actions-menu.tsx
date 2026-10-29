'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { MoreHorizontal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useEscapeLayer } from '@/hooks/useEscapeLayer';
import { cn } from '@/lib/utils';

export interface RowMenuAction {
  key: string;
  label: string;
  onSelect: () => void;
  icon?: ReactNode;
  /** Незворотна чи фінансова дія (сторно, скасування) — червоним. */
  destructive?: boolean;
}

interface RowActionsMenuProps {
  actions: RowMenuAction[];
  /** Підпис кнопки «⋯» для читача екрана (типово — «Дії рядка»). */
  label?: string;
  className?: string;
}

const MENU_WIDTH_PX = 224;

/**
 * Меню «⋯» рядка таблиці: рідкісні й незворотні дії (сторно, скасування рознесення) не стоять
 * кнопкою в кожному рядку (UX-огляд 2026-10-29) — колонка «Дії» вузька й не обрізається.
 *
 * Меню рендериться в портал із `position: fixed` від кнопки: контейнер таблиці прокручується й
 * обрізав би випадний список у нижніх рядках. Підтвердження — вікно, яке відкриває сама дія.
 * Escape закриває лише меню (стек шарів), клік поза ним, прокрутка чи зміна розміру — теж.
 */
export function RowActionsMenu({ actions, label, className }: RowActionsMenuProps) {
  const { t } = useTranslation('common');
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setOpen(false), []);
  useEscapeLayer(open, () => {
    close();
    triggerRef.current?.focus();
  });

  useLayoutEffect(() => {
    if (!open) return;
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const menuHeight = menuRef.current?.offsetHeight ?? 0;
    const below = rect.bottom + 4;
    const top =
      below + menuHeight > window.innerHeight - 8 ? Math.max(8, rect.top - 4 - menuHeight) : below;
    const left = Math.min(
      Math.max(8, rect.right - MENU_WIDTH_PX),
      window.innerWidth - MENU_WIDTH_PX - 8,
    );
    setPos({ top, left });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      close();
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [open, close]);

  if (actions.length === 0) return null;

  const onMenuKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    const next =
      e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={label ?? t('rowActions')}
        title={label ?? t('rowActions')}
        aria-haspopup="menu"
        aria-expanded={open}
        className={cn(
          'inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground',
          'hover:bg-secondary hover:text-foreground focus-visible:outline-none',
          'focus-visible:ring-2 focus-visible:ring-primary/40',
          open && 'bg-secondary text-foreground',
          className,
        )}
        onClick={e => {
          e.stopPropagation();
          setOpen(v => !v);
        }}
      >
        <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            aria-label={label ?? t('rowActions')}
            data-testid="row-actions-menu"
            style={{
              top: pos?.top ?? -9999,
              left: pos?.left ?? -9999,
              width: MENU_WIDTH_PX,
            }}
            className="fixed z-200 rounded-lg border border-border bg-surface py-1 shadow-lg"
            // Портал — у DOM поза рядком, але React-події спливають до рядка: клік у меню не має
            // вибирати рядок чи відкривати бічну панель.
            onClick={e => e.stopPropagation()}
            onKeyDown={onMenuKeyDown}
          >
            {actions.map(a => (
              <button
                key={a.key}
                type="button"
                role="menuitem"
                className={cn(
                  'flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px]',
                  'hover:bg-secondary focus-visible:bg-secondary focus-visible:outline-none',
                  a.destructive ? 'text-destructive' : 'text-foreground',
                )}
                onClick={() => {
                  close();
                  a.onSelect();
                }}
              >
                {a.icon}
                {a.label}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
