'use client';

import { useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Check, X, Loader2 } from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import {
  useCreateOnlinePayment,
  useOnlineIntentStatus,
  type OnlineIntent,
} from '@/hooks/api/useOnlinePayment';

interface Props {
  open: boolean;
  invoiceId: string | null;
  amount?: number; // сума часткової оплати (порожньо → залишок на бекенді)
  onClose: () => void;
  onPaid: () => void; // виклик коли оплату підтверджено (invalidate списків)
}

/**
 * QR-оплата monobank: створює намір → показує QR (клієнт сканує й платить на сторінці monobank)
 * → polling статусу → «Оплачено ✅». QR на екрані термінала (offline-first: клієнт платить на
 * стороні monobank, ми лише опитуємо статус — без публічного endpoint).
 */
export function QrPaymentModal({ open, invoiceId, amount, onClose, onPaid }: Props) {
  const createIntent = useCreateOnlinePayment();
  const [intent, setIntent] = useState<OnlineIntent | null>(null);
  const [error, setError] = useState('');

  // Створюємо намір при відкритті модалки.
  useEffect(() => {
    if (!open || !invoiceId) return;
    let cancelled = false;
    setIntent(null);
    setError('');
    createIntent
      .mutateAsync({ invoiceId, amount })
      .then(i => {
        if (!cancelled) setIntent(i);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Не вдалося створити QR');
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, invoiceId, amount]);

  const isPending = intent?.status === 'PENDING';
  const { data: live } = useOnlineIntentStatus(intent?.id ?? null, open && isPending);
  const status = live?.status ?? intent?.status;

  // На PAID — сповістити батька (invalidate) один раз.
  useEffect(() => {
    if (status === 'PAID') onPaid();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  return (
    <Modal open={open} onClose={onClose} title="QR-оплата (monobank)" size="sm">
      <div className="flex flex-col items-center gap-4 py-2">
        {error ? (
          <p className="text-sm text-destructive-text text-center">{error}</p>
        ) : !intent || createIntent.isPending ? (
          <Spinner />
        ) : status === 'PAID' ? (
          <div className="flex flex-col items-center gap-2 text-success">
            <Check className="h-10 w-10" />
            <p className="text-sm font-medium">Оплачено</p>
            <Button variant="outline" size="sm" onClick={onClose}>
              Закрити
            </Button>
          </div>
        ) : status === 'FAILED' || status === 'EXPIRED' ? (
          <div className="flex flex-col items-center gap-2 text-destructive-text">
            <X className="h-10 w-10" />
            <p className="text-sm font-medium">
              {status === 'EXPIRED' ? 'Час на оплату вичерпано' : 'Оплату відхилено'}
            </p>
            <Button variant="outline" size="sm" onClick={onClose}>
              Закрити
            </Button>
          </div>
        ) : intent.pageUrl ? (
          <>
            <div className="bg-white p-3 rounded-lg">
              <QRCodeSVG value={intent.pageUrl} size={200} />
            </div>
            <p className="text-sm text-muted-foreground text-center">
              Клієнт сканує QR телефоном і оплачує
            </p>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Очікуємо підтвердження…
            </div>
          </>
        ) : (
          <Spinner />
        )}
      </div>
    </Modal>
  );
}
