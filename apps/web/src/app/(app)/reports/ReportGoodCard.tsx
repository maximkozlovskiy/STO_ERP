'use client';

import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { getCached } from '@/lib/ref-cache';
import { toast } from '@/lib/toast';
import { GoodEditModal, type GoodForModal } from '@/components/ui/GoodEditModal';
import type { CategoryNode } from '@/components/ui/category-tree';
import { reportsKeys } from '@/hooks/api/useReports';

type Brand = { id: string; name: string };
type UnitRef = {
  id: string;
  name: string;
  shortName: string;
  isSystem: boolean;
  coefficient: number;
};

interface CardState {
  good: GoodForModal;
  brands: Brand[];
  units: UnitRef[];
  goodCatTree: CategoryNode[];
}

/**
 * Картка товару з рядка «Звіту по складу» — та сама `GoodEditModal`, що в каталозі й замовленні
 * постачальнику: товар і довідники (бренди, одиниці, категорії — з кешу вкладки, інакше запитом).
 * Повертає `open(goodId)` і саму картку. Збереження картки скидає кеш звітів (назва, ціна).
 */
export function useReportGoodCard() {
  const { t } = useTranslation('reports');
  const qc = useQueryClient();
  // Дані картки лишаються після закриття: інакше на час анімації закриття вікно показало б
  // порожню форму нового товару.
  const [card, setCard] = useState<CardState | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  // Подвійний клік по рядку не має слати два набори запитів.
  const loadingRef = useRef(false);

  const open = useCallback(
    async (goodId: string) => {
      if (loadingRef.current) return;
      loadingRef.current = true;
      try {
        const [good, brands, units, goodCatTree] = await Promise.all([
          apiFetch<GoodForModal>(`/goods/${goodId}`),
          getCached<Brand[]>('cache:brands') ??
            apiFetch<{ items: Brand[] }>('/brands?limit=200').then(r => r.items),
          getCached<UnitRef[]>('cache:units') ?? apiFetch<UnitRef[]>('/units'),
          getCached<CategoryNode[]>('cache:good-categories') ??
            apiFetch<CategoryNode[]>('/good-categories'),
        ]);
        setCard({ good, brands, units, goodCatTree });
        setIsOpen(true);
      } catch (e: unknown) {
        toast.error(e instanceof Error && e.message ? e.message : t('page.stock.goodLoadError'));
      } finally {
        loadingRef.current = false;
      }
    },
    [t],
  );

  // Картка монтується лише після першого відкриття: закрита сторінка звітів її запитів не шле.
  const element = card && (
    <GoodEditModal
      open={isOpen}
      good={card.good}
      brands={card.brands}
      units={card.units}
      goodCatTree={card.goodCatTree}
      onClose={() => setIsOpen(false)}
      onSaved={updated => {
        setCard(c => (c ? { ...c, good: updated } : c));
        void qc.invalidateQueries({ queryKey: reportsKeys.all });
      }}
    />
  );

  return { open, element };
}
