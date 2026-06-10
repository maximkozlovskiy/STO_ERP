import type { ReactNode } from 'react';
import { AuthProvider } from '@/lib/auth';
import { TopShell } from '@/components/TopShell';
import { TabBarProvider } from '@/contexts/TabBarContext';

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <AuthProvider>
      <TabBarProvider>
        <TopShell>{children}</TopShell>
      </TabBarProvider>
    </AuthProvider>
  );
}
