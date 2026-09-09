'use client';

import { Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import dynamic from 'next/dynamic';
import { useRequireAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';

const NotificationsTab = dynamic(() => import('./NotificationsTab'), { ssr: false });
const ThemeTab = dynamic(() => import('./ThemeTab'), { ssr: false });
const UiTab = dynamic(() => import('./UiTab'), { ssr: false });
const NumbersTab = dynamic(() => import('./NumbersTab'), { ssr: false });
const WorkdaysTab = dynamic(() => import('./WorkdaysTab'), { ssr: false });
const FollowupTab = dynamic(() => import('./FollowupTab'), { ssr: false });
const IntegrationsTab = dynamic(() => import('./IntegrationsTab'), { ssr: false });
const DocumentsTab = dynamic(() => import('./DocumentsTab'), { ssr: false, loading: () => null });
const FiscalTab = dynamic(() => import('./FiscalTab'), { ssr: false });
const DeliveryTab = dynamic(() => import('./DeliveryTab'), { ssr: false });
const IntegrationLogsTab = dynamic(() => import('./IntegrationLogsTab'), { ssr: false });
const LoyaltyTab = dynamic(() => import('./LoyaltyTab'), { ssr: false });

type Tab =
  | 'notifications'
  | 'theme'
  | 'ui'
  | 'numbers'
  | 'workdays'
  | 'followup'
  | 'loyalty'
  | 'integrations'
  | 'documents'
  | 'fiscal'
  | 'delivery'
  | 'integration-logs';

const TABS: { key: Tab; label: string }[] = [
  { key: 'numbers', label: 'Нумерація' },
  { key: 'workdays', label: 'Робочі дні' },
  { key: 'documents', label: 'Налаштування документів' },
  { key: 'notifications', label: 'Сповіщення' },
  { key: 'theme', label: 'Оформлення' },
  { key: 'ui', label: 'Інтерфейс' },
  { key: 'followup', label: 'Нагадування' },
  { key: 'loyalty', label: 'Лояльність' },
  { key: 'fiscal', label: 'Фіскалізація' },
  { key: 'delivery', label: 'Доставка' },
  { key: 'integrations', label: 'Інтеграції' },
  { key: 'integration-logs', label: 'Логи інтеграцій' },
];

function SettingsPageClient() {
  useRequireAuth(['OWNER', 'ADMIN']);
  const router = useRouter();
  const searchParams = useSearchParams();
  const tab = (searchParams.get('tab') ?? 'numbers') as Tab;

  const setTab = (t: Tab) => router.replace(`?tab=${t}`, { scroll: false });

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-6">
      <h1 className="page-title mb-6">Налаштування</h1>

      {/* Tab bar */}
      <div className="flex gap-1 border-b border-border mb-6 flex-wrap">
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              'px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors',
              tab === t.key
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'notifications' && <NotificationsTab />}
      {tab === 'theme' && <ThemeTab />}
      {tab === 'ui' && <UiTab />}
      {tab === 'numbers' && <NumbersTab />}
      {tab === 'workdays' && <WorkdaysTab />}
      {tab === 'followup' && <FollowupTab />}
      {tab === 'loyalty' && <LoyaltyTab />}
      {tab === 'integrations' && <IntegrationsTab />}
      {tab === 'documents' && <DocumentsTab />}
      {tab === 'fiscal' && <FiscalTab />}
      {tab === 'delivery' && <DeliveryTab />}
      {tab === 'integration-logs' && <IntegrationLogsTab />}
    </div>
  );
}

export default function SettingsPage() {
  return (
    <Suspense fallback={null}>
      <SettingsPageClient />
    </Suspense>
  );
}
