'use client';

import { useRouter } from 'next/navigation';

export default function ForbiddenPage() {
  const router = useRouter();
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-4">
      <h1 className="text-4xl font-bold text-gray-900">403</h1>
      <p className="text-gray-500">Недостатньо прав для доступу до цієї сторінки</p>
      <button
        onClick={() => router.back()}
        className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm"
      >
        Назад
      </button>
    </div>
  );
}
