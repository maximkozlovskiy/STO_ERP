'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';

export default function RootPage() {
  const router = useRouter();

  useEffect(() => {
    fetch(`${API_URL}/api/setup/status`)
      .then((r) => r.json())
      .then((d: { initialized: boolean }) => {
        if (!d.initialized) {
          router.replace('/setup');
          return;
        }
        // If a token exists, try to go straight to dashboard
        const token = sessionStorage.getItem('sto_access_token');
        router.replace(token ? '/dashboard' : '/login');
      })
      .catch(() => router.replace('/login'));
  }, [router]);

  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin" />
    </div>
  );
}
