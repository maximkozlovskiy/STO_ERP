import type { QueryClient } from '@tanstack/react-query';
import { workOrdersKeys } from '@/hooks/api/useWorkOrders';
import { inventoryKeys } from '@/hooks/api/useInventory';
import { counterpartiesKeys } from '@/hooks/api/useCounterparties';
import { stockDocsKeys } from '@/hooks/api/useStockDocuments';
import { supplierPaymentsKeys } from '@/hooks/api/useSupplierPayments';
import { purchaseOrdersKeys } from '@/hooks/api/usePurchaseOrders';
import { invoicesKeys } from '@/hooks/api/useInvoices';
import { reportsKeys } from '@/hooks/api/useReports';
import { dashboardKeys } from '@/hooks/api/useDashboardData';

/**
 * Спільні cross-cache інвалідатори (WEB-H1/H2 з аудиту).
 *
 * Мутація в одному домені часто рухає дані, видимі в кеші ІНШОГО домену (напр. завершення
 * наряду списує склад + нараховує борг → «Залишки» й «Взаєморозрахунки» мають оновитись).
 * Раніше кожна сторінка інвалідувала лише власний ключ → сусідні вкладки показували застаріле
 * до staleTime. Ці хелпери — одне джерело правди «які кеші чіпає рух складу / балансу».
 *
 * Використання у onSuccess мутації або після дії:
 *   invalidateStockAffected(queryClient);   // рух складу
 *   invalidateBalanceAffected(queryClient); // рух балансу контрагента
 */

/** Рух ЗАЛИШКІВ: списання/прихід/переміщення → інвентар + звіти + дашборд (low-stock). */
export function invalidateStockAffected(qc: QueryClient): void {
  qc.invalidateQueries({ queryKey: inventoryKeys.all });
  qc.invalidateQueries({ queryKey: reportsKeys.all });
  qc.invalidateQueries({ queryKey: dashboardKeys.all });
}

/** Рух БАЛАНСУ контрагента: CHARGE/PAYMENT → контрагенти + звіти + дашборд. */
export function invalidateBalanceAffected(qc: QueryClient): void {
  qc.invalidateQueries({ queryKey: counterpartiesKeys.all });
  qc.invalidateQueries({ queryKey: reportsKeys.all });
  qc.invalidateQueries({ queryKey: dashboardKeys.all });
}

/**
 * Завершення/скасування наряду: рухає І склад (writeoff запчастин), І баланс (CHARGE), плюс
 * власний список нарядів та рахунки (auto-invoice). Один виклик замість 5 розкиданих.
 */
export function invalidateWorkOrderSideEffects(qc: QueryClient): void {
  qc.invalidateQueries({ queryKey: workOrdersKeys.all });
  qc.invalidateQueries({ queryKey: invoicesKeys.all });
  invalidateStockAffected(qc);
  invalidateBalanceAffected(qc);
}

/** Складський документ (RECEIPT/WRITEOFF/TRANSFER) → власний список + рух складу. */
export function invalidateStockDocumentSideEffects(qc: QueryClient): void {
  qc.invalidateQueries({ queryKey: stockDocsKeys.all });
  invalidateStockAffected(qc);
}

/** Прийом/оплата замовлення постачальнику → PO + склад + баланс постачальника + оплати. */
export function invalidatePurchaseSideEffects(qc: QueryClient): void {
  qc.invalidateQueries({ queryKey: purchaseOrdersKeys.all });
  qc.invalidateQueries({ queryKey: supplierPaymentsKeys.all });
  invalidateStockAffected(qc);
  invalidateBalanceAffected(qc);
}
