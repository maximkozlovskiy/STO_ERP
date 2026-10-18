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
import { cashKeys } from '@/hooks/api/useCash';
import { purchaseListsKeys } from '@/hooks/api/usePurchaseLists';
import { supplierOffersKeys } from '@/hooks/api/useSupplierOffers';
import { supplierApiOrderKeys } from '@/hooks/api/useSupplierApiOrder';

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
 *
 * Плюс каса: готівкова оплата пише рядок у журнал каси й міняє її залишок. Список кас живе в
 * кеші 5 хвилин, тож без цього «Каса» після оплати з рахунку показувала старий залишок і
 * історію без нового рядка (Bug #848).
 */
export function invalidatePaymentSideEffects(qc: QueryClient): void {
  void qc.invalidateQueries({ queryKey: cashKeys.all });
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
 * дату запису на `completedAt`, скасування прибирає запис. Це потрібно для картки авто, що
 * ЛИШАЄТЬСЯ відкритою під модалкою наряду: повторне відкриття картки історію й так
 * перечитує (`staleTime: 0` у useVehicleMileage, Bug #799).
 */
export function invalidateWorkOrderSideEffects(qc: QueryClient): void {
  void qc.invalidateQueries({ queryKey: workOrdersKeys.all });
  // Скасування/завершення наряду скасовує його незамовлені позиції списків купівлі (BR-PL-013).
  void qc.invalidateQueries({ queryKey: purchaseListsKeys.all });
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

/**
 * Прийом/оплата замовлення постачальнику → PO + склад + баланс постачальника + оплати + каса
 * (оплата з каси списує готівку — Bug #848).
 */
export function invalidatePurchaseSideEffects(qc: QueryClient): void {
  void qc.invalidateQueries({ queryKey: cashKeys.all });
  void qc.invalidateQueries({ queryKey: purchaseOrdersKeys.all });
  // Приймання розподіляє отримане між позиціями списків і резервує під наряди (BR-PL-011);
  // скасування й видалення замовлення повертає позиції в «Не замовлено» (BR-PL-010).
  void qc.invalidateQueries({ queryKey: purchaseListsKeys.all });
  void qc.invalidateQueries({ queryKey: supplierPaymentsKeys.all });
  // Скасування чи видалення замовлення змінює стан його передачі в API (BR-SCON-014).
  void qc.invalidateQueries({ queryKey: supplierApiOrderKeys.all });
  invalidateStockAffected(qc);
  invalidateBalanceAffected(qc);
}

/**
 * Дії «Управління купівлями» (списки, позиції, замовлення зі списку, «Зняти резерв», вибір і
 * автопідбір пропозицій, передача замовлення в API): власні ключі списків і позицій (зокрема стан
 * товарів у картці наряду), замовлення постачальникам (create-orders створює DRAFT, «Відправити в
 * API» з чернетки — «Замовлено»), пропозиції позицій (позначка «обрано»), стан передачі в API і
 * склад (зняття резерву міняє «вільно»).
 */
export function invalidateProcurementSideEffects(qc: QueryClient): void {
  void qc.invalidateQueries({ queryKey: purchaseListsKeys.all });
  void qc.invalidateQueries({ queryKey: purchaseOrdersKeys.all });
  void qc.invalidateQueries({ queryKey: supplierOffersKeys.all });
  void qc.invalidateQueries({ queryKey: supplierApiOrderKeys.all });
  invalidateStockAffected(qc);
}

/**
 * Сторно касової операції (BR-CASH-023…025). Яку саме операцію сторновано, видно лише на
 * сервері, а наслідки різні: оплата контрагента повертає «сплачено» рахунку й наряду та борг
 * (як оплата, лише навпаки), оплата постачальнику — «сплачено» замовлення й статус оплати
 * постачальнику, повернення — баланс контрагента. Тому скидаємо обидва дерева: оплат і
 * закупівель (обидва вже включають касу й баланс контрагента).
 */
export function invalidateCashReversalSideEffects(qc: QueryClient): void {
  invalidatePaymentSideEffects(qc);
  void qc.invalidateQueries({ queryKey: purchaseOrdersKeys.all });
  void qc.invalidateQueries({ queryKey: supplierPaymentsKeys.all });
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
