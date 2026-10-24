import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  WO_SHAREABLE_STATUSES,
  WO_INVOICEABLE_STATUSES,
  WO_INVOICE_VISIBLE_STATUSES,
} from '@sto/shared';
import type { ApiSchema } from '@sto/shared';
import { apiFetch, apiBlobFetch } from '@/lib/api-client';
import { toast } from '@/lib/toast';
import { downloadBlob, printPdf } from '@/lib/download';
import { useEscapeLayer } from './useEscapeLayer';

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

type ShareToken = ApiSchema<'WorkOrderShareTokenResponseDto'>;

/**
 * BR-WO-032: що картка знає про посилання на кошторис після дії «Поділитись». `null` — ще не
 * питали (картка нічого не показує); `revoked` — відкликали з цієї картки.
 */
export type ShareLinkState =
  { status: 'active'; token: string; expiresAt: string } | { status: 'revoked' } | null;

export const shareUrl = (token: string) => `${window.location.origin}/estimate/${token}`;

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
  // BR-WO-032: панель посилання (дата згорання, «Згенерувати нове», «Відкликати»).
  const [shareOpen, setShareOpen] = useState(false);
  const [shareLink, setShareLink] = useState<ShareLinkState>(null);

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

  // BR-WO-032: друк, «Зберегти як» і «Поділитись» беруть токен одним запитом; POST міг видати
  // новий (старий прострочений чи відкликаний) — панель посилання бачить актуальний.
  const issueShareToken = async (): Promise<ShareToken> => {
    const res = await apiFetch<ShareToken>(`/work-orders/${workOrderId}/share-token`, {
      method: 'POST',
    });
    setShareLink({ status: 'active', token: res.token, expiresAt: res.expiresAt });
    return res;
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

  // Інший наряд у тій самій картці — посилання попереднього не показуємо.
  useEffect(() => {
    setShareOpen(false);
    setShareLink(null);
  }, [workOrderId]);
  // Панель посилання — шар над карткою: Escape закриває лише її.
  useEscapeLayer(shareOpen, () => setShareOpen(false));

  // Діалог конфлікту — власний оверлей, не <Modal>: шар Escape над карткою наряду. Esc закриває лише
  // його (поки запит не в польоті), картка лишається.
  useEscapeLayer(invoiceConflict, () => {
    if (!invoiceLoading) setInvoiceConflict(false);
  });

  const handlePrint = async () => {
    if (!workOrderId) return;
    // Open blank window synchronously inside click handler — browsers block window.open after await.
    const win = window.open('', '_blank');
    setShareLoading(true);
    try {
      const { token } = await issueShareToken();
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
      const { token } = await issueShareToken();
      const apiBase = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';
      const res = await fetch(`${apiBase}/api/public/work-orders/${token}/export/${format}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const disposition = res.headers.get('content-disposition') ?? '';
      const match =
        disposition.match(/filename\*=UTF-8''(.+)/i) ?? disposition.match(/filename="?([^"]+)"?/i);
      // Назва — із Content-Disposition сервера («Кошторис-<номер>.<формат>»). Якщо заголовка не
      // видно (проксі чи CORS його сховали), запасна назва теж несе номер наряду.
      const safeNumber = (woNumber || workOrderId).replace(/[/\\:*?"<>|]/g, '-');
      const filename = match ? decodeURIComponent(match[1]) : `Кошторис-${safeNumber}.${format}`;
      downloadBlob(blob, filename);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Помилка';
      if (features.toastEnabled) toast.error(msg);
      else setError(msg);
    } finally {
      setShareLoading(false);
    }
  };

  const reportShareError = (e: unknown) => {
    const msg = e instanceof Error ? e.message : 'Помилка';
    if (features.toastEnabled) toast.error(msg);
    else setError(msg);
  };

  // Буфер обміну недоступний поза HTTPS/localhost і без дозволу — посилання все одно видно в
  // панелі, тож відмова копіювання не є помилкою дії.
  const copyShareLink = async (token: string, successKey: string) => {
    try {
      await navigator.clipboard.writeText(shareUrl(token));
      if (features.toastEnabled) toast.success(t(successKey));
    } catch {
      /* посилання лишається в панелі для ручного копіювання */
    }
  };

  const handleShare = async () => {
    if (!workOrderId) return;
    setShareLoading(true);
    try {
      const { token } = await issueShareToken();
      setShareOpen(true);
      await copyShareLink(token, 'actions.linkCopied');
    } catch (e: unknown) {
      reportShareError(e);
    } finally {
      setShareLoading(false);
    }
  };

  const handleCopyShareLink = async () => {
    if (shareLink?.status !== 'active') return;
    await copyShareLink(shareLink.token, 'share.copied');
  };

  // BR-WO-032: «Згенерувати нове» — старе посилання відкликається, видається нове на 30 днів.
  // POST сам по собі повертає ЧИННИЙ токен, тому чинний спершу відкликаємо.
  const handleRegenerateShare = async () => {
    if (!workOrderId) return;
    setShareLoading(true);
    try {
      if (shareLink?.status === 'active') {
        await apiFetch(`/work-orders/${workOrderId}/share-token`, { method: 'DELETE' });
        setShareLink({ status: 'revoked' });
      }
      const { token } = await issueShareToken();
      await copyShareLink(token, 'share.regenerated');
    } catch (e: unknown) {
      reportShareError(e);
    } finally {
      setShareLoading(false);
    }
  };

  const handleRevokeShare = async () => {
    if (!workOrderId) return;
    setShareLoading(true);
    try {
      await apiFetch(`/work-orders/${workOrderId}/share-token`, { method: 'DELETE' });
      setShareLink({ status: 'revoked' });
      if (features.toastEnabled) toast.success(t('share.revoked'));
    } catch (e: unknown) {
      reportShareError(e);
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
    shareOpen,
    setShareOpen,
    shareLink,
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
    handleCopyShareLink,
    handleRegenerateShare,
    handleRevokeShare,
    handleSendSms,
    handleInvoice,
    handleInvoiceRefresh,
    handleInvoiceOpen,
  };
}
