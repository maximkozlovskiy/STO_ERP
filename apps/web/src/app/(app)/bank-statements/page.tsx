'use client';

import { Suspense } from 'react';
import dynamic from 'next/dynamic';
import { Landmark } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslation } from 'react-i18next';
import { useRequireAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';

const BankTransactionsTab = dynamic(() => import('./BankTransactionsTab'), { ssr: false });
const BankAccountsTab = dynamic(() => import('./BankAccountsTab'), { ssr: false });

type BankTab = 'transactions' | 'accounts';

const TABS: { key: BankTab; labelKey: string }[] = [
  { key: 'transactions', labelKey: 'page.tabs.transactions' },
  { key: 'accounts', labelKey: 'page.tabs.accounts' },
];

function BankStatementsPageShell() {
  // Ролі однакові для обох вкладок (перегляд платежів і керування рахунками — OWNER/ADMIN/ACCOUNTANT).
  useRequireAuth(['OWNER', 'ADMIN', 'ACCOUNTANT']);
  const { t } = useTranslation('bankStatements');
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedTab = (searchParams.get('tab') ?? 'transactions') as BankTab;
  const tab = TABS.some(x => x.key === requestedTab) ? requestedTab : 'transactions';
  const setTab = (next: BankTab) =>
    router.replace(next === 'transactions' ? '/bank-statements' : `/bank-statements?tab=${next}`, {
      scroll: false,
    });

  return (
    <div className="page-fill p-4 md:p-6">
      <div className="page-header">
        <h1 className="page-title flex items-center gap-2">
          <Landmark className="h-5 w-5" />
          {t('page.title')}
        </h1>
      </div>

      <div className="shrink-0 flex gap-0 border-b border-border -mx-6 px-6 overflow-x-auto">
        {TABS.map(tabDef => (
          <button
            key={tabDef.key}
            onClick={() => setTab(tabDef.key)}
            className={cn(
              'flex items-center gap-1.5 px-4 py-2.5 text-[13px] font-medium whitespace-nowrap border-b-2 transition-colors shrink-0',
              tab === tabDef.key
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t(tabDef.labelKey)}
          </button>
        ))}
      </div>

      {tab === 'transactions' && <BankTransactionsTab />}
      {tab === 'accounts' && <BankAccountsTab />}
    </div>
  );
}

export default function BankStatementsPage() {
  return (
    <Suspense fallback={null}>
      <BankStatementsPageShell />
    </Suspense>
  );
}
