'use client';

import { useRequireAuth } from '@/lib/auth';

export default function DashboardPage() {
  const { employee } = useRequireAuth();

  if (!employee) return null;

  return (
    <div className="min-h-screen bg-gray-50 p-8">
      <h1 className="text-2xl font-bold text-gray-900">
        Вітаємо, {employee.firstName} {employee.lastName}!
      </h1>
      <p className="text-gray-500 mt-2">Роль: {employee.role}</p>
      <p className="text-gray-400 text-sm mt-1">Dashboard — розробляється</p>
    </div>
  );
}
