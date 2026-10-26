import { LegacyRouteRedirect } from '@/components/LegacyRouteRedirect';

// Static export: оболонка-заглушка; справжній id у старому посиланні значення не має —
// картки оплати клієнта більше немає, адреса веде в касу (як і `/payments`).
export function generateStaticParams() {
  return [{ id: '_' }];
}

export default function PaymentLegacyCardPage() {
  return <LegacyRouteRedirect to="/cash" />;
}
