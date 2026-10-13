import { LegacyRouteRedirect } from '@/components/LegacyRouteRedirect';

// Static export: оболонка-заглушка; справжній id у старому посиланні значення не має —
// картки оплати постачальнику більше немає, адреса веде на графік оплат у «Купівлі».
export function generateStaticParams() {
  return [{ id: '_' }];
}

export default function SupplierPaymentLegacyCardPage() {
  return <LegacyRouteRedirect to="/purchase-orders?tab=schedule" />;
}
