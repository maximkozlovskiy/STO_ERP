import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export interface ExpenseCategory {
  id: string;
  orgId: string;
  name: string;
  deletedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export const expenseCategoriesKeys = {
  all: ['expense-categories'] as const,
  list: (showDeleted: boolean) => [...expenseCategoriesKeys.all, 'list', showDeleted] as const,
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

export function useCreateExpenseCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      apiFetch<ExpenseCategory>('/expense-categories', {
        method: 'POST',
        body: JSON.stringify({ name }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: expenseCategoriesKeys.all }),
  });
}

export function useUpdateExpenseCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      apiFetch<ExpenseCategory>(`/expense-categories/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: expenseCategoriesKeys.all }),
  });
}

export function useDeleteExpenseCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/expense-categories/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: expenseCategoriesKeys.all }),
  });
}

export function useRestoreExpenseCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<ExpenseCategory>(`/expense-categories/${id}/restore`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: expenseCategoriesKeys.all }),
  });
}
