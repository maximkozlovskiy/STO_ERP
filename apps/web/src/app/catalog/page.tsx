'use client';

import { useState } from 'react';
import dynamic from 'next/dynamic';
import { useRequireAuth } from '@/lib/auth';

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

export default function CatalogPage() {
  useRequireAuth(['OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC', 'STOREKEEPER']);
  const [tab, setTab] = useState<Tab>('works');

  return (
    <div className="page-container">
      <h1 className="page-title mb-6">Каталог</h1>

      <div className="flex gap-1 bg-secondary rounded-lg p-1 mb-6 w-fit">
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 rounded-md text-[13px] font-medium transition-colors ${tab === t.key ? 'bg-surface text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
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
