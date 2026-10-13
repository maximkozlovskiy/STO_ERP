import { LegacyRouteRedirect } from '@/components/LegacyRouteRedirect';

// Сторінки «Оплати постачальникам» більше немає: графік оплат — вкладка «Купівлі», оплату
// постачальнику вносять у касі або з картки замовлення. Стара адреса веде на графік.
export default function SupplierPaymentsLegacyPage() {
  return <LegacyRouteRedirect to="/purchase-orders?tab=schedule" />;
}
