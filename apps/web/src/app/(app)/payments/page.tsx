import { LegacyRouteRedirect } from '@/components/LegacyRouteRedirect';

// Сторінки «Оплати клієнтів» більше немає: готівкові оплати контрагентів вносять у касі,
// решту видно в «Пов'язаних документах» рахунку. Стара адреса веде в касу.
export default function PaymentsLegacyPage() {
  return <LegacyRouteRedirect to="/cash" />;
}
