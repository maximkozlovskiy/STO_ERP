import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  WO_SHAREABLE_STATUSES,
  WO_INVOICEABLE_STATUSES,
  WO_INVOICE_VISIBLE_STATUSES,
} from '@sto/shared';
import { apiFetch, apiBlobFetch } from '@/lib/api-client';
import { toast } from '@/lib/toast';
import { downloadBlob, printPdf } from '@/lib/download';
import { useEscapeCapture } from './useEscapeCapture';

/**
 * Ролі, яким сервер дозволяє і `GET /invoices/from-work-order/:id/find`, і `GET /invoices/:id/pdf`
 * (`invoices.controller.ts`). Іншим ролям («Механік») «Друк рахунку» не показується і рахунок
 * наряду не запитується — сервер відповів би 403.
 */
export const INVOICE_PRINT_ROLES: readonly string[] = [
  'OWNER',
  'ADMIN',
  'ACCOUNTANT',
  'RECEPTIONIST',
];

/**
 * A3-modal: дії edit-режиму наряду (друк/зберегти-як/поділитись/SMS/рахунок), винесені з
 * CreateWorkOrderModal. Хук володіє loading-станами + invoiceConflict + ESC-ефектом і повертає
 * handlers для footer-JSX. handleInvoice бере статус наряду з відповіді сервера: повністю сплачений
 * наряд із «Виконано» одразу стає «Оплачено» (BR-WO-016).
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
  /**
   * BR-WO-012: картка лише на перегляд (наряд видалено або ще не завантажено) — друк, що йде на
   * сервер, не пропонується, рахунок наряду не запитується.
   */
  viewOnly?: boolean;
  /** Номер наряду — для назви файла й заголовка вікна друку. */
  woNumber?: string;
  /** Роль користувача — «Друк рахунку» лише для INVOICE_PRINT_ROLES. */
  role?: string;
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
  viewOnly = false,
  woNumber,
  role,
}: UseWorkOrderActionsParams) {
  const { t } = useTranslation('workOrders');
  const [shareLoading, setShareLoading] = useState(false);
  const [smsLoading, setSmsLoading] = useState(false);
  const [invoiceLoading, setInvoiceLoading] = useState(false);
  const [invoiceConflict, setInvoiceConflict] = useState(false);
  const [saveAsOpen, setSaveAsOpen] = useState(false);

  const [printLoading, setPrintLoading] = useState(false);
  // Рахунок наряду для «Друк рахунку»: null — рахунку немає (або роль його не бачить).
  const [invoiceForPrint, setInvoiceForPrint] = useState<{ id: string; number: string } | null>(
    null,
  );

  const canShare = isEditMode && WO_SHAREABLE_STATUSES.includes(currentStatus);
  const canInvoice = isEditMode && WO_INVOICEABLE_STATUSES.includes(currentStatus);
  // BR-WO-013: наряд-замовлення друкується від «Виконано»; до того — кошторис (canShare).
  const canPrintOrder =
    isEditMode && !viewOnly && WO_INVOICE_VISIBLE_STATUSES.includes(currentStatus);
  const mayPrintInvoice = !!role && INVOICE_PRINT_ROLES.includes(role);
  const canPrintInvoice = canPrintOrder && mayPrintInvoice && !!invoiceForPrint;

  // Рахунок наряду підтягується, коли наряд дійшов до «Виконано» і роль може його друкувати.
  // Повторно — при зміні статусу (рахунок міг з'явитись/скасуватись в іншому місці).
  useEffect(() => {
    if (!workOrderId || !canPrintOrder || !mayPrintInvoice) {
      setInvoiceForPrint(null);
      return;
    }
    let cancelled = false;
    apiFetch<{ id: string; number: string } | null>(`/invoices/from-work-order/${workOrderId}/find`)
      .then(inv => {
        if (!cancelled) setInvoiceForPrint(inv ? { id: inv.id, number: inv.number } : null);
      })
      .catch(() => {
        if (!cancelled) setInvoiceForPrint(null);
      });
    return () => {
      cancelled = true;
    };
  }, [workOrderId, canPrintOrder, mayPrintInvoice, currentStatus]);

  const reportError = (e: unknown, fallback: string) => {
    const msg = e instanceof Error && e.message ? e.message : fallback;
    if (features.toastEnabled) toast.error(msg);
    else setError(msg);
  };

  // BR-WO-013: серверний PDF наряд-замовлення. printPdf відкриває вікно СИНХРОННО — він перший
  // виклик обробника, до будь-якого await (інакше браузер заблокує вікно).
  const handlePrintOrder = async () => {
    if (!workOrderId) return;
    setPrintLoading(true);
    try {
      await printPdf(
        () => apiBlobFetch(`/work-orders/${workOrderId}/pdf`),
        t('print.orderTitle', { number: woNumber ?? '' }),
      );
    } catch (e: unknown) {
      reportError(e, t('print.error'));
    } finally {
      setPrintLoading(false);
    }
  };

  const handleSaveOrderPdf = async () => {
    if (!workOrderId) return;
    setPrintLoading(true);
    try {
      const blob = await apiBlobFetch(`/work-orders/${workOrderId}/pdf`);
      downloadBlob(blob, `work-order-${woNumber || workOrderId}.pdf`);
    } catch (e: unknown) {
      reportError(e, t('print.error'));
    } finally {
      setPrintLoading(false);
    }
  };

  const handlePrintInvoice = async () => {
    if (!invoiceForPrint) return;
    const inv = invoiceForPrint;
    setPrintLoading(true);
    try {
      await printPdf(
        () => apiBlobFetch(`/invoices/${inv.id}/pdf`),
        t('print.invoiceTitle', { number: inv.number }),
      );
    } catch (e: unknown) {
      reportError(e, t('print.error'));
    } finally {
      setPrintLoading(false);
    }
  };

  // useCapture + stopImmediatePropagation: батьківський <Modal> теж слухає Esc на document
  // (bubble-фаза), тож без capture+stop Esc закрив би одразу і conflict-dialog, і WO modal.
  // Capture-фаза гарантує що наш listener fire-ить ПЕРШИМ; stopImmediatePropagation відсікає
  // подальші listeners на document (включно з Modal handler).
  useEscapeCapture(invoiceConflict, () => {
    if (!invoiceLoading) setInvoiceConflict(false);
  });

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
      downloadBlob(blob, filename);
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
      if (features.toastEnabled) toast.success(t('actions.linkCopied'));
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
      if (features.toastEnabled) toast.success(t('actions.smsSent'));
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
    setInvoiceLoading(true);
    try {
      if (currentStatus === 'COMPLETED') {
        const updated = await apiFetch<{ status?: string } | null>(
          `/work-orders/${workOrderId}/transition`,
          { method: 'POST', body: JSON.stringify({ status: 'INVOICED' }) },
        );
        // Статус — з відповіді: сплачений повністю наряд іде далі до «Оплачено» (BR-WO-016).
        setCurrentStatus(updated?.status ?? 'INVOICED');
        onUpdated?.();
      }
      const invoice = await apiFetch<{ id: string; number: string }>(
        `/invoices/from-work-order/${workOrderId}`,
        { method: 'POST' },
      );
      // тригернути перезавантаження LinkedDocumentsPanel, інакше "Документи"
      // tab не показує щойно створений рахунок без manual tab-switch.
      setLinkedDocsRefreshKey(k => k + 1);
      // «Друк рахунку» з'являється одразу, без повторного запиту рахунку наряду.
      if (mayPrintInvoice) setInvoiceForPrint({ id: invoice.id, number: invoice.number });
      if (features.toastEnabled) {
        toast.success(t('invoice.createdToast', { number: invoice.number }), 6000, {
          label: t('invoice.openAction'),
          onClick: () => window.open(`/invoices/${invoice.id}`, '_blank'),
        });
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : '';
      if (msg.includes('вже існує')) {
        setInvoiceConflict(true);
      } else {
        // Наряд лишається «Виставлено»: зворотного переходу в «Виконано» FSM не має (колишній
        // «відкат» сервер завжди відхиляв), рахунок можна створити повторно кнопкою.
        if (features.toastEnabled) toast.error(msg || t('invoice.createError'));
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
        toast.success(t('invoice.updatedToast', { number: invoice.number }), 6000, {
          label: t('invoice.openAction'),
          onClick: () => window.open(`/invoices/${invoice.id}`, '_blank'),
        });
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : t('invoice.refreshError');
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
          toast.warning(t('invoice.notFound'));
        } else {
          setError(t('invoice.notFound'));
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
    printLoading,
    invoiceConflict,
    setInvoiceConflict,
    saveAsOpen,
    setSaveAsOpen,
    canShare,
    canInvoice,
    canPrintOrder,
    canPrintInvoice,
    handlePrint,
    handlePrintOrder,
    handleSaveOrderPdf,
    handlePrintInvoice,
    handleSaveAs,
    handleShare,
    handleSendSms,
    handleInvoice,
    handleInvoiceRefresh,
    handleInvoiceOpen,
  };
}
