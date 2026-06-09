'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type {
  CSSProperties,
  ElementType,
  MouseEvent as ReactMouseEvent,
  ReactNode,
  RefObject,
} from 'react';
import { Receipt, CreditCard, Calendar, Shield, X, ExternalLink } from 'lucide-react';
import { apiFetch } from '@/lib/api-client';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { INVOICE_STATUS_LABELS } from '@sto/shared';

// ─── Types ────────────────────────────────────────────────

interface LinkedInvoice {
  id: string;
  number: string;
  status: string;
  amount: string | number;
  documentDate: string | null;
}

interface LinkedPayment {
  id: string;
  amount: string | number;
  method: string;
  createdAt: string;
  notes: string | null;
}

interface LinkedCalendarSlot {
  id: string;
  startAt: string;
  endAt: string;
  status: string;
  employeeId: string | null;
  notes: string | null;
  lift: { name: string } | null;
}

interface LinkedWarranty {
  id: string;
  expiresAt: string;
  description: string;
  claimedAt: string | null;
  createdAt: string;
}

interface LinkedDocuments {
  invoices: LinkedInvoice[];
  payments: LinkedPayment[];
  calendarSlots: LinkedCalendarSlot[];
  warranties: LinkedWarranty[];
}

type PreviewType =
  | { kind: 'invoice'; item: LinkedInvoice }
  | { kind: 'payment'; item: LinkedPayment }
  | { kind: 'slot'; item: LinkedCalendarSlot }
  | { kind: 'warranty'; item: LinkedWarranty };

// ─── Helpers ──────────────────────────────────────────────

function fmt(n: string | number) {
  return Number(n).toLocaleString('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const SLOT_STATUS_LABELS: Record<string, string> = {
  AVAILABLE: 'Вільний',
  BOOKED: 'Заброньовано',
  BLOCKED: 'Заблоковано',
};

const INVOICE_STATUS_COLORS: Record<string, string> = {
  DRAFT: 'bg-secondary text-muted-foreground',
  SENT: 'bg-info-subtle text-info-text',
  PAID: 'bg-success-subtle text-success',
  OVERDUE: 'bg-destructive-subtle text-destructive',
  CANCELLED: 'bg-secondary text-muted-foreground',
};

// ─── Preview Popup ─────────────────────────────────────────

function PreviewPopup({
  preview,
  anchorRef,
  onClose,
}: {
  preview: PreviewType;
  anchorRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}) {
  const popupRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ opacity: 0 });

  // useLayoutEffect — synchronous DOM measurement to avoid flash at (0,0) before reposition.
  useLayoutEffect(() => {
    if (!anchorRef.current || !popupRef.current) return;
    const rect = anchorRef.current.getBoundingClientRect();
    const popupH = popupRef.current.offsetHeight || 200;
    const spaceBelow = window.innerHeight - rect.bottom;
    const top = spaceBelow > popupH + 8 ? rect.bottom + 8 : rect.top - popupH - 8;
    const left = Math.min(rect.left, window.innerWidth - 320 - 16);
    setStyle({ top, left: Math.max(8, left), opacity: 1 });
  }, [anchorRef]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <>
      <div className="fixed inset-0 z-[69]" onClick={onClose} />
      <div
        ref={popupRef}
        style={{ ...style, position: 'fixed', width: 300, zIndex: 70 }}
        className="bg-surface border border-border rounded-xl shadow-xl p-4 text-[13px]"
        role="dialog"
        aria-modal="true"
      >
        <button
          onClick={onClose}
          className="absolute top-3 right-3 text-muted-foreground hover:text-foreground"
          aria-label="Закрити"
        >
          <X size={14} />
        </button>

        {preview.kind === 'invoice' && <InvoicePreview item={preview.item} onClose={onClose} />}
        {preview.kind === 'payment' && <PaymentPreview item={preview.item} />}
        {preview.kind === 'slot' && <SlotPreview item={preview.item} />}
        {preview.kind === 'warranty' && <WarrantyPreview item={preview.item} />}
      </div>
    </>
  );
}

function PreviewRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex justify-between gap-2 py-1 border-b border-border last:border-0">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className="text-right font-medium">{value}</span>
    </div>
  );
}

function InvoicePreview({ item, onClose }: { item: LinkedInvoice; onClose: () => void }) {
  return (
    <div>
      <div className="font-semibold mb-3 pr-5">Рахунок {item.number}</div>
      <div className="space-y-0">
        <PreviewRow
          label="Статус"
          value={
            <span
              className={cn(
                'px-2 py-0.5 rounded-full text-[11px]',
                INVOICE_STATUS_COLORS[item.status] ?? 'bg-secondary text-muted-foreground',
              )}
            >
              {INVOICE_STATUS_LABELS[item.status] ?? item.status}
            </span>
          }
        />
        <PreviewRow label="Сума" value={`${fmt(item.amount)} ₴`} />
        {item.documentDate && <PreviewRow label="Дата" value={fmtDate(item.documentDate)} />}
      </div>
      <button
        onClick={() => {
          window.open(`/invoices/${item.id}`, '_blank');
          onClose();
        }}
        className="mt-4 flex items-center gap-1.5 text-primary hover:underline text-[12px] font-medium"
      >
        <ExternalLink size={13} />
        Відкрити рахунок
      </button>
    </div>
  );
}

function PaymentPreview({ item }: { item: LinkedPayment }) {
  const METHOD_LABELS: Record<string, string> = {
    CASH: 'Готівка',
    CARD: 'Картка',
    TRANSFER: 'Переказ',
    ONLINE: 'Онлайн',
  };
  return (
    <div>
      <div className="font-semibold mb-3 pr-5">Оплата</div>
      <div className="space-y-0">
        <PreviewRow label="Сума" value={`${fmt(item.amount)} ₴`} />
        <PreviewRow label="Метод" value={METHOD_LABELS[item.method] ?? item.method} />
        <PreviewRow label="Дата" value={fmtDateTime(item.createdAt)} />
        {item.notes && <PreviewRow label="Примітка" value={item.notes} />}
      </div>
    </div>
  );
}

function SlotPreview({ item }: { item: LinkedCalendarSlot }) {
  return (
    <div>
      <div className="font-semibold mb-3 pr-5">Запис у календарі</div>
      <div className="space-y-0">
        <PreviewRow label="Початок" value={fmtDateTime(item.startAt)} />
        <PreviewRow label="Кінець" value={fmtDateTime(item.endAt)} />
        <PreviewRow label="Статус" value={SLOT_STATUS_LABELS[item.status] ?? item.status} />
        {item.lift && <PreviewRow label="Підйомник" value={item.lift.name} />}
        {item.notes && <PreviewRow label="Примітка" value={item.notes} />}
      </div>
    </div>
  );
}

function WarrantyPreview({ item }: { item: LinkedWarranty }) {
  const isExpired = new Date(item.expiresAt) < new Date();
  return (
    <div>
      <div className="font-semibold mb-3 pr-5">Гарантія</div>
      <div className="space-y-0">
        <PreviewRow
          label="Дійсна до"
          value={
            <span className={isExpired ? 'text-destructive' : ''}>
              {fmtDate(item.expiresAt)}
              {isExpired ? ' (прострочена)' : ''}
            </span>
          }
        />
        <PreviewRow label="Виписано" value={fmtDate(item.createdAt)} />
        {item.claimedAt && <PreviewRow label="Звернення" value={fmtDate(item.claimedAt)} />}
        {item.description && <PreviewRow label="Опис" value={item.description} />}
      </div>
    </div>
  );
}

// ─── Section ──────────────────────────────────────────────

function SectionRow({
  icon: Icon,
  primary,
  secondary,
  badge,
  onClick,
}: {
  icon: ElementType;
  primary: string;
  secondary?: string;
  badge?: { label: string; className: string };
  onClick: (e: ReactMouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-3 px-5 py-2.5 hover:bg-secondary/60 transition-colors text-left text-[13px]"
    >
      <Icon size={15} className="text-muted-foreground shrink-0" />
      <span className="flex-1 min-w-0">
        <span className="font-medium text-foreground">{primary}</span>
        {secondary && (
          <span className="block text-[11px] text-muted-foreground truncate">{secondary}</span>
        )}
      </span>
      {badge && (
        <span className={cn('px-2 py-0.5 rounded-full text-[11px] shrink-0', badge.className)}>
          {badge.label}
        </span>
      )}
    </button>
  );
}

// ─── Main Component ────────────────────────────────────────

export function LinkedDocumentsPanel({ workOrderId }: { workOrderId: string }) {
  const [data, setData] = useState<LinkedDocuments | null>(null);
  const [loading, setLoading] = useState(true);
  const [preview, setPreview] = useState<PreviewType | null>(null);
  const anchorRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    // Race-guard: користувач швидко перемикає workOrderId → стара відповідь не має
    // перезаписувати стан від нового запиту (§3.1).
    let cancelled = false;
    setLoading(true);
    apiFetch<LinkedDocuments>(`/work-orders/${workOrderId}/linked-documents`)
      .then(d => {
        if (!cancelled) setData(d);
      })
      .catch(() => {
        if (!cancelled) setData({ invoices: [], payments: [], calendarSlots: [], warranties: [] });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workOrderId]);

  const openPreview = (e: ReactMouseEvent<HTMLButtonElement>, p: PreviewType) => {
    anchorRef.current = e.currentTarget;
    setPreview(p);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
        Завантаження…
      </div>
    );
  }

  if (!data) return null;

  const total =
    data.invoices.length +
    data.payments.length +
    data.calendarSlots.length +
    data.warranties.length;

  if (total === 0) {
    return (
      <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
        Пов'язаних документів немає
      </div>
    );
  }

  return (
    <>
      <div className="flex flex-col gap-3">
        {/* Рахунки */}
        {data.invoices.length > 0 && (
          <div className="bg-surface rounded-xl border border-border overflow-hidden">
            <div className="px-5 py-3 border-b border-border bg-secondary flex items-center gap-2">
              <Receipt size={14} className="text-muted-foreground" />
              <h3 className="font-medium text-foreground text-sm">
                Рахунки{' '}
                <span className="text-muted-foreground font-normal">({data.invoices.length})</span>
              </h3>
            </div>
            <div className="divide-y divide-border">
              {data.invoices.map(inv => (
                <SectionRow
                  key={inv.id}
                  icon={Receipt}
                  primary={`Рахунок ${inv.number}`}
                  secondary={inv.documentDate ? fmtDate(inv.documentDate) : undefined}
                  badge={{
                    label: INVOICE_STATUS_LABELS[inv.status] ?? inv.status,
                    className:
                      INVOICE_STATUS_COLORS[inv.status] ?? 'bg-secondary text-muted-foreground',
                  }}
                  onClick={e => openPreview(e, { kind: 'invoice', item: inv })}
                />
              ))}
            </div>
          </div>
        )}

        {/* Оплати */}
        {data.payments.length > 0 && (
          <div className="bg-surface rounded-xl border border-border overflow-hidden">
            <div className="px-5 py-3 border-b border-border bg-secondary flex items-center gap-2">
              <CreditCard size={14} className="text-muted-foreground" />
              <h3 className="font-medium text-foreground text-sm">
                Оплати{' '}
                <span className="text-muted-foreground font-normal">({data.payments.length})</span>
              </h3>
            </div>
            <div className="divide-y divide-border">
              {data.payments.map(p => (
                <SectionRow
                  key={p.id}
                  icon={CreditCard}
                  primary={`${fmt(p.amount)} ₴`}
                  secondary={fmtDateTime(p.createdAt)}
                  onClick={e => openPreview(e, { kind: 'payment', item: p })}
                />
              ))}
            </div>
          </div>
        )}

        {/* Записи календаря */}
        {data.calendarSlots.length > 0 && (
          <div className="bg-surface rounded-xl border border-border overflow-hidden">
            <div className="px-5 py-3 border-b border-border bg-secondary flex items-center gap-2">
              <Calendar size={14} className="text-muted-foreground" />
              <h3 className="font-medium text-foreground text-sm">
                Записи календаря{' '}
                <span className="text-muted-foreground font-normal">
                  ({data.calendarSlots.length})
                </span>
              </h3>
            </div>
            <div className="divide-y divide-border">
              {data.calendarSlots.map(s => (
                <SectionRow
                  key={s.id}
                  icon={Calendar}
                  primary={fmtDateTime(s.startAt)}
                  secondary={s.lift ? s.lift.name : undefined}
                  badge={{
                    label: SLOT_STATUS_LABELS[s.status] ?? s.status,
                    className:
                      s.status === 'BOOKED'
                        ? 'bg-info-subtle text-info-text'
                        : s.status === 'BLOCKED'
                          ? 'bg-destructive-subtle text-destructive'
                          : 'bg-success-subtle text-success',
                  }}
                  onClick={e => openPreview(e, { kind: 'slot', item: s })}
                />
              ))}
            </div>
          </div>
        )}

        {/* Гарантії */}
        {data.warranties.length > 0 && (
          <div className="bg-surface rounded-xl border border-border overflow-hidden">
            <div className="px-5 py-3 border-b border-border bg-secondary flex items-center gap-2">
              <Shield size={14} className="text-muted-foreground" />
              <h3 className="font-medium text-foreground text-sm">
                Гарантії{' '}
                <span className="text-muted-foreground font-normal">
                  ({data.warranties.length})
                </span>
              </h3>
            </div>
            <div className="divide-y divide-border">
              {data.warranties.map(w => (
                <SectionRow
                  key={w.id}
                  icon={Shield}
                  primary={w.description || 'Гарантія'}
                  secondary={`Дійсна до ${fmtDate(w.expiresAt)}`}
                  badge={
                    w.claimedAt
                      ? { label: 'Звернення', className: 'bg-warning-subtle text-warning' }
                      : undefined
                  }
                  onClick={e => openPreview(e, { kind: 'warranty', item: w })}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      {preview && (
        <PreviewPopup preview={preview} anchorRef={anchorRef} onClose={() => setPreview(null)} />
      )}
    </>
  );
}
