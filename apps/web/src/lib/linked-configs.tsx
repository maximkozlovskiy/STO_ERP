'use client';

import { Receipt, CreditCard, Calendar, Shield } from 'lucide-react';
import { INVOICE_STATUS_LABELS } from '@sto/shared';
import { fmtDate, fmtDateTime, fmtMoney } from '@/lib/format';
import type { LinkedEntityConfig } from '@/components/ui/LinkedDocumentsPanel';
import type { LinkedNav } from '@/lib/linked-nav';

// Реєстр конфігів пов'язаних документів. Кожен конфіг — фабрика (nav) => config,
// бо навігація приходить з хука useLinkedNav() у компоненті, а самі секції статичні.

function fmt(n: string | number): string {
  return fmtMoney(Number(n));
}

// ─── Спільні badge/label мапи ──────────────────────────────

export const INVOICE_STATUS_COLORS: Record<string, string> = {
  DRAFT: 'bg-secondary text-muted-foreground',
  SENT: 'bg-info-subtle text-info-text',
  PAID: 'bg-success-subtle text-success',
  // Must match INVOICE_STATUS_BADGE['OVERDUE'] = 'warning' — use warning, not destructive.
  OVERDUE: 'bg-warning-subtle text-warning-text',
  CANCELLED: 'bg-secondary text-muted-foreground',
};

const SLOT_STATUS_LABELS: Record<string, string> = {
  AVAILABLE: 'Вільний',
  BOOKED: 'Заброньовано',
  BLOCKED: 'Заблоковано',
};

const METHOD_LABELS: Record<string, string> = {
  CASH: 'Готівка',
  CARD: 'Картка',
  TRANSFER: 'Переказ',
  ONLINE: 'Онлайн',
};

function invoiceStatusBadge(status: string) {
  return {
    label: INVOICE_STATUS_LABELS[status] ?? status,
    className: INVOICE_STATUS_COLORS[status] ?? 'bg-secondary text-muted-foreground',
  };
}

// ─── Row shapes returned by backend linked-documents endpoints ──

interface LinkedInvoiceRow {
  id: string;
  number: string;
  status: string;
  amount: string | number;
  documentDate: string | null;
}
interface LinkedPaymentRow {
  id: string;
  amount: string | number;
  method: string;
  createdAt: string;
  notes: string | null;
}
interface LinkedSlotRow {
  id: string;
  startAt: string;
  endAt: string;
  status: string;
  employeeId: string | null;
  notes: string | null;
  lift: { name: string } | null;
}
interface LinkedWarrantyRow {
  id: string;
  expiresAt: string;
  description: string;
  claimedAt: string | null;
  createdAt: string;
}

// ─── WorkOrder config (behavior-preserving дзеркало старої панелі) ──

export function workOrderLinkedConfig(nav: LinkedNav): LinkedEntityConfig {
  return {
    fetchPath: id => `/work-orders/${id}/linked-documents`,
    sections: [
      {
        key: 'invoices',
        title: 'Рахунки',
        icon: Receipt,
        mapRow: (row: LinkedInvoiceRow) => ({
          id: row.id,
          primary: `Рахунок ${row.number}`,
          secondary: row.documentDate ? fmtDate(row.documentDate) : undefined,
          badge: invoiceStatusBadge(row.status),
          preview: {
            title: `Рахунок ${row.number}`,
            rows: [
              {
                label: 'Статус',
                value: INVOICE_STATUS_LABELS[row.status] ?? row.status,
              },
              { label: 'Сума', value: `${fmt(row.amount)} ₴` },
              ...(row.documentDate ? [{ label: 'Дата', value: fmtDate(row.documentDate) }] : []),
            ],
          },
          navigate: () => nav.toInvoice(row.id),
        }),
      },
      {
        key: 'payments',
        title: 'Оплати',
        icon: CreditCard,
        mapRow: (row: LinkedPaymentRow) => ({
          id: row.id,
          primary: `${fmt(row.amount)} ₴`,
          secondary: fmtDateTime(row.createdAt),
          preview: {
            title: 'Оплата',
            rows: [
              { label: 'Сума', value: `${fmt(row.amount)} ₴` },
              { label: 'Метод', value: METHOD_LABELS[row.method] ?? row.method },
              { label: 'Дата', value: fmtDateTime(row.createdAt) },
              ...(row.notes ? [{ label: 'Примітка', value: row.notes }] : []),
            ],
          },
        }),
      },
      {
        key: 'calendarSlots',
        title: 'Записи календаря',
        icon: Calendar,
        mapRow: (row: LinkedSlotRow) => ({
          id: row.id,
          primary: fmtDateTime(row.startAt),
          secondary: row.lift ? row.lift.name : undefined,
          badge: {
            label: SLOT_STATUS_LABELS[row.status] ?? row.status,
            className:
              row.status === 'BOOKED'
                ? 'bg-info-subtle text-info-text'
                : row.status === 'BLOCKED'
                  ? 'bg-destructive-subtle text-destructive'
                  : 'bg-success-subtle text-success',
          },
          preview: {
            title: 'Запис у календарі',
            rows: [
              { label: 'Початок', value: fmtDateTime(row.startAt) },
              { label: 'Кінець', value: fmtDateTime(row.endAt) },
              { label: 'Статус', value: SLOT_STATUS_LABELS[row.status] ?? row.status },
              ...(row.lift ? [{ label: 'Підйомник', value: row.lift.name }] : []),
              ...(row.notes ? [{ label: 'Примітка', value: row.notes }] : []),
            ],
          },
        }),
      },
      {
        key: 'warranties',
        title: 'Гарантії',
        icon: Shield,
        mapRow: (row: LinkedWarrantyRow) => {
          const isExpired = new Date(row.expiresAt) < new Date();
          return {
            id: row.id,
            primary: row.description || 'Гарантія',
            secondary: `Дійсна до ${fmtDate(row.expiresAt)}`,
            badge: row.claimedAt
              ? { label: 'Звернення', className: 'bg-warning-subtle text-warning' }
              : undefined,
            preview: {
              title: 'Гарантія',
              rows: [
                {
                  label: 'Дійсна до',
                  value: `${fmtDate(row.expiresAt)}${isExpired ? ' (прострочена)' : ''}`,
                },
                { label: 'Виписано', value: fmtDate(row.createdAt) },
                ...(row.claimedAt ? [{ label: 'Звернення', value: fmtDate(row.claimedAt) }] : []),
                ...(row.description ? [{ label: 'Опис', value: row.description }] : []),
              ],
            },
          };
        },
      },
    ],
  };
}
