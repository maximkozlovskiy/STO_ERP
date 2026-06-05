'use client';

import { useRequireAuth } from '@/lib/auth';
import { SettlementsTabContent } from './SettlementsTabContent';

export default function SettlementsPage() {
  useRequireAuth(['OWNER', 'ADMIN', 'ACCOUNTANT']);

  return (
    <div className="page-fill p-4 md:p-6 flex flex-col">
      <h1 className="page-title shrink-0">Взаєморозрахунки</h1>
      <SettlementsTabContent />
    </div>
  );
}
