import { canOpenRoute } from '@/lib/nav';

/**
 * Сторінка документа з журналу чи дзвіночка: список із карткою в адресі (`?open=`), повернення
 * постачальнику — на сторінці купівлі (`?openReturn=`). `null` — сторінки немає
 * або роль її не відкриває (BR-AUT-021: текст сповіщення видно, перехід — ні).
 */
export function automationDocumentHref(
  type: string | null | undefined,
  id: string | null | undefined,
  role: string | null | undefined,
): string | null {
  if (!type || !id) return null;
  const enc = encodeURIComponent(id);
  const route = ((): { list: string; href: string } | null => {
    switch (type) {
      case 'WORK_ORDER':
        return { list: '/work-orders', href: `/work-orders?open=${enc}` };
      case 'INVOICE':
        return { list: '/invoices', href: `/invoices?open=${enc}` };
      case 'PURCHASE_ORDER':
        return { list: '/purchase-orders', href: `/purchase-orders?open=${enc}` };
      case 'SUPPLIER_RETURN':
        return { list: '/purchase-orders', href: `/purchase-orders?openReturn=${enc}` };
      case 'STOCK_DOCUMENT':
        return { list: '/stock-documents', href: `/stock-documents?open=${enc}` };
      case 'TASK':
        return { list: '/tasks', href: `/tasks?open=${enc}` };
      // Окремої картки оплати немає: оплата клієнта — у касі, оплата постачальнику — у графіку
      // оплат «Купівлі» (старі адреси `/payments/:id`, `/supplier-payments/:id` ведуть туди ж).
      case 'PAYMENT':
        return { list: '/cash', href: '/cash' };
      case 'SUPPLIER_PAYMENT':
        return { list: '/purchase-orders', href: '/purchase-orders?tab=schedule' };
      case 'BOOKING':
        return { list: '/bookings', href: '/bookings' };
      default:
        return null;
    }
  })();
  if (!route) return null;
  return canOpenRoute(route.list, role) ? route.href : null;
}
