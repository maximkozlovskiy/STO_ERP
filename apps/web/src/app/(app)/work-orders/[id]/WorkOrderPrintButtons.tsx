'use client';

// «Друк наряду» і «Зберегти PDF» на сторінці наряду — серверний PDF наряд-замовлення з
// логотипом і реквізитами організації (BR-WO-013). Винесено з PageClient, щоб гейти (статус,
// видалений наряд) мали компонентний тест.

import { useTranslation } from 'react-i18next';
import { WO_INVOICE_VISIBLE_STATUSES } from '@sto/shared';
import { apiBlobFetch } from '@/lib/api-client';
import { downloadBlob, printPdf } from '@/lib/download';
import { Button } from '@/components/ui/button';

interface WorkOrderPrintButtonsProps {
  workOrderId: string;
  number?: string;
  status: string;
  /** BR-WO-012: сервер видаленого наряду не знаходить (404) — кнопок немає. */
  isDeleted: boolean;
  /** Текст помилки для смуги помилок сторінки ('' — скинути). */
  onError: (message: string) => void;
}

export function WorkOrderPrintButtons({
  workOrderId,
  number,
  status,
  isDeleted,
  onError,
}: WorkOrderPrintButtonsProps) {
  const { t } = useTranslation('workOrders');
  // BR-WO-013: наряд-замовлення — лише від «Виконано»; до того клієнт отримує кошторис.
  if (isDeleted || !WO_INVOICE_VISIBLE_STATUSES.includes(status)) return null;

  const pdfPath = `/work-orders/${workOrderId}/pdf`;

  // printPdf відкриває вікно синхронно — він перший виклик обробника, до будь-якого await.
  const print = async () => {
    onError('');
    try {
      await printPdf(() => apiBlobFetch(pdfPath), t('print.orderTitle', { number: number ?? '' }));
    } catch (e: unknown) {
      onError(e instanceof Error ? e.message : t('print.error'));
    }
  };

  // apiBlobFetch робить silent refresh на 401 — прямий fetch ламався після спливу токена.
  const save = async () => {
    onError('');
    try {
      downloadBlob(await apiBlobFetch(pdfPath), `work-order-${number ?? workOrderId}.pdf`);
    } catch (e: unknown) {
      onError(e instanceof Error ? e.message : t('detail.pdfError'));
    }
  };

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => void print()}>
        {t('print.order')}
      </Button>
      <Button variant="outline" size="sm" onClick={() => void save()}>
        {t('print.savePdf')}
      </Button>
    </>
  );
}
