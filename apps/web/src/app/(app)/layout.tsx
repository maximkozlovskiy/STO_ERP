import type { ReactNode } from 'react';
import { AuthProvider } from '@/lib/auth';
import { TopShell } from '@/components/TopShell';

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <AuthProvider>
      <TopShell>{children}</TopShell>
    </AuthProvider>
  );
}
