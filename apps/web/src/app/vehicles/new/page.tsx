import { Suspense } from 'react';
import { Spinner } from '@/components/ui/spinner';
import NewVehiclePageClient from './PageClient';

export default function NewVehiclePage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center min-h-screen"><Spinner size="lg" /></div>}>
      <NewVehiclePageClient />
    </Suspense>
  );
}
