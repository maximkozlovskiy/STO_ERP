'use client';

import { Suspense } from 'react';
import dynamic from 'next/dynamic';
import { Landmark } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslation } from 'react-i18next';
import { useRequireAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';
import { PAGE_TAB_ACTIVE, PAGE_TAB_CLASS, PAGE_TAB_IDLE } from '@/lib/page-tabs';
import type { BankTxDirection } from '@/hooks/api/useBankStatements';

const BankTransactionsTab = dynamic(() => import('./BankTransactionsTab'), { ssr: false });
const BankAccountsTab = dynamic(() => import('./BankAccountsTab'), { ssr: false });

// Рядок вкладок — як на «Купівлі» і «Складі»: зліва розрізи списку платежів за напрямком
// (усі / вхідні / вихідні), праворуч — «Банк. рахунки» (довідник, окремий вміст).
const DIRECTION_TABS: { direction?: BankTxDirection; labelKey: string }[] = [
  { labelKey: 'page.tabs.all' },
  { direction: 'IN', labelKey: 'page.tabs.incoming' },
  { direction: 'OUT', labelKey: 'page.tabs.outgoing' },
];

function BankStatementsPageShell() {
  // Ролі однакові для обох вкладок (перегляд платежів і керування рахунками — OWNER/ADMIN/ACCOUNTANT).
  useRequireAuth(['OWNER', 'ADMIN', 'ACCOUNTANT']);
  const { t } = useTranslation('bankStatements');
  const router = useRouter();
  const searchParams = useSearchParams();
  const showAccounts = searchParams.get('tab') === 'accounts';
  const requestedDirection = searchParams.get('direction');
  const direction: BankTxDirection | undefined =
    requestedDirection === 'IN' || requestedDirection === 'OUT' ? requestedDirection : undefined;
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
        {DIRECTION_TABS.map(tabDef => {
          const active = !showAccounts && direction === tabDef.direction;
          return (
            <button
              key={tabDef.labelKey}
              type="button"
              onClick={() => go(tabDef.direction ? `direction=${tabDef.direction}` : '')}
              aria-current={active ? 'page' : undefined}
              className={cn(PAGE_TAB_CLASS, active ? PAGE_TAB_ACTIVE : PAGE_TAB_IDLE)}
            >
              {t(tabDef.labelKey)}
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => go('tab=accounts')}
          aria-current={showAccounts ? 'page' : undefined}
          className={cn(PAGE_TAB_CLASS, 'ml-auto', showAccounts ? PAGE_TAB_ACTIVE : PAGE_TAB_IDLE)}
        >
          {t('page.tabs.accounts')}
        </button>
      </div>

      {showAccounts ? (
        <BankAccountsTab />
      ) : (
        // key: зміна напрямку — новий список з першої сторінки й зі скинутим фільтром статусу
        <BankTransactionsTab key={direction ?? 'all'} direction={direction} />
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
