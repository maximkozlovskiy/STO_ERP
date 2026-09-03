'use client';

import { useMemo, useState, type KeyboardEvent } from 'react';
import { Wallet, X, ChevronRight } from 'lucide-react';
import {
  useSupplierPaymentsSchedule,
  useSupplierPaymentDocuments,
  type SupplierPaymentDocumentsParams,
} from '@/hooks/api/useSupplierPayments';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { PurchaseOrderCreateModal } from '@/components/ui/PurchaseOrderCreateModal';
import { fmtMoney, kyivToday, addDaysISO } from '@/lib/format';
import { cn } from '@/lib/utils';

const WINDOW_DAYS = 20;

/** Сума у гривнях або порожньо, якщо 0/undefined. */
function cell(n: number | undefined): string {
  return n && n > 0.005 ? fmtMoney(n) : '';
}

/** DD.MM з YYYY-MM-DD. */
function ddmm(ymd: string): string {
  const [, m, d] = ymd.split('-');
  return `${d}.${m}`;
}

/** Опис вибраної клітинки: параметри запиту + людський підпис для заголовка панелі. */
interface Selection {
  params: SupplierPaymentDocumentsParams;
  label: string;
}

export function SupplierPaymentScheduleTab() {
  const from = useMemo(() => kyivToday(), []);
  const to = useMemo(() => addDaysISO(from, WINDOW_DAYS - 1), [from]);

  const { data, error } = useSupplierPaymentsSchedule(from, to);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [editingPOId, setEditingPOId] = useState<string | null>(null);

  const {
    data: docs,
    isFetching: docsLoading,
    error: docsError,
  } = useSupplierPaymentDocuments(selected?.params ?? null);

  if (error) {
    return (
      <div className="text-destructive text-sm py-8 text-center">
        {error instanceof Error ? error.message : 'Помилка завантаження'}
      </div>
    );
  }
  // Спінер поки немає даних — покриває і завантаження, і стан «auth ще вантажиться»
  // (query disabled → isLoading=false, але data ще undefined; не показуємо empty-state завчасно).
  if (!data) {
    return (
      <div className="flex justify-center py-16">
        <Spinner />
      </div>
    );
  }
  if (data.suppliers.length === 0) {
    return (
      <EmptyState
        icon={Wallet}
        title="Немає запланованих оплат"
        description="Тут з'являться борги постачальникам за отриманими замовленнями з датою оплати."
      />
    );
  }

  const { dates, suppliers, totals } = data;

  // Ключ вибраної клітинки для підсвічування (supplierId|bucket; '' supplierId = рядок «Разом»).
  const selKey = (() => {
    if (!selected) return null;
    const p = selected.params;
    const bucket = 'date' in p ? p.date : p.target;
    return `${p.supplierId ?? ''}|${bucket}`;
  })();

  /** Клік по клітинці: зберігає selection (тригерить запит документів). */
  const pick = (
    supplierId: string | undefined,
    supplierName: string | undefined,
    bucket: 'overdue' | 'planned' | string,
    isDate: boolean,
  ) => {
    const base = { from, to, ...(supplierId ? { supplierId } : {}) };
    const params: SupplierPaymentDocumentsParams = isDate
      ? { ...base, date: bucket }
      : { ...base, target: bucket as 'overdue' | 'planned' };
    const who = supplierName ?? 'Усі постачальники';
    const what = isDate ? ddmm(bucket) : bucket === 'overdue' ? 'Протерміновані' : 'Планові';
    const key = `${supplierId ?? ''}|${bucket}`;
    // Повторний клік по тій самій клітинці — закрити панель.
    if (selKey === key) setSelected(null);
    else setSelected({ params, label: `${who} · ${what}` });
  };

  const key = (supplierId: string | undefined, bucket: string) => `${supplierId ?? ''}|${bucket}`;

  return (
    <div className="flex flex-1 min-h-0 flex-col gap-3">
      <div className="table-scroll-container min-h-0 min-w-0 overflow-auto bg-surface border border-border rounded-xl">
        <table className="w-full text-[12px] tabular-nums border-collapse">
          <thead className="sticky top-0 z-10 bg-secondary">
            <tr className="text-muted-foreground">
              <th className="sticky left-0 z-20 bg-secondary text-left font-medium px-3 py-2 min-w-40 border-b border-r border-border">
                Постачальник
              </th>
              <th className="text-right font-medium px-2 py-2 min-w-24 border-b border-border bg-destructive-subtle text-destructive-text">
                Протерміновані
              </th>
              {dates.map(d => (
                <th
                  key={d}
                  className="text-right font-medium px-2 py-2 min-w-16 border-b border-border whitespace-nowrap"
                >
                  {ddmm(d)}
                </th>
              ))}
              <th className="sticky right-0 z-20 text-right font-medium px-2 py-2 min-w-24 border-b border-l border-border bg-success-subtle text-success">
                Планові
              </th>
            </tr>
          </thead>
          <tbody>
            {/* Підсумковий рядок «Разом» — клік показує документи ВСІХ постачальників */}
            <tr className="font-semibold bg-muted/40">
              <td className="sticky left-0 z-10 bg-muted/40 px-3 py-1.5 border-b border-r border-border">
                Разом:
              </td>
              <TotalCell
                value={totals.overdue}
                active={selKey === key(undefined, 'overdue')}
                onClick={() => pick(undefined, undefined, 'overdue', false)}
                variant="overdue"
              />
              {dates.map(d => (
                <TotalCell
                  key={d}
                  value={totals.byDate[d]}
                  active={selKey === key(undefined, d)}
                  onClick={() => pick(undefined, undefined, d, true)}
                />
              ))}
              <TotalCell
                value={totals.planned}
                active={selKey === key(undefined, 'planned')}
                onClick={() => pick(undefined, undefined, 'planned', false)}
                sticky
              />
            </tr>

            {/* Рядки постачальників */}
            {suppliers.map(row => (
              <tr key={row.supplierId} className="hover:bg-secondary/40 transition-colors">
                <td className="sticky left-0 z-10 bg-surface px-3 py-1.5 border-b border-r border-border text-foreground whitespace-nowrap">
                  {row.supplierName}
                </td>
                <ClickableCell
                  value={row.overdue}
                  active={selKey === key(row.supplierId, 'overdue')}
                  onClick={() => pick(row.supplierId, row.supplierName, 'overdue', false)}
                  className={row.overdue > 0.005 ? 'bg-destructive text-white' : undefined}
                />
                {dates.map(d => {
                  const v = row.byDate[d];
                  return (
                    <ClickableCell
                      key={d}
                      value={v}
                      active={selKey === key(row.supplierId, d)}
                      onClick={() => pick(row.supplierId, row.supplierName, d, true)}
                      className={
                        v && v > 0.005 ? 'bg-warning-subtle text-warning font-medium' : undefined
                      }
                    />
                  );
                })}
                <ClickableCell
                  value={row.planned}
                  active={selKey === key(row.supplierId, 'planned')}
                  onClick={() => pick(row.supplierId, row.supplierName, 'planned', false)}
                  sticky
                  className={
                    row.planned > 0.005
                      ? 'bg-success-subtle text-success font-medium'
                      : 'bg-surface'
                  }
                />
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Панель документів під таблицею */}
      {selected && (
        <div className="bg-surface border border-border rounded-xl overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-secondary">
            <span className="text-sm font-medium text-foreground">Документи: {selected.label}</span>
            <button
              type="button"
              onClick={() => setSelected(null)}
              className="text-muted-foreground hover:text-foreground transition-colors"
              aria-label="Закрити"
            >
              <X className="size-4" />
            </button>
          </div>
          {docsError ? (
            <div className="text-destructive text-sm px-4 py-6 text-center">
              {docsError instanceof Error ? docsError.message : 'Помилка завантаження'}
            </div>
          ) : docsLoading && !docs ? (
            <div className="flex justify-center py-8">
              <Spinner />
            </div>
          ) : !docs || docs.length === 0 ? (
            <div className="text-muted-foreground text-sm px-4 py-6 text-center">
              Немає документів
            </div>
          ) : (
            <div className="overflow-auto max-h-72">
              <table className="w-full text-[13px] tabular-nums border-collapse">
                <thead className="sticky top-0 bg-secondary text-muted-foreground">
                  <tr>
                    <th className="text-left font-medium px-4 py-2 border-b border-border">№</th>
                    {!selected.params.supplierId && (
                      <th className="text-left font-medium px-3 py-2 border-b border-border whitespace-nowrap">
                        Постачальник
                      </th>
                    )}
                    <th className="text-left font-medium px-3 py-2 border-b border-border whitespace-nowrap">
                      Дата оплати
                    </th>
                    <th className="text-right font-medium px-3 py-2 border-b border-border">
                      Сума
                    </th>
                    <th className="text-right font-medium px-3 py-2 border-b border-border">
                      Залишок
                    </th>
                    <th className="w-8 border-b border-border" />
                  </tr>
                </thead>
                <tbody>
                  {docs.map(doc => {
                    const clickable = !!doc.poId;
                    const open = clickable ? () => setEditingPOId(doc.poId) : undefined;
                    return (
                      <tr
                        key={doc.poId || doc.number}
                        onClick={open}
                        onKeyDown={
                          open
                            ? e => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                  e.preventDefault();
                                  open();
                                }
                              }
                            : undefined
                        }
                        role={clickable ? 'button' : undefined}
                        tabIndex={clickable ? 0 : undefined}
                        aria-label={clickable ? `Відкрити замовлення ${doc.number}` : undefined}
                        className={cn(
                          'transition-colors',
                          clickable
                            ? 'hover:bg-secondary/40 cursor-pointer focus-visible:outline-none focus-visible:bg-secondary/40'
                            : 'text-muted-foreground',
                        )}
                      >
                        <td className="px-4 py-2 border-b border-border font-medium text-foreground whitespace-nowrap">
                          {doc.number}
                        </td>
                        {!selected.params.supplierId && (
                          <td className="px-3 py-2 border-b border-border whitespace-nowrap">
                            {doc.supplierName}
                          </td>
                        )}
                        <td className="px-3 py-2 border-b border-border whitespace-nowrap">
                          {doc.paymentDate ? ddmm(doc.paymentDate) : '—'}
                        </td>
                        <td className="text-right px-3 py-2 border-b border-border">
                          {fmtMoney(doc.totalAmount)}
                        </td>
                        <td className="text-right px-3 py-2 border-b border-border font-medium">
                          {fmtMoney(doc.outstanding)}
                        </td>
                        <td className="px-2 py-2 border-b border-border text-muted-foreground">
                          {clickable && <ChevronRight className="size-4" />}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <PurchaseOrderCreateModal
        open={!!editingPOId}
        purchaseOrderId={editingPOId ?? undefined}
        onClose={() => setEditingPOId(null)}
      />
    </div>
  );
}

/**
 * Keyboard activation для `<td role="button">` — Enter/Space відкриває панель,
 * як для нативного <button>. Без цього keyboard-only користувач (Tab-навігація,
 * screen reader) не може відкрити drill-down: клітинка отримує focus, але
 * жоден key handler не спрацьовує (WCAG 2.1.1). Space має preventDefault, щоб
 * не проскролити сторінку.
 */
function activateOnKey(onClick: () => void) {
  return (e: KeyboardEvent<HTMLTableCellElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick();
    }
  };
}

/** Клітинка постачальника — клікабельна лише коли є сума. */
function ClickableCell({
  value,
  active,
  onClick,
  className,
  sticky,
}: {
  value: number | undefined;
  active: boolean;
  onClick: () => void;
  className?: string;
  sticky?: boolean;
}) {
  const hasValue = !!value && value > 0.005;
  return (
    <td
      onClick={hasValue ? onClick : undefined}
      onKeyDown={hasValue ? activateOnKey(onClick) : undefined}
      role={hasValue ? 'button' : undefined}
      tabIndex={hasValue ? 0 : undefined}
      className={cn(
        'text-right px-2 py-1.5 border-b border-border',
        sticky && 'sticky right-0 z-10 border-l',
        hasValue &&
          'cursor-pointer hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary',
        active && 'ring-2 ring-inset ring-primary',
        className,
        sticky && !className && 'bg-surface',
      )}
    >
      {cell(value)}
    </td>
  );
}

/** Клітинка рядка «Разом» (bold, muted-фон). */
function TotalCell({
  value,
  active,
  onClick,
  variant,
  sticky,
}: {
  value: number | undefined;
  active: boolean;
  onClick: () => void;
  variant?: 'overdue';
  sticky?: boolean;
}) {
  const hasValue = !!value && value > 0.005;
  return (
    <td
      onClick={hasValue ? onClick : undefined}
      onKeyDown={hasValue ? activateOnKey(onClick) : undefined}
      role={hasValue ? 'button' : undefined}
      tabIndex={hasValue ? 0 : undefined}
      className={cn(
        'text-right px-2 py-1.5 border-b border-border',
        sticky && 'sticky right-0 z-10 bg-muted/40 border-l',
        variant === 'overdue' && hasValue && 'bg-destructive text-white',
        hasValue &&
          'cursor-pointer hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary',
        active && 'ring-2 ring-inset ring-primary',
      )}
    >
      {cell(value)}
    </td>
  );
}
