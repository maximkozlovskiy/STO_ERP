import { useCallback, useEffect, useState } from 'react';
import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import type { ApiSchema } from '@sto/shared';
import { apiFetch } from '@/lib/api-client';
import { useAuth } from '@/lib/auth';

// Типи — зі згенерованого контракту; рукописні копії тут розходились із сервером
// (поля `goodId` / `good` зникли з відповіді, коли правило отримало СПИСОК товарів).
export type PricingRule = ApiSchema<'PricingRuleResponseDto'>;
export type PricingRuleTier = ApiSchema<'PricingRuleTierResponseDto'>;
export type PricingRuleGood = ApiSchema<'PricingRuleGoodRefDto'>;
type PricingRuleGoodsResponse = ApiSchema<'PricingRuleGoodsDto'>;

export const pricingRulesKeys = {
  all: ['pricing-rules'] as const,
  lists: () => [...pricingRulesKeys.all, 'list'] as const,
  list: () => [...pricingRulesKeys.lists()] as const,
};

export function usePricingRules() {
  const { employee } = useAuth();
  return useQuery<PricingRule[]>({
    queryKey: pricingRulesKeys.list(),
    queryFn: ({ signal }) =>
      apiFetch<{ items: PricingRule[]; total: number }>('/pricing-rules', { signal }).then(
        d => d.items,
      ),
    enabled: !!employee,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
}

export function useInvalidatePricingRules() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: pricingRulesKeys.lists() });
}

export type PricingRuleGoodsState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string | null }
  | { status: 'ready'; items: PricingRuleGood[] };

const IDLE: PricingRuleGoodsState = { status: 'idle' };
const LOADING: PricingRuleGoodsState = { status: 'loading' };

/**
 * Повний список товарів правила (`GET /pricing-rules/:id/goods`) для форми редагування.
 *
 * Свідомо НЕ `useQuery`: форма копіює список у свій локальний стан і далі редагує копію,
 * тому потрібне рівно одне свіже завантаження на кожне відкриття, а не фонова підміна
 * даних з кешу. І не `queryClient.fetchQuery`: він склеює одночасні запити за ключем, тож
 * запит, скасований cleanup-ом ефекту (StrictMode монтує двічі), віддав би помилку
 * скасування вже НОВОМУ ефекту. `ruleId === null` — нічого не вантажимо (`idle`).
 *
 * Стан `error` не маскується під порожній список: форма мусить бачити різницю, інакше
 * збереження стерло б справжній список товарів.
 */
export function usePricingRuleGoods(ruleId: string | null): {
  state: PricingRuleGoodsState;
  retry: () => void;
} {
  const [state, setState] = useState<PricingRuleGoodsState>(ruleId ? LOADING : IDLE);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!ruleId) {
      setState(IDLE);
      return;
    }
    const ac = new AbortController();
    setState(LOADING);
    apiFetch<PricingRuleGoodsResponse>(`/pricing-rules/${ruleId}/goods`, { signal: ac.signal })
      .then(res => {
        if (!ac.signal.aborted) setState({ status: 'ready', items: res.items });
      })
      .catch((e: unknown) => {
        if (ac.signal.aborted) return;
        setState({ status: 'error', message: e instanceof Error ? e.message : null });
      });
    return () => ac.abort();
  }, [ruleId, attempt]);

  const retry = useCallback(() => setAttempt(a => a + 1), []);
  return { state, retry };
}
