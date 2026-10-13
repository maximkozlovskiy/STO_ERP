import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ApiSchema, CashReasonValue } from '@sto/shared';
import { apiFetch } from '@/lib/api-client';

/** Стаття — ЗГЕНЕРОВАНИЙ тип із OpenAPI (`pnpm run gen:api-types`), поля звірені з dev-API. */
export type ExpenseCategory = ApiSchema<'ExpenseCategoryResponseDto'>;
export type ExpenseCategoryType = ExpenseCategory['type'];

export const expenseCategoriesKeys = {
  all: ['expense-categories'] as const,
  lists: () => [...expenseCategoriesKeys.all, 'list'] as const,
  list: (showDeleted: boolean) => [...expenseCategoriesKeys.lists(), showDeleted] as const,
};

// `enabled` дозволяє гейтити запит за роллю: GET /expense-categories вимагає ACCOUNTANT+ (backend
// @Roles OWNER/ADMIN/ACCOUNTANT). RECEPTIONIST, який бачить вкладку «Операції» /cash лише для перегляду,
// НЕ повинен фаєрити цей запит (інакше 403 у мережі + retry). Гейт: enabled=canOperate у CashOperationsTab.
export function useExpenseCategories(showDeleted = false, enabled = true) {
  return useQuery({
    queryKey: expenseCategoriesKeys.list(showDeleted),
    queryFn: () =>
      apiFetch<{ items: ExpenseCategory[]; total: number }>(
        `/expense-categories${showDeleted ? '?showDeleted=true' : ''}`,
      ).then(r => r.items),
    enabled,
    // Довідник (дерево статей витрат) — рідко міняється під час сесії. Без staleTime
    // (дефолт 0) кожен mount CashOperationsTab/модалки операції re-fetch-ив усе дерево.
    // Усі 5 мутацій invalidate-ять lists() → safe. Конвенція reference-хуків: 5 хв.
    staleTime: 5 * 60_000,
  });
}

export interface FlatExpenseCategory {
  id: string;
  name: string;
  depth: number;
  defaultReason: CashReasonValue | null;
}

/** Сплощує дерево у плаский список активних статей заданого типу (для Select у модалці операції). */
export function flattenActiveByType(
  tree: ExpenseCategory[] | undefined,
  type: ExpenseCategoryType,
): FlatExpenseCategory[] {
  const out: FlatExpenseCategory[] = [];
  const walk = (nodes: ExpenseCategory[], depth: number) => {
    for (const n of nodes) {
      if (n.type === type && n.isActive) {
        out.push({ id: n.id, name: n.name, depth, defaultReason: n.defaultReason ?? null });
      }
      if (n.children?.length) walk(n.children, depth + 1);
    }
  };
  walk(tree ?? [], 0);
  return out;
}

export interface CreateExpenseCategoryBody {
  name: string;
  type?: ExpenseCategoryType;
  parentId?: string;
  defaultReason?: CashReasonValue | null;
}

export function useCreateExpenseCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateExpenseCategoryBody) =>
      apiFetch<ExpenseCategory>('/expense-categories', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: expenseCategoriesKeys.lists() }),
  });
}

export function useUpdateExpenseCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      ...body
    }: {
      id: string;
      name?: string;
      parentId?: string;
      /** `null` знімає привід зі статті. */
      defaultReason?: CashReasonValue | null;
    }) =>
      apiFetch<ExpenseCategory>(`/expense-categories/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: expenseCategoriesKeys.lists() }),
  });
}

export function useToggleExpenseCategoryActive() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      apiFetch<ExpenseCategory>(`/expense-categories/${id}/toggle-active`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: expenseCategoriesKeys.lists() }),
  });
}

export function useDeleteExpenseCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/expense-categories/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: expenseCategoriesKeys.lists() }),
  });
}

export function useRestoreExpenseCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<ExpenseCategory>(`/expense-categories/${id}/restore`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: expenseCategoriesKeys.lists() }),
  });
}
