'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch } from '@/lib/api-client';

export default function RootPage() {
  const router = useRouter();

  useEffect(() => {
    apiFetch<{ initialized: boolean }>('/setup/status')
      .then((d) => {
        if (!d.initialized) {
          router.replace('/setup');
          return;
        }
        const token = sessionStorage.getItem('sto_access_token');
        router.replace(token ? '/dashboard' : '/login');
      })
      .catch(() => router.replace('/login'));
  }, [router]);

  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="w-8 h-8 border-4 border-(--color-primary) border-t-transparent rounded-full animate-spin" />
    </div>
  );
}
