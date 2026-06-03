import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { useAuth } from '@/lib/auth';

export interface PricingRule {
  id: string;
  name: string;
  type: string;
  priority: number;
  goodId?: string | null;
  goodCategory?: string | null;
  goodType?: string | null;
  percentValue?: number | null;
  fixedAmount?: number | null;
  fixedPrice?: number | null;
  roundTo?: number | null;
  isActive: boolean;
  deletedAt?: string | null;
}

export const pricingRulesKeys = {
  all: ['pricing-rules'] as const,
  list: () => [...pricingRulesKeys.all, 'list'] as const,
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
  return () => qc.invalidateQueries({ queryKey: pricingRulesKeys.all });
}
