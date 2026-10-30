'use client';

import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { DeletedDocumentBanner } from '@/components/ui/DeletedDocumentBanner';

/**
 * Тіло картки документа з табличною частиною (рахунок, замовлення постачальнику, складський
 * документ, повернення постачальнику): смуга «видалено», помилка, згортувана шапка. Розмітка була
 * скопійована в чотири картки (гейт jscpd, 2026-10-30).
 *
 * Помилка стоїть НАД шапкою, не в ній: «Додати» згортає шапку (`0fr` + `overflow-hidden`), і
 * відмова збереження, що жила всередині, ховалась — картка мовчки лишалась відкритою (Bug #1014,
 * #1017).
 */

/** Смуга помилки картки — `role="alert"`, щоб читач екрана оголосив відмову збереження. */
export function DocumentCardError({
  error,
  testId,
}: {
  error: string | null;
  testId?: string | undefined;
}) {
  if (!error) return null;
  return (
    <div
      role="alert"
      data-testid={testId}
      className="mb-3 shrink-0 text-[13px] text-destructive bg-destructive-subtle border border-destructive/30 rounded-lg px-3 py-2"
    >
      {error}
    </div>
  );
}

/** Колонка тіла картки: смуга «видалено» та помилка зверху, далі — шапка й рядки (`children`). */
export function DocumentCardBody({
  deleted,
  error,
  errorTestId,
  children,
}: {
  deleted: boolean;
  error: string | null;
  errorTestId?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col min-h-[70dvh]">
      {deleted && <DeletedDocumentBanner className="mb-3 shrink-0" />}
      <DocumentCardError error={error} testId={errorTestId} />
      {children}
    </div>
  );
}

/**
 * Поля шапки, що згортаються анімацією висоти (`grid-template-rows` 1fr ↔ 0fr). Перемикач —
 * окремо, `CollapsibleHeader` під цим блоком.
 */
export function CollapsibleDocumentHeader({
  collapsed,
  loading = false,
  children,
}: {
  collapsed: boolean;
  /** Документ ще завантажується — «Завантаження…» над полями. */
  loading?: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation('common');
  return (
    <div
      className="grid transition-[grid-template-rows] duration-300 ease-in-out shrink-0"
      style={{ gridTemplateRows: collapsed ? '0fr' : '1fr' }}
      data-testid="document-card-header"
      data-collapsed={collapsed ? 'true' : 'false'}
    >
      <div className="overflow-hidden">
        <div className="space-y-4 pb-1">
          {loading && (
            <div className="flex justify-center py-4 text-sm text-muted-foreground">
              {t('loading')}
            </div>
          )}
          {children}
        </div>
      </div>
    </div>
  );
}

/**
 * Смужка-перемикач шапки рахунку й складського документа: «Шапка документа» і сірі чипи-підсумки
 * згорнутої шапки. Замовлення й повернення мають іншу — `CollapsibleHeader` з виділеним чипом.
 */
export function DocumentHeaderToggle({
  collapsed,
  onToggle,
  chips,
}: {
  collapsed: boolean;
  onToggle: () => void;
  chips: readonly ReactNode[];
}) {
  const { t } = useTranslation('common');
  return (
    <button
      type="button"
      onClick={onToggle}
      className={[
        'flex items-center gap-2 w-full py-1.5 px-2 text-[11px]',
        'hover:bg-secondary/60 transition-colors select-none shrink-0',
        'border-t border-border',
      ].join(' ')}
    >
      {collapsed ? (
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      ) : (
        <ChevronUp className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      )}
      <span className="text-muted-foreground">{t('documentHeader')}</span>
      {chips.map((chip, i) => (
        <span
          key={i}
          className="bg-secondary text-muted-foreground rounded px-1.5 py-0.5 text-[10px]"
        >
          {chip}
        </span>
      ))}
    </button>
  );
}
