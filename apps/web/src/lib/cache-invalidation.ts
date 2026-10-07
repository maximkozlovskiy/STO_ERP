import type { QueryClient } from '@tanstack/react-query';
import type { PaginatedResponse } from '@/hooks/api/usePaginatedList';
import { warrantiesKeys } from '@/hooks/api/useWarranties';
import { workOrdersKeys } from '@/hooks/api/useWorkOrders';
import { inventoryKeys } from '@/hooks/api/useInventory';
import { counterpartiesKeys } from '@/hooks/api/useCounterparties';
import { stockDocsKeys } from '@/hooks/api/useStockDocuments';
import { supplierPaymentsKeys } from '@/hooks/api/useSupplierPayments';
import { purchaseOrdersKeys } from '@/hooks/api/usePurchaseOrders';
import { invoicesKeys } from '@/hooks/api/useInvoices';
import { reportsKeys } from '@/hooks/api/useReports';
import { dashboardKeys } from '@/hooks/api/useDashboardData';
import { paymentsKeys } from '@/hooks/api/usePayments';
import { vehicleMileageKeys } from '@/hooks/api/useVehicleMileage';

/**
 * Спільні cross-cache інвалідатори (WEB-H1/H2 з аудиту).
 *
 * Мутація в одному домені часто рухає дані, видимі в кеші ІНШОГО домену (напр. завершення
 * наряду списує склад + нараховує борг → «Залишки» й «Взаєморозрахунки» мають оновитись).
 * Раніше кожна сторінка інвалідувала лише власний ключ → сусідні вкладки показували застаріле
 * до staleTime. Ці хелпери — одне джерело правди «які кеші чіпає рух складу / балансу».
 *
 * `void` перед кожним `invalidateQueries` — НАВМИСНО, не глушення лінту. Інвалідація
 * фонова: TanStack Query сам перезапитує активні queries і сам тримає error-стан кожної
 * з них (його показує відповідний компонент). Чекати тут нічого — користувач уже бачить
 * результат мутації, а дані підтягнуться. Усі ці функції оголошені `: void`, тобто й
 * виклична сторона не має на що чекати.
 *
 * Використання у onSuccess мутації або після дії:
 *   invalidateStockAffected(queryClient);   // рух складу
 *   invalidateBalanceAffected(queryClient); // рух балансу контрагента
 */

/** Рух ЗАЛИШКІВ: списання/прихід/переміщення → інвентар + звіти + дашборд (low-stock). */
export function invalidateStockAffected(qc: QueryClient): void {
  void qc.invalidateQueries({ queryKey: inventoryKeys.all });
  void qc.invalidateQueries({ queryKey: reportsKeys.all });
  void qc.invalidateQueries({ queryKey: dashboardKeys.all });
}

/** Рух БАЛАНСУ контрагента: CHARGE/PAYMENT → контрагенти + звіти + дашборд. */
export function invalidateBalanceAffected(qc: QueryClient): void {
  void qc.invalidateQueries({ queryKey: counterpartiesKeys.all });
  void qc.invalidateQueries({ queryKey: reportsKeys.all });
  void qc.invalidateQueries({ queryKey: dashboardKeys.all });
}

/**
 * Клієнтський платіж (payments.create): рухає settlement-баланс контрагента, invoice.paidAmount/
 * status, workOrder.paidAmount, і сам список платежів. Один хелпер — щоб КОЖНА точка створення
 * платежу (invoices-сторінка, QR-onPaid, useCreatePayment, cash) інвалідувала УВЕСЬ крос-ресурс,
 * а не лише власний ключ (WEB-R3-1/-2: invoices-сторінка інвалідувала тільки invoicesKeys →
 * баланс контрагента/WO лишались застарілими до staleTime).
 */
export function invalidatePaymentSideEffects(qc: QueryClient): void {
  void qc.invalidateQueries({ queryKey: invoicesKeys.all });
  void qc.invalidateQueries({ queryKey: workOrdersKeys.all });
  void qc.invalidateQueries({ queryKey: paymentsKeys.all });
  invalidateBalanceAffected(qc);
}

/**
 * Завершення/скасування наряду: рухає І склад (writeoff запчастин), І баланс (CHARGE), плюс
 * власний список нарядів та рахунки (auto-invoice). Один виклик замість 5 розкиданих.
 *
 * Плюс історія пробігу авто: вона будується з нарядів (BR-VEH-001/002) — завершення міняє
 * дату запису на `completedAt`, скасування прибирає запис. Без цього картка авто, відкрита
 * в межах staleTime після переходу наряду, показувала б стару історію.
 */
export function invalidateWorkOrderSideEffects(qc: QueryClient): void {
  void qc.invalidateQueries({ queryKey: workOrdersKeys.all });
  void qc.invalidateQueries({ queryKey: vehicleMileageKeys.all });
  void qc.invalidateQueries({ queryKey: invoicesKeys.all });
  invalidateStockAffected(qc);
  invalidateBalanceAffected(qc);
}

/**
 * Гарантія (create / claim): рухає списки гарантій ПЛЮС дашборд-віджет «Гарантії, що
 * закінчуються». Віджет читає окремий ключ `dashboardKeys.expiringWarranties()`, а не
 * `warrantiesKeys` — тому інвалідація лише `warrantiesKeys.all` лишала його застарілим до
 * staleTime (claimed/нова гарантія не зникала/не з'являлась на дашборді). Один хелпер — щоб
 * КОЖНА точка мутації гарантії чіпала обидва дерева ключів (WEB-Bug #718).
 */
export function invalidateWarrantyAffected(qc: QueryClient): void {
  void qc.invalidateQueries({ queryKey: warrantiesKeys.all });
  void qc.invalidateQueries({ queryKey: dashboardKeys.expiringWarranties() });
}

/** Складський документ (RECEIPT/WRITEOFF/TRANSFER) → власний список + рух складу. */
export function invalidateStockDocumentSideEffects(qc: QueryClient): void {
  void qc.invalidateQueries({ queryKey: stockDocsKeys.all });
  invalidateStockAffected(qc);
}

/** Прийом/оплата замовлення постачальнику → PO + склад + баланс постачальника + оплати. */
export function invalidatePurchaseSideEffects(qc: QueryClient): void {
  void qc.invalidateQueries({ queryKey: purchaseOrdersKeys.all });
  void qc.invalidateQueries({ queryKey: supplierPaymentsKeys.all });
  invalidateStockAffected(qc);
  invalidateBalanceAffected(qc);
}

/**
 * Оптимістичний патч ОДНОГО рядка у ВСІХ закешованих paginated-списках під заданим
 * key-factory (`lists()` → префікс `[all, 'list']`). Знаходить елемент за id у `items`
 * кожного кешованого запиту й застосовує `patch`. Повертає restorer, що відновлює УСІ
 * знімки — для `onError` rollback.
 *
 * Використання у оптимістичній мутації:
 *   onMutate: async ({ id, status }) => {
 *     await qc.cancelQueries({ queryKey: workOrdersKeys.lists() });
 *     return patchListItem(qc, workOrdersKeys.lists(), id, o => ({ ...o, status }));
 *   },
 *   onError: (_e, _v, restore) => restore?.(),
 *   onSettled: () => invalidateWorkOrderSideEffects(qc),
 */
export function patchListItem<T extends { id: string }>(
  qc: QueryClient,
  listsKey: readonly unknown[],
  id: string,
  patch: (item: T) => T,
): () => void {
  const snapshots = qc.getQueriesData<PaginatedResponse<T>>({ queryKey: listsKey });
  for (const [key, data] of snapshots) {
    if (!data?.items?.some(it => it.id === id)) continue;
    qc.setQueryData<PaginatedResponse<T>>(key, {
      ...data,
      items: data.items.map(it => (it.id === id ? patch(it) : it)),
    });
  }
  return () => {
    for (const [key, data] of snapshots) qc.setQueryData(key, data);
  };
}
