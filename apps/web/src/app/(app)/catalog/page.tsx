'use client';

import { Suspense, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useRouter, useSearchParams } from 'next/navigation';
import dynamic from 'next/dynamic';
import { useRequireAuth } from '@/lib/auth';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';

const WorksTab = dynamic(() => import('./WorksTab'), { ssr: false });
const GoodsTab = dynamic(() => import('./GoodsTab'), { ssr: false });
const ServicesTab = dynamic(() => import('./ServicesTab'), { ssr: false });
const UnitsTab = dynamic(() => import('./UnitsTab'), { ssr: false });
const BrandsTab = dynamic(() => import('./BrandsTab'), { ssr: false });
const GoodStatusesTab = dynamic(() => import('./GoodStatusesTab'), { ssr: false });

type Tab = 'works' | 'goods' | 'services' | 'units' | 'brands' | 'good-statuses';

const TAB_DEFS: { key: Tab; labelKey: string }[] = [
  { key: 'works', labelKey: 'tabs.works' },
  { key: 'goods', labelKey: 'tabs.goods' },
  { key: 'services', labelKey: 'tabs.services' },
  { key: 'units', labelKey: 'tabs.units' },
  { key: 'brands', labelKey: 'tabs.brands' },
  { key: 'good-statuses', labelKey: 'tabs.goodStatuses' },
];

// Preload JS bundle + first API request for heavy tabs on hover
const PRELOAD_MAP: Partial<Record<Tab, () => void>> = {
  goods: () => {
    void import('./GoodsTab');
  },
  services: () => {
    void import('./ServicesTab');
  },
  units: () => {
    void import('./UnitsTab');
  },
  brands: () => {
    void import('./BrandsTab');
  },
  'good-statuses': () => {
    void import('./GoodStatusesTab');
  },
};

function CatalogPageClient() {
  useRequireAuth(['OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC', 'STOREKEEPER']);
  const { t } = useTranslation('catalog');
  const router = useRouter();
  const searchParams = useSearchParams();
  const tab = (searchParams.get('tab') ?? 'works') as Tab;

  const TABS = useMemo(() => TAB_DEFS.map(d => ({ ...d, label: t(d.labelKey) })), [t]);

  const setTab = (tabKey: Tab) => router.replace(`?tab=${tabKey}`, { scroll: false });

  return (
    <div className="page-fill p-4 md:p-6">
      <div className="page-header">
        <div>
          <h1 className="page-title">{t('title')}</h1>
        </div>
      </div>

      <div className="shrink-0 flex gap-0 border-b border-border -mx-6 px-6 overflow-x-auto">
        {TABS.map(tabDef => (
          <button
            key={tabDef.key}
            onMouseEnter={() => PRELOAD_MAP[tabDef.key]?.()}
            onClick={() => setTab(tabDef.key)}
            className={cn(
              'flex items-center gap-1.5 px-4 py-2.5 text-[13px] font-medium whitespace-nowrap border-b-2 transition-colors shrink-0',
              tab === tabDef.key
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {tabDef.label}
          </button>
        ))}
      </div>

      {tab === 'works' && <WorksTab />}
      {tab === 'goods' && <GoodsTab />}
      {tab === 'services' && <ServicesTab />}
      {tab === 'units' && <UnitsTab />}
      {tab === 'brands' && <BrandsTab />}
      {tab === 'good-statuses' && <GoodStatusesTab />}
    </div>
  );
}

export default function CatalogPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center min-h-screen">
          <Spinner size="lg" />
        </div>
      }
    >
      <CatalogPageClient />
    </Suspense>
  );
}
