import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import type { TFunction } from 'i18next';
import { purchaseListsApi } from '@/hooks/api/usePurchaseLists';
import type { ConfirmOptions } from '@/hooks/useConfirm';
import { invalidateProcurementSideEffects } from '@/lib/cache-invalidation';
import { toast } from '@/lib/toast';

/**
 * Дія «Управління купівлями» над вибраними позиціями чи списком. `run(fn)`: поки йде — `busy`;
 * `fn` повертає текст тосту (порожній — без тосту) або `null` — дію не виконано (відмова в
 * підтвердженні), тоді нічого не скидається. Після дії — тост, `onDone` (зняти вибір) і
 * перечитування кешу; помилка — тостом і теж перечитуванням (сервер міг виконати частину).
 * `done(message)` — те саме для діалогів, що виконали запит самі.
 */
export function useProcurementAction(onDone: () => void) {
  const { t } = useTranslation('purchaseLists');
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);

  const done = (message: string) => {
    if (message) toast.success(message);
    onDone();
    invalidateProcurementSideEffects(qc);
  };

  const run = async (fn: () => Promise<string | null>) => {
    setBusy(true);
    try {
      const message = await fn();
      if (message !== null) done(message);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : t('errors.action'));
      invalidateProcurementSideEffects(qc);
    } finally {
      setBusy(false);
    }
  };

  return { busy, run, done };
}

/**
 * «Створити замовлення» з позицій (BR-PL-008): підтвердження, запит і текст тосту з номерами
 * створених замовлень; `null` — користувач відмовився.
 */
export async function createOrdersFromItems(
  ids: string[],
  confirm: (opts: ConfirmOptions) => Promise<boolean>,
  t: TFunction,
): Promise<string | null> {
  if (!(await confirm({ title: t('items.createOrdersConfirm', { count: ids.length }) }))) {
    return null;
  }
  const res = await purchaseListsApi.createOrders(ids);
  return t('items.ordersCreated', { numbers: res.orders.map(o => o.number).join(', ') });
}
