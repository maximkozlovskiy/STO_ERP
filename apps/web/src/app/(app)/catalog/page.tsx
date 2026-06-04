'use client';

import { Suspense } from 'react';
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

type Tab = 'works' | 'goods' | 'services' | 'units' | 'brands';

const TABS: { key: Tab; label: string }[] = [
  { key: 'works', label: 'Роботи' },
  { key: 'goods', label: 'Товари та запчастини' },
  { key: 'services', label: 'Комплексні послуги' },
  { key: 'units', label: 'Одиниці виміру' },
  { key: 'brands', label: 'Бренди' },
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
};

function CatalogPageClient() {
  useRequireAuth(['OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC', 'STOREKEEPER']);
  const router = useRouter();
  const searchParams = useSearchParams();
  const tab = (searchParams.get('tab') ?? 'works') as Tab;

  const setTab = (t: Tab) => router.replace(`?tab=${t}`, { scroll: false });

  return (
    <div className="page-fill p-4 md:p-6">
      <div className="page-header">
        <div>
          <h1 className="page-title">Каталог</h1>
        </div>
      </div>

      <div className="shrink-0 flex gap-0 border-b border-border -mx-6 px-6 overflow-x-auto">
        {TABS.map(t => (
          <button
            key={t.key}
            onMouseEnter={() => PRELOAD_MAP[t.key]?.()}
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

      {tab === 'works' && <WorksTab />}
      {tab === 'goods' && <GoodsTab />}
      {tab === 'services' && <ServicesTab />}
      {tab === 'units' && <UnitsTab />}
      {tab === 'brands' && <BrandsTab />}
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
