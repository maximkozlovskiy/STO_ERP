'use client';

import { Suspense } from 'react';
import dynamic from 'next/dynamic';
import { Landmark } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslation } from 'react-i18next';
import { useRequireAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';
import type { BankTxDirection } from '@/hooks/api/useBankStatements';

const BankTransactionsTab = dynamic(() => import('./BankTransactionsTab'), { ssr: false });
const BankAccountsTab = dynamic(() => import('./BankAccountsTab'), { ssr: false });

// Рядок вкладок — як на «Купівлі» і «Складі»: зліва розрізи списку платежів за напрямком
// (усі / вхідні / вихідні), праворуч — «Банк. рахунки» (довідник, окремий вміст).
const DIRECTION_TABS: { key: '' | BankTxDirection; labelKey: string }[] = [
  { key: '', labelKey: 'page.tabs.all' },
  { key: 'IN', labelKey: 'page.tabs.incoming' },
  { key: 'OUT', labelKey: 'page.tabs.outgoing' },
];

const TAB_CLASS =
  'flex items-center gap-1.5 px-4 py-2.5 text-[13px] font-medium whitespace-nowrap border-b-2 transition-colors shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:rounded-sm';
const TAB_ACTIVE = 'border-primary text-primary';
const TAB_IDLE =
  'border-transparent text-muted-foreground hover:text-foreground hover:border-border';

function BankStatementsPageShell() {
  // Ролі однакові для обох вкладок (перегляд платежів і керування рахунками — OWNER/ADMIN/ACCOUNTANT).
  useRequireAuth(['OWNER', 'ADMIN', 'ACCOUNTANT']);
  const { t } = useTranslation('bankStatements');
  const router = useRouter();
  const searchParams = useSearchParams();
  const showAccounts = searchParams.get('tab') === 'accounts';
  const requestedDirection = searchParams.get('direction');
  const direction: '' | BankTxDirection =
    requestedDirection === 'IN' || requestedDirection === 'OUT' ? requestedDirection : '';
  const go = (query: string) =>
    router.replace(query ? `/bank-statements?${query}` : '/bank-statements', { scroll: false });

  return (
    <div className="page-fill p-4 md:p-6">
      <div className="page-header">
        <h1 className="page-title flex items-center gap-2">
          <Landmark className="h-5 w-5" />
          {t('page.title')}
        </h1>
      </div>

      <div className="shrink-0 flex gap-0 border-b border-border -mx-6 px-6 overflow-x-auto">
        {DIRECTION_TABS.map(tabDef => (
          <button
            key={tabDef.key || 'all'}
            type="button"
            onClick={() => go(tabDef.key ? `direction=${tabDef.key}` : '')}
            aria-current={!showAccounts && direction === tabDef.key ? 'page' : undefined}
            className={cn(
              TAB_CLASS,
              !showAccounts && direction === tabDef.key ? TAB_ACTIVE : TAB_IDLE,
            )}
          >
            {t(tabDef.labelKey)}
          </button>
        ))}
        <button
          type="button"
          onClick={() => go('tab=accounts')}
          aria-current={showAccounts ? 'page' : undefined}
          className={cn(TAB_CLASS, 'ml-auto', showAccounts ? TAB_ACTIVE : TAB_IDLE)}
        >
          {t('page.tabs.accounts')}
        </button>
      </div>

      {showAccounts ? (
        <BankAccountsTab />
      ) : (
        // key: зміна напрямку — новий список з першої сторінки й зі скинутим фільтром статусу
        <BankTransactionsTab key={direction || 'all'} direction={direction || undefined} />
      )}
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
