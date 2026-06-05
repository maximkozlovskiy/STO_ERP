'use client';

import dynamic from 'next/dynamic';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { cn } from '@/lib/utils';
import { useRequireAuth } from '@/lib/auth';

const TaxRatesTab = dynamic(() => import('./TaxRatesTab'), { ssr: false });
const CurrenciesTab = dynamic(() => import('./CurrenciesTab'), { ssr: false });
const ExchangeRatesTab = dynamic(() => import('./ExchangeRatesTab'), { ssr: false });
const BankAccountsTab = dynamic(() => import('./BankAccountsTab'), { ssr: false });
const CashRegistersTab = dynamic(() => import('./CashRegistersTab'), { ssr: false });

type Tab = 'taxrates' | 'currencies' | 'exchange-rates' | 'bank-accounts' | 'cash-registers';

const TABS: { id: Tab; label: string }[] = [
  { id: 'taxrates', label: 'Ставки ПДВ' },
  { id: 'currencies', label: 'Валюти' },
  { id: 'exchange-rates', label: 'Курси валют' },
  { id: 'bank-accounts', label: 'Банк. рахунки' },
  { id: 'cash-registers', label: 'Каса' },
];

function VatPageClient() {
  useRequireAuth(['OWNER', 'ADMIN']);
  const router = useRouter();
  const searchParams = useSearchParams();
  const tab = (searchParams.get('tab') ?? 'taxrates') as Tab;
  const setTab = (t: Tab) => router.replace(`?tab=${t}`, { scroll: false });

  return (
    <div className="page-container max-w-3xl">
      <h1 className="page-title mb-6">НДС та Фінансові довідники</h1>

      <div className="flex gap-1 border-b border-border mb-6 flex-wrap">
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              'px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors',
              tab === t.id
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'taxrates' && <TaxRatesTab />}
      {tab === 'currencies' && <CurrenciesTab />}
      {tab === 'exchange-rates' && <ExchangeRatesTab />}
      {tab === 'bank-accounts' && <BankAccountsTab />}
      {tab === 'cash-registers' && <CashRegistersTab />}
    </div>
  );
}

export default function VatPage() {
  return (
    <Suspense fallback={null}>
      <VatPageClient />
    </Suspense>
  );
}
