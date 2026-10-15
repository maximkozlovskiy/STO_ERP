'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CircleHelp } from 'lucide-react';
import { CATEGORY_VIEW, SLOT_CATEGORIES, SLOT_TYPES, SLOT_TYPE_ICON } from './calendar-categories';

/**
 * Кнопка «?» у шапці календаря: пояснює іконки й кольори категорій записів і типи записів
 * виду «Місяць» (BR-CAL-008, BR-CAL-009). Закривається Escape, кліком поза нею і повторним
 * кліком по кнопці.
 */
export function CalendarLegend() {
  const { t } = useTranslation('calendar');
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    // role="dialog": фокус переходить у вікно, щоб читач екрана одразу прочитав пояснення.
    panelRef.current?.focus();
    const onPointerDown = (e: MouseEvent) => {
      if (e.target instanceof Node && rootRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      // Фокус повертається на кнопку — інакше з клавіатури він губиться на <body>.
      buttonRef.current?.focus();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div
      ref={rootRef}
      className="relative"
      // Фокус пішов за межі легенди (Tab, картка місяця, вкладена модалка) — легенда
      // закривається: інакше вона висить над сторінкою, і Escape, призначений модалці, закрив
      // би й її. `relatedTarget` null (клік по тексту вікна, перемикання вікна ОС) — не вихід.
      onBlur={e => {
        const next = e.relatedTarget;
        if (next instanceof Node && !rootRef.current?.contains(next)) setOpen(false);
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-label={t('month.legend.button')}
        title={t('month.legend.button')}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        className={`inline-flex h-8 w-8 items-center justify-center rounded-lg border border-border text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground ${open ? 'bg-secondary text-foreground' : 'bg-surface'}`}
      >
        <CircleHelp className="h-4 w-4" aria-hidden="true" />
      </button>
      {open && (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-label={t('month.legend.title')}
          tabIndex={-1}
          className="focus:outline-none absolute right-0 top-full z-50 mt-1.5 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-surface p-3 text-[13px] shadow-lg"
        >
          <p className="mb-2 font-semibold text-foreground">{t('month.legend.title')}</p>
          <p className="mb-1 text-[12px] font-medium text-muted-foreground">
            {t('month.legend.categories')}
          </p>
          <ul className="mb-3 space-y-1.5">
            {SLOT_CATEGORIES.map(c => {
              const { icon: Icon, className, barClassName } = CATEGORY_VIEW[c];
              return (
                <li key={c} className="flex items-start gap-2" data-category={c}>
                  <span
                    className={`mt-0.5 h-4 w-0 shrink-0 border-l-4 ${barClassName}`}
                    aria-hidden="true"
                  />
                  <Icon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${className}`} aria-hidden="true" />
                  <span className="min-w-0">
                    <span className="font-medium text-foreground">{t(`month.category.${c}`)}</span>
                    <span className="block text-[12px] text-muted-foreground">
                      {t(`month.legend.categoryHint.${c}`)}
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="mb-1 text-[12px] font-medium text-muted-foreground">
            {t('month.legend.types')}
          </p>
          <ul className="grid grid-cols-2 gap-1.5">
            {SLOT_TYPES.map(type => {
              const Icon = SLOT_TYPE_ICON[type];
              return (
                <li key={type} className="flex items-center gap-2 text-foreground">
                  <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  {t(`month.type.${type}`)}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
