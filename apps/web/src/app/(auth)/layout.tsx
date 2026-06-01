import type { ReactNode } from 'react';
import { AuthProvider } from '@/lib/auth';

export default function AuthLayout({ children }: { children: ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}
