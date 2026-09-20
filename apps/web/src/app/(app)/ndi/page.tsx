'use client';

import dynamic from 'next/dynamic';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { useRequireAuth } from '@/lib/auth';

const OrgTab = dynamic(() => import('./OrgTab'), { ssr: false });
const OrgInfoTab = dynamic(() => import('./OrgInfoTab'), { ssr: false });
const PaymentsTab = dynamic(() => import('./PaymentsTab'), { ssr: false });
const TaxRatesTab = dynamic(() => import('./TaxRatesTab'), { ssr: false });
const CurrenciesTab = dynamic(() => import('./CurrenciesTab'), { ssr: false });
const ExchangeRatesTab = dynamic(() => import('./ExchangeRatesTab'), { ssr: false });
// Вкладку «Банк. рахунки» перенесено на /bank-statements?tab=accounts (UI-реорганізація
// навколо банківських рахунків). Каси керуються на сторінці «Каса» (вкладка «Каси») — там повна форма (валюта + фіскалізація +
// стартовий залишок + провайдер ПРРО). Стару НДІ-вкладку «Каса» видалено (дубль неповної форми).

type Tab = 'org' | 'org-info' | 'payments' | 'taxrates' | 'currencies' | 'exchange-rates';

const TAB_DEFS: { id: Tab; labelKey: string }[] = [
  { id: 'org', labelKey: 'tabs.org' },
  { id: 'org-info', labelKey: 'tabs.orgInfo' },
  { id: 'payments', labelKey: 'tabs.payments' },
  { id: 'taxrates', labelKey: 'tabs.taxRates' },
  { id: 'currencies', labelKey: 'tabs.currencies' },
  { id: 'exchange-rates', labelKey: 'tabs.exchangeRates' },
];

function NdiPageClient() {
  useRequireAuth(['OWNER', 'ADMIN']);
  const { t } = useTranslation('ndi');
  const router = useRouter();
  const searchParams = useSearchParams();
  const tab = (searchParams.get('tab') ?? 'org') as Tab;
  const setTab = (t: Tab) => router.replace(`?tab=${t}`, { scroll: false });

  const TABS = useMemo(() => TAB_DEFS.map(d => ({ ...d, label: t(d.labelKey) })), [t]);

  return (
    <div className="page-fill p-6 overflow-y-auto">
      <h1 className="page-title mb-6">{t('title')}</h1>

      <div className="flex gap-1 border-b border-border mb-6 flex-wrap">
        {TABS.map(tabDef => (
          <button
            key={tabDef.id}
            onClick={() => setTab(tabDef.id)}
            className={cn(
              'px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors',
              tab === tabDef.id
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {tabDef.label}
          </button>
        ))}
      </div>

      {tab === 'org' && <OrgTab />}
      {tab === 'org-info' && <OrgInfoTab />}
      {tab === 'payments' && <PaymentsTab />}
      {tab === 'taxrates' && <TaxRatesTab />}
      {tab === 'currencies' && <CurrenciesTab />}
      {tab === 'exchange-rates' && <ExchangeRatesTab />}
    </div>
  );
}

export default function NdiPage() {
  return (
    <Suspense fallback={null}>
      <NdiPageClient />
    </Suspense>
  );
}
