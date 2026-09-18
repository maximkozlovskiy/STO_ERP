import { Suspense } from 'react';
import PageClient from './PageClient';

// Static export: генеруємо placeholder-shell; реальний id читається клієнтом через useParams()
// (дзеркалить counterparties/supplier-payments/[id]). Без цього `output:'export'` падає на build.
export function generateStaticParams() {
  return [{ id: '_' }];
}

export default function PaymentDetailPage() {
  return (
    <Suspense fallback={null}>
      <PageClient />
    </Suspense>
  );
}
