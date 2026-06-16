'use client';

// Invoice slot у картці наряду. Витягнуто з PageClient.tsx (commit 523190f2)
// у окремий компонент щоб дозволити component-test (Bug #510 у BUG_REPORT.md).
//
// Mirror-shape backend findByWorkOrder() з apps/api/src/modules/invoices/invoices.service.ts:
//   { id, number, status: InvoiceStatus, amount: number, documentDate: string | null }
//
// Гейтінг: рендериться ТІЛЬКИ для статусів з WO_INVOICEABLE_STATUSES (COMPLETED, INVOICED)
// + invoiceRef !== undefined (тобто apiFetch завершився, або null=немає).

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  INVOICE_STATUS_LABELS,
  INVOICE_STATUS_BADGE,
  INVOICE_STATUS_DESCRIPTIONS,
  WO_INVOICEABLE_STATUSES,
  WO_INVOICE_VISIBLE_STATUSES,
  type InvoiceStatus,
} from '@sto/shared';
import { apiFetch, apiBlobFetch } from '@/lib/api-client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { fmtMoney, fmtDate } from '@/lib/format';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import { toast } from '@/lib/toast';

export interface InvoiceRef {
  id: string;
  number: string;
  status: InvoiceStatus;
  amount: number;
  documentDate: string | null;
}

// Backend `createFromWorkOrder` / `refreshFromWorkOrder` повертають повний
// InvoiceResponseDto; `documentDate` там може бути `undefined` (не в select) →
// нормалізуємо до `null` для InvoiceRef. `amount` вже `number` — сервіс робить
// Number() перед серіалізацією.
type InvoiceApiShape = Omit<InvoiceRef, 'documentDate'> & { documentDate?: string | null };

const toInvoiceRef = (inv: InvoiceApiShape): InvoiceRef => ({
  ...inv,
  documentDate: inv.documentDate ?? null,
});

interface InvoiceSectionProps {
  workOrderId: string;
  workOrderStatus: string;
  /**
   * undefined = ще не завантажилось (повертається `null` рендер);
   * null     = завантажено, рахунку немає (empty state);
   * InvoiceRef = рахунок існує.
   */
  invoiceRef: InvoiceRef | null | undefined;
  /** Викликається після успішного create / refresh — батьківський компонент оновлює state. */
  onChange: (next: InvoiceRef) => void;
}

export function InvoiceSection({
  workOrderId,
  workOrderStatus,
  invoiceRef,
  onChange,
}: InvoiceSectionProps) {
  const router = useRouter();
  const features = useUiFeatures();
  const [creatingInvoice, setCreatingInvoice] = useState(false);
  const [refreshingInvoice, setRefreshingInvoice] = useState(false);
  const [downloadingInvoicePdf, setDownloadingInvoicePdf] = useState(false);

  // Гейт: показуємо секцію якщо статус входить до WO_INVOICE_VISIBLE_STATUSES
  // (COMPLETED, INVOICED, PAID, ARCHIVED) і ТІЛЬКИ після того як apiFetch завершився
  // (invoiceRef !== undefined). Це уникає миготіння empty-state перед першим завантаженням.
  // WO_INVOICEABLE_STATUSES (COMPLETED, INVOICED) — використовується тільки для гейту
  // кнопки "Виставити рахунок" (create action), бо PAID/ARCHIVED вже мають рахунок.
  if (!WO_INVOICE_VISIBLE_STATUSES.includes(workOrderStatus) || invoiceRef === undefined) {
    return null;
  }

  const createInvoice = async () => {
    setCreatingInvoice(true);
    try {
      const inv = await apiFetch<InvoiceApiShape>(`/invoices/from-work-order/${workOrderId}`, {
        method: 'POST',
      });
      onChange(toInvoiceRef(inv));
      if (features.toastEnabled) toast.success(`Рахунок № ${inv.number} створено`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Помилка створення рахунку';
      if (features.toastEnabled) toast.error(msg);
    } finally {
      setCreatingInvoice(false);
    }
  };

  const refreshInvoice = async () => {
    setRefreshingInvoice(true);
    try {
      const inv = await apiFetch<InvoiceApiShape>(
        `/invoices/from-work-order/${workOrderId}/refresh`,
        { method: 'POST' },
      );
      onChange(toInvoiceRef(inv));
      if (features.toastEnabled) toast.success('Рядки рахунку оновлено з наряду');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Помилка оновлення рахунку';
      if (features.toastEnabled) toast.error(msg);
    } finally {
      setRefreshingInvoice(false);
    }
  };

  const downloadInvoicePdf = async (invoiceId: string, invoiceNumber: string) => {
    setDownloadingInvoicePdf(true);
    try {
      const blob = await apiBlobFetch(`/invoices/${invoiceId}/pdf`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      // Bug #77 + Bug #341 pattern: filename uses human-readable number;
      // anchor must be in the DOM for Firefox to dispatch the download.
      a.download = `invoice-${invoiceNumber}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // Defer revoke — Chromium can drop the download if revoke fires before
      // the browser starts reading.
      setTimeout(() => URL.revokeObjectURL(url), 100);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Помилка завантаження PDF';
      if (features.toastEnabled) toast.error(msg);
    } finally {
      setDownloadingInvoicePdf(false);
    }
  };

  return (
    <div className="bg-surface rounded-xl border border-border p-5">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-semibold text-foreground">Рахунок</h2>
        {!invoiceRef && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void createInvoice()}
            loading={creatingInvoice}
            disabled={creatingInvoice}
          >
            Виставити рахунок
          </Button>
        )}
      </div>
      {invoiceRef ? (
        <div className="flex items-center gap-4 flex-wrap">
          <p className="text-sm font-medium text-foreground">Рахунок № {invoiceRef.number}</p>
          <Badge
            variant={INVOICE_STATUS_BADGE[invoiceRef.status] ?? 'secondary'}
            tooltip={INVOICE_STATUS_DESCRIPTIONS[invoiceRef.status]}
          >
            {INVOICE_STATUS_LABELS[invoiceRef.status] ?? invoiceRef.status}
          </Badge>
          <p className="text-sm font-semibold text-foreground tabular-nums">
            {fmtMoney(invoiceRef.amount)} ₴
          </p>
          {invoiceRef.documentDate && (
            <p className="text-xs text-muted-foreground">{fmtDate(invoiceRef.documentDate)}</p>
          )}
          {invoiceRef.status === 'DRAFT' && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void refreshInvoice()}
              loading={refreshingInvoice}
              disabled={refreshingInvoice}
            >
              Оновити з наряду
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => void downloadInvoicePdf(invoiceRef.id, invoiceRef.number)}
            loading={downloadingInvoicePdf}
            disabled={downloadingInvoicePdf}
          >
            PDF рахунку
          </Button>
          <Button variant="outline" size="sm" onClick={() => router.push('/invoices')}>
            Відкрити рахунки ↗
          </Button>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Рахунок не виставлено</p>
      )}
    </div>
  );
}
