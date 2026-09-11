'use client';

import { Suspense } from 'react';
import dynamic from 'next/dynamic';
import { useRouter, useSearchParams } from 'next/navigation';
import { useRequireAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';

const CashOperationsTab = dynamic(() => import('./CashOperationsTab'), { ssr: false });
const CashRegistersTab = dynamic(() => import('./CashRegistersTab'), { ssr: false });
const ExpenseCategoriesTab = dynamic(() => import('./ExpenseCategoriesTab'), { ssr: false });

type CashTab = 'operations' | 'registers' | 'expenses';
const TABS: { key: CashTab; label: string }[] = [
  { key: 'operations', label: 'Операції' },
  { key: 'registers', label: 'Каси' },
  { key: 'expenses', label: 'Статті витрат' },
];

function CashPageShell() {
  useRequireAuth(['OWNER', 'ADMIN', 'ACCOUNTANT', 'RECEPTIONIST']);
  const router = useRouter();
  const searchParams = useSearchParams();
  const tab = (searchParams.get('tab') ?? 'operations') as CashTab;
  const setTab = (t: CashTab) =>
    router.replace(t === 'operations' ? '/cash' : `/cash?tab=${t}`, { scroll: false });

  return (
    <div className="page-fill p-4 md:p-6">
      <div className="page-header">
        <div>
          <h1 className="page-title">Каса</h1>
        </div>
      </div>

      <div className="shrink-0 flex gap-0 border-b border-border -mx-6 px-6 overflow-x-auto">
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              'flex items-center gap-1.5 px-4 py-2.5 text-[13px] font-medium whitespace-nowrap border-b-2 transition-colors shrink-0',
              tab === t.key
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'operations' && <CashOperationsTab />}
      {tab === 'registers' && <CashRegistersTab />}
      {tab === 'expenses' && <ExpenseCategoriesTab />}
    </div>
  );
}

export default function CashPage() {
  return (
    <Suspense fallback={null}>
      <CashPageShell />
    </Suspense>
  );
}
