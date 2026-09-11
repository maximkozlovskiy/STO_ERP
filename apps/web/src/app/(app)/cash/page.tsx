'use client';

import { Suspense, useEffect } from 'react';
import dynamic from 'next/dynamic';
import { useRouter, useSearchParams } from 'next/navigation';
import { useRequireAuth, useAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';

const CashOperationsTab = dynamic(() => import('./CashOperationsTab'), { ssr: false });
const CashRegistersTab = dynamic(() => import('./CashRegistersTab'), { ssr: false });
const ExpenseCategoriesTab = dynamic(() => import('./ExpenseCategoriesTab'), { ssr: false });

type CashTab = 'operations' | 'registers' | 'expenses';
// Ролі кожного табу дзеркалять @Roles backend-контролерів (§8.4): «Операції» — список кас доступний
// RECEPTIONIST (GET /cash-registers), але «Каси» CRUD і «Статті витрат» GET вимагають ACCOUNTANT+/ADMIN.
// Табу, недоступні ролі, приховуються, а default форсується на дозволений — інакше 403 + порожні таблиці.
const TABS: { key: CashTab; label: string; roles: readonly string[] }[] = [
  { key: 'operations', label: 'Операції', roles: ['OWNER', 'ADMIN', 'ACCOUNTANT', 'RECEPTIONIST'] },
  { key: 'registers', label: 'Каси', roles: ['OWNER', 'ADMIN', 'ACCOUNTANT'] },
  { key: 'expenses', label: 'Статті витрат', roles: ['OWNER', 'ADMIN', 'ACCOUNTANT'] },
];

function CashPageShell() {
  useRequireAuth(['OWNER', 'ADMIN', 'ACCOUNTANT', 'RECEPTIONIST']);
  const { employee } = useAuth();
  const role = employee?.role ?? '';
  const visibleTabs = TABS.filter(t => t.roles.includes(role));
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedTab = (searchParams.get('tab') ?? 'operations') as CashTab;
  const allowed = visibleTabs.some(t => t.key === requestedTab);
  const tab = allowed ? requestedTab : (visibleTabs[0]?.key ?? 'operations');
  const setTab = (t: CashTab) =>
    router.replace(t === 'operations' ? '/cash' : `/cash?tab=${t}`, { scroll: false });

  // Форсуємо URL на дозволений таб, якщо ролі бракує на запитаний (напр. RECEPTIONIST → ?tab=expenses).
  useEffect(() => {
    if (!allowed && visibleTabs.length > 0 && requestedTab !== tab) setTab(tab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowed, requestedTab, tab]);

  return (
    <div className="page-fill p-4 md:p-6">
      <div className="page-header">
        <div>
          <h1 className="page-title">Каса</h1>
        </div>
      </div>

      <div className="shrink-0 flex gap-0 border-b border-border -mx-6 px-6 overflow-x-auto">
        {visibleTabs.map(t => (
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

      {/* canOperate: ручні операції IN/OUT — OWNER/ADMIN/ACCOUNTANT (RECEPTIONIST лише перегляд). */}
      {tab === 'operations' && (
        <CashOperationsTab canOperate={['OWNER', 'ADMIN', 'ACCOUNTANT'].includes(role)} />
      )}
      {tab === 'registers' && <CashRegistersTab canManage={['OWNER', 'ADMIN'].includes(role)} />}
      {tab === 'expenses' && <ExpenseCategoriesTab canManage={['OWNER', 'ADMIN'].includes(role)} />}
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
