'use client';

import { useEffect, useRef, useState } from 'react';
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
 * QR-оплата (активний шлюз філії: monobank/LiqPay): створює намір → показує QR (клієнт сканує й
 * платить на сторінці шлюзу) → polling статусу → «Оплачено ✅». QR на екрані термінала
 * (offline-first: клієнт платить на стороні шлюзу, ми лише опитуємо статус — без публічного endpoint).
 */
export function QrPaymentModal({ open, invoiceId, amount, onClose, onPaid }: Props) {
  const createIntent = useCreateOnlinePayment();
  const [intent, setIntent] = useState<OnlineIntent | null>(null);
  const [error, setError] = useState('');
  // WEB-R3-6: латч — onPaid() має спрацювати РІВНО раз за життя відкриття модалки. Ефект нижче
  // залежить від status, але refetch/reopen можуть повторно давати status='PAID' → без латча
  // onPaid (крос-кеш invalidate) викликався б повторно. Скидається на кожне відкриття.
  const paidFired = useRef(false);

  // Створюємо намір при відкритті модалки.
  useEffect(() => {
    if (!open || !invoiceId) return;
    let cancelled = false;
    setIntent(null);
    setLive(null);
    setError('');
    paidFired.current = false;
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

  // Гейт полінгу має реагувати на ОСТАННІЙ відомий статус (live, коли вже прийшов), а не лише
  // на статус зі створення наміру — інакше polling ніколи не зупиниться після PAID/FAILED/EXPIRED.
  const [live, setLive] = useState<OnlineIntent | null>(null);
  const status = live?.status ?? intent?.status;
  const isPending = status === 'PENDING';
  const { data: polled } = useOnlineIntentStatus(intent?.id ?? null, open && isPending);

  useEffect(() => {
    if (polled) setLive(polled);
  }, [polled]);

  // На PAID — сповістити батька (invalidate) РІВНО один раз (латч, WEB-R3-6).
  useEffect(() => {
    if (status === 'PAID' && !paidFired.current) {
      paidFired.current = true;
      onPaid();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  return (
    <Modal open={open} onClose={onClose} title="QR-оплата" size="sm">
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
