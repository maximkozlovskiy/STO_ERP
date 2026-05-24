'use client';

import { useEffect, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from './context';

interface ProtectedRouteProps {
  children: ReactNode;
  /** Allowed roles. If empty — any authenticated user passes. */
  roles?: string[];
}

export function ProtectedRoute({ children, roles }: ProtectedRouteProps) {
  const { employee, isLoading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (isLoading) return;
    if (!employee) {
      router.replace('/login');
      return;
    }
    if (roles && roles.length > 0 && !roles.includes(employee.role)) {
      router.replace('/403');
    }
  }, [employee, isLoading, roles, router]);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="w-8 h-8 border-4 border-(--color-primary) border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!employee) return null;
  if (roles && roles.length > 0 && !roles.includes(employee.role)) return null;

  return <>{children}</>;
}

/** Hook для використання всередині захищених сторінок */
export function useRequireAuth(roles?: string[]) {
  const auth = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (auth.isLoading) return;
    if (!auth.employee) {
      router.replace('/login');
      return;
    }
    if (roles && roles.length > 0 && !roles.includes(auth.employee.role)) {
      router.replace('/403');
    }
  }, [auth.employee, auth.isLoading, roles, router]);

  return auth;
}
