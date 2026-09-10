import { useState, useEffect } from 'react';
import { WO_SHAREABLE_STATUSES, WO_INVOICEABLE_STATUSES } from '@sto/shared';
import { apiFetch } from '@/lib/api-client';
import { toast } from '@/lib/toast';

/**
 * A3-modal: дії edit-режиму наряду (друк/зберегти-як/поділитись/SMS/рахунок), винесені з
 * CreateWorkOrderModal. Хук володіє loading-станами + invoiceConflict + ESC-ефектом і повертає
 * handlers для footer-JSX. Логіку перенесено ДОСЛІВНО (behavior-identical). handleInvoice зберігає
 * FSM-rollback (COMPLETED→INVOICED→back-COMPLETED при провалі invoice-create).
 *
 * form-agnostic: не торкається form/lines/parts (spine) — лише workOrderId + FSM-статус + features.
 */
export interface UseWorkOrderActionsParams {
  workOrderId?: string;
  isEditMode: boolean;
  currentStatus: string;
  setCurrentStatus: (s: string) => void;
  features: { toastEnabled: boolean };
  setError: (msg: string) => void;
  setLinkedDocsRefreshKey: (fn: (k: number) => number) => void;
  onUpdated?: () => void;
}

export function useWorkOrderActions({
  workOrderId,
  isEditMode,
  currentStatus,
  setCurrentStatus,
  features,
  setError,
  setLinkedDocsRefreshKey,
  onUpdated,
}: UseWorkOrderActionsParams) {
  const [shareLoading, setShareLoading] = useState(false);
  const [smsLoading, setSmsLoading] = useState(false);
  const [invoiceLoading, setInvoiceLoading] = useState(false);
  const [invoiceConflict, setInvoiceConflict] = useState(false);
  const [saveAsOpen, setSaveAsOpen] = useState(false);

  const canShare = isEditMode && WO_SHAREABLE_STATUSES.includes(currentStatus);
  const canInvoice = isEditMode && WO_INVOICEABLE_STATUSES.includes(currentStatus);

  // useCapture + stopImmediatePropagation: батьківський <Modal> теж слухає Esc на document
  // (bubble-фаза), тож без capture+stop Esc закрив би одразу і conflict-dialog, і WO modal.
  // Capture-фаза гарантує що наш listener fire-ить ПЕРШИМ; stopImmediatePropagation відсікає
  // подальші listeners на document (включно з Modal handler).
  useEffect(() => {
    if (!invoiceConflict) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      if (!invoiceLoading) setInvoiceConflict(false);
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, [invoiceConflict, invoiceLoading]);

  const handlePrint = async () => {
    if (!workOrderId) return;
    // Open blank window synchronously inside click handler — browsers block window.open after await.
    const win = window.open('', '_blank');
    setShareLoading(true);
    try {
      const { token } = await apiFetch<{ token: string }>(
        `/work-orders/${workOrderId}/share-token`,
        { method: 'POST' },
      );
      if (win) {
        win.location.href = `/estimate/${token}?print=1`;
      } else {
        // Popup blocked — fallback: navigate directly (user already in click handler context)
        window.open(`/estimate/${token}?print=1`, '_blank');
      }
    } catch (e: unknown) {
      win?.close();
      const msg = e instanceof Error ? e.message : 'Помилка';
      if (features.toastEnabled) toast.error(msg);
      else setError(msg);
    } finally {
      setShareLoading(false);
    }
  };

  const handleSaveAs = async (format: 'pdf' | 'xlsx' | 'docx') => {
    setSaveAsOpen(false);
    if (!workOrderId) return;
    setShareLoading(true);
    try {
      const { token } = await apiFetch<{ token: string }>(
        `/work-orders/${workOrderId}/share-token`,
        { method: 'POST' },
      );
      const apiBase = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';
      const res = await fetch(`${apiBase}/api/public/work-orders/${token}/export/${format}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const disposition = res.headers.get('content-disposition') ?? '';
      const match =
        disposition.match(/filename\*=UTF-8''(.+)/i) ?? disposition.match(/filename="?([^"]+)"?/i);
      const filename = match ? decodeURIComponent(match[1]) : `Кошторис.${format}`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Помилка';
      if (features.toastEnabled) toast.error(msg);
      else setError(msg);
    } finally {
      setShareLoading(false);
    }
  };

  const handleShare = async () => {
    if (!workOrderId) return;
    setShareLoading(true);
    try {
      const { token } = await apiFetch<{ token: string }>(
        `/work-orders/${workOrderId}/share-token`,
        { method: 'POST' },
      );
      await navigator.clipboard.writeText(`${window.location.origin}/estimate/${token}`);
      if (features.toastEnabled) toast.success('Посилання скопійовано');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Помилка';
      if (features.toastEnabled) toast.error(msg);
      else setError(msg);
    } finally {
      setShareLoading(false);
    }
  };

  const handleSendSms = async () => {
    if (!workOrderId) return;
    setSmsLoading(true);
    try {
      // baseUrl формується на сервері з ConfigService('WEB_PUBLIC_URL') —
      // НЕ передаємо з клієнта (open-redirect/phishing ризик).
      await apiFetch(`/work-orders/${workOrderId}/send-estimate-sms`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      if (features.toastEnabled) toast.success('SMS відправлено клієнту');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Помилка відправки SMS';
      if (features.toastEnabled) toast.error(msg);
      else setError(msg);
    } finally {
      setSmsLoading(false);
    }
  };

  const handleInvoice = async () => {
    if (!workOrderId) return;
    // захоплюємо початковий статус ДО transition, щоб мати куди rollback при failure.
    const statusBeforeTransition = currentStatus;
    let transitionedHere = false;
    setInvoiceLoading(true);
    try {
      if (currentStatus === 'COMPLETED') {
        await apiFetch(`/work-orders/${workOrderId}/transition`, {
          method: 'POST',
          body: JSON.stringify({ status: 'INVOICED' }),
        });
        setCurrentStatus('INVOICED');
        transitionedHere = true;
        onUpdated?.();
      }
      const invoice = await apiFetch<{ id: string; number: string }>(
        `/invoices/from-work-order/${workOrderId}`,
        { method: 'POST' },
      );
      // тригернути перезавантаження LinkedDocumentsPanel, інакше "Документи"
      // tab не показує щойно створений рахунок без manual tab-switch.
      setLinkedDocsRefreshKey(k => k + 1);
      if (features.toastEnabled) {
        toast.success(`Рахунок ${invoice.number} створено`, 6000, {
          label: 'Відкрити',
          onClick: () => window.open(`/invoices/${invoice.id}`, '_blank'),
        });
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : '';
      if (msg.includes('вже існує')) {
        setInvoiceConflict(true);
      } else {
        // якщо ми щойно перевели COMPLETED→INVOICED і invoice create провалився —
        // rollback transition назад у COMPLETED, щоб FSM-інваріант не порушувався.
        if (transitionedHere && statusBeforeTransition === 'COMPLETED') {
          try {
            await apiFetch(`/work-orders/${workOrderId}/transition`, {
              method: 'POST',
              body: JSON.stringify({ status: 'COMPLETED' }),
            });
            setCurrentStatus('COMPLETED');
            onUpdated?.();
          } catch {
            // warn-only: manual recovery потрібен. Original error все одно показуємо нижче.
          }
        }
        if (features.toastEnabled) toast.error(msg || 'Помилка виставлення рахунку');
        else setError(msg || 'Помилка');
      }
    } finally {
      setInvoiceLoading(false);
    }
  };

  const handleInvoiceRefresh = async () => {
    if (!workOrderId) return;
    setInvoiceConflict(false);
    setInvoiceLoading(true);
    try {
      const invoice = await apiFetch<{ id: string; number: string }>(
        `/invoices/from-work-order/${workOrderId}/refresh`,
        { method: 'POST' },
      );
      // refresh змінив totals/lines рахунку → перезавантажити LinkedDocumentsPanel
      // щоб totals у preview popup були свіжими.
      setLinkedDocsRefreshKey(k => k + 1);
      if (features.toastEnabled) {
        toast.success(`Рахунок ${invoice.number} оновлено`, 6000, {
          label: 'Відкрити',
          onClick: () => window.open(`/invoices/${invoice.id}`, '_blank'),
        });
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Помилка оновлення рахунку';
      if (features.toastEnabled) toast.error(msg);
      else setError(msg);
    } finally {
      setInvoiceLoading(false);
    }
  };

  const handleInvoiceOpen = async () => {
    if (!workOrderId) return;
    setInvoiceConflict(false);
    try {
      const inv = await apiFetch<{ id: string } | null>(
        `/invoices/from-work-order/${workOrderId}/find`,
      );
      if (inv?.id) {
        window.open(`/invoices/${inv.id}`, '_blank');
      } else {
        // /find повертає null коли рахунку немає (за дизайном — не 404).
        // Race: інший admin скасував рахунок між POST і кліком. Користувач має знати.
        if (features.toastEnabled) {
          toast.warning('Рахунок не знайдено. Можливо, його було скасовано.');
        } else {
          setError('Рахунок не знайдено. Можливо, його було скасовано.');
        }
      }
    } catch {
      window.open(`/invoices?workOrderId=${workOrderId}`, '_blank');
    }
  };

  return {
    shareLoading,
    smsLoading,
    invoiceLoading,
    invoiceConflict,
    setInvoiceConflict,
    saveAsOpen,
    setSaveAsOpen,
    canShare,
    canInvoice,
    handlePrint,
    handleSaveAs,
    handleShare,
    handleSendSms,
    handleInvoice,
    handleInvoiceRefresh,
    handleInvoiceOpen,
  };
}
