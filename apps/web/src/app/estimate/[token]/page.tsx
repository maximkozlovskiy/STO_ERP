import { Suspense } from 'react';
import EstimateClient from './EstimateClient';

// Static export: placeholder-shell; реальний token читається клієнтом через useParams()
// (дзеркалить [id]-роути). Без generateStaticParams `output:'export'` падає на build.
// Публічна сторінка кошторису (share-лінк) — україномовна за дизайном.
export function generateStaticParams() {
  return [{ token: '_' }];
}

export default function EstimatePage() {
  return (
    <Suspense fallback={null}>
      <EstimateClient />
    </Suspense>
  );
}
