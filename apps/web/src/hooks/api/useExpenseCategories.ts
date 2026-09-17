import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export type ExpenseCategoryType = 'EXPENSE' | 'INCOME';

export interface ExpenseCategory {
  id: string;
  orgId: string;
  parentId?: string | null;
  name: string;
  type: ExpenseCategoryType;
  sortOrder: number;
  isActive: boolean;
  children: ExpenseCategory[];
  deletedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export const EXPENSE_CATEGORY_TYPE_LABELS: Record<ExpenseCategoryType, string> = {
  EXPENSE: 'Витрата',
  INCOME: 'Оприбуткування',
};

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
  });
}

/** Сплощує дерево у плаский список активних статей заданого типу (для Select у модалці операції). */
export function flattenActiveByType(
  tree: ExpenseCategory[] | undefined,
  type: ExpenseCategoryType,
): { id: string; name: string; depth: number }[] {
  const out: { id: string; name: string; depth: number }[] = [];
  const walk = (nodes: ExpenseCategory[], depth: number) => {
    for (const n of nodes) {
      if (n.type === type && n.isActive) out.push({ id: n.id, name: n.name, depth });
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
    mutationFn: ({ id, ...body }: { id: string; name?: string; parentId?: string }) =>
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
