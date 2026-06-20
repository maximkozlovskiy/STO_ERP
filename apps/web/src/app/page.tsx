'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
// root `/` — публічна сторінка; `apiFetch` шле stale Authorization і при 401
// редиректить на `/login`, прихаваючи `setup.initialized=false` сигнал. Використовуємо
// `publicFetch` (без auth header, без auto-redirect).
import { publicFetch } from '@/lib/api-client';

export default function RootPage() {
  const router = useRouter();

  useEffect(() => {
    publicFetch<{ initialized: boolean }>('/setup/status')
      .then(d => {
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
      <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
    </div>
  );
}
