'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';

export default function RootPage() {
  const { employee, isLoading } = useAuth();
  const router = useRouter();
  const [setupChecked, setSetupChecked] = useState(false);

  useEffect(() => {
    fetch(`${API_URL}/api/setup/status`)
      .then((r) => r.json())
      .then((d: { initialized: boolean }) => {
        if (!d.initialized) {
          router.replace('/setup');
        } else {
          setSetupChecked(true);
        }
      })
      .catch(() => setSetupChecked(true));
  }, [router]);

  useEffect(() => {
    if (!setupChecked || isLoading) return;
    if (employee) {
      router.replace('/dashboard');
    } else {
      router.replace('/login');
    }
  }, [employee, isLoading, router, setupChecked]);

  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin" />
    </div>
  );
}
