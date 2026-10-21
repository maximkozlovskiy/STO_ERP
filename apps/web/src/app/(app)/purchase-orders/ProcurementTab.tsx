'use client';

import { useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslation } from 'react-i18next';
import { PROCUREMENT_WRITE_ROLES } from '@sto/shared';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';
import { ShortageView } from './procurement/ShortageView';
import { ItemsView } from './procurement/ItemsView';
import { ListsView } from './procurement/ListsView';

export type ProcurementView = 'shortage' | 'items' | 'lists';

/**
 * Вкладка «Управління купівлями» (docs/objects/purchase-list.md): нестача по нарядах, позиції
 * списків купівлі, самі списки. Вид — `?view=shortage|items|lists`; `?list=<id>` відкриває
 * список (deep link із пов'язаних документів).
 */
export function ProcurementTab() {
  const { t } = useTranslation('purchaseLists');
  const { employee } = useAuth();
  // BR-PL-015: приймальня лише переглядає й надсилає з наряду.
  const canWrite = PROCUREMENT_WRITE_ROLES.includes(employee?.role ?? '');
  const searchParams = useSearchParams();
  const router = useRouter();
  const requested = searchParams.get('view');
  const openListId = searchParams.get('list');
  const view: ProcurementView =
    requested === 'items' || requested === 'lists' ? requested : openListId ? 'lists' : 'shortage';

  const setView = useCallback(
    (next: ProcurementView) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set('view', next);
      params.delete('list');
      router.replace(`?${params.toString()}`, { scroll: false });
    },
    [router, searchParams],
  );

  const VIEWS: Array<{ key: ProcurementView; label: string }> = [
    { key: 'shortage', label: t('views.shortage') },
    { key: 'items', label: t('views.items') },
    { key: 'lists', label: t('views.lists') },
  ];

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-3 pt-4">
      <div
        role="tablist"
        aria-label={t('views.aria')}
        className="inline-flex self-start rounded-lg border border-border bg-secondary/40 p-0.5"
      >
        {VIEWS.map(v => (
          <button
            key={v.key}
            type="button"
            role="tab"
            aria-selected={view === v.key}
            onClick={() => setView(v.key)}
            className={cn(
              'px-3 py-1.5 text-[13px] font-medium rounded-md transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
              view === v.key
                ? 'bg-surface text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {v.label}
          </button>
        ))}
      </div>
      {view === 'shortage' && <ShortageView />}
      {view === 'items' && <ItemsView canWrite={canWrite} />}
      {view === 'lists' && <ListsView canWrite={canWrite} openListId={openListId} />}
    </div>
  );
}
