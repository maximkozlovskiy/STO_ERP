import { Suspense } from 'react';
import CounterpartyCardPage from './PageClient';

// Static export: generate a placeholder shell; actual id is read client-side via useParams()
export function generateStaticParams() {
  return [{ id: '_' }];
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <CounterpartyCardPage />
    </Suspense>
  );
}
