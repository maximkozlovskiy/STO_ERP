import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ApiSchema, AutomationRuleFormValues } from '@sto/shared';
import { apiFetch } from '@/lib/api-client';

/** Правило автоматизації (docs/objects/automation.md) — форма відповіді API. */
export type AutomationRule = ApiSchema<'AutomationRuleResponseDto'>;
export type PaginatedAutomationRules = ApiSchema<'PaginatedAutomationRulesDto'>;
export type AutomationRun = ApiSchema<'AutomationRunResponseDto'>;
export type PaginatedAutomationRuns = ApiSchema<'PaginatedAutomationRunsDto'>;
export type AutomationMessage = ApiSchema<'AutomationMessageResponseDto'>;
export type PaginatedAutomationMessages = ApiSchema<'PaginatedAutomationMessagesDto'>;
export type AutomationActionResult = ApiSchema<'AutomationActionResultDto'>;
export type AutomationTestResult = ApiSchema<'AutomationRuleTestResultDto'>;

export interface AutomationJournalFilters {
  page: number;
  limit: number;
  ruleId?: string | undefined;
  documentType?: string | undefined;
  status?: string | undefined;
  /** Лише для повідомлень: `true` — лише тестові, `false` — без тестових. */
  isTest?: boolean | undefined;
  /** Дні за Києвом `YYYY-MM-DD` включно. */
  from?: string | undefined;
  to?: string | undefined;
}

export const automationKeys = {
  all: ['automation'] as const,
  rules: () => [...automationKeys.all, 'rules'] as const,
  rule: (id: string) => [...automationKeys.all, 'rule', id] as const,
  runs: (f: AutomationJournalFilters) => [...automationKeys.all, 'runs', f] as const,
  messages: (f: AutomationJournalFilters) => [...automationKeys.all, 'messages', f] as const,
};

/**
 * Усі правила організації — одним запитом (їх десятки, не тисячі; API віддає до 200): пошук і
 * фільтри списку — на клієнті, тож перемикання стану не перечитує сторінку.
 */
export function useAutomationRules(enabled = true) {
  return useQuery({
    queryKey: automationKeys.rules(),
    queryFn: ({ signal }) =>
      apiFetch<PaginatedAutomationRules>('/automation/rules?limit=200', { signal }),
    enabled,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
}

/** Картка правила: свіжа з сервера при кожному відкритті. */
export function useAutomationRule(id: string | null, enabled = true) {
  return useQuery({
    queryKey: automationKeys.rule(id ?? ''),
    queryFn: ({ signal }) => apiFetch<AutomationRule>(`/automation/rules/${id}`, { signal }),
    enabled: enabled && !!id,
    staleTime: 0,
  });
}

function journalParams(f: AutomationJournalFilters): URLSearchParams {
  const p = new URLSearchParams({ page: String(f.page), limit: String(f.limit) });
  if (f.ruleId) p.set('ruleId', f.ruleId);
  if (f.documentType) p.set('documentType', f.documentType);
  if (f.status) p.set('status', f.status);
  if (f.isTest !== undefined) p.set('isTest', String(f.isTest));
  if (f.from) p.set('from', f.from);
  if (f.to) p.set('to', f.to);
  return p;
}

export function useAutomationRuns(f: AutomationJournalFilters, enabled = true) {
  return useQuery({
    queryKey: automationKeys.runs(f),
    queryFn: ({ signal }) => {
      const p = journalParams(f);
      p.delete('isTest');
      return apiFetch<PaginatedAutomationRuns>(`/automation/runs?${p}`, { signal });
    },
    enabled,
    staleTime: 15_000,
    placeholderData: keepPreviousData,
  });
}

export function useAutomationMessages(f: AutomationJournalFilters, enabled = true) {
  return useQuery({
    queryKey: automationKeys.messages(f),
    queryFn: ({ signal }) =>
      apiFetch<PaginatedAutomationMessages>(`/automation/messages?${journalParams(f)}`, {
        signal,
      }),
    enabled,
    staleTime: 15_000,
    placeholderData: keepPreviousData,
  });
}

export function useSaveAutomationRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string | null; body: AutomationRuleFormValues }) =>
      apiFetch<AutomationRule>(id ? `/automation/rules/${id}` : '/automation/rules', {
        method: id ? 'PATCH' : 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: saved => {
      qc.setQueryData(automationKeys.rule(saved.id), saved);
      return qc.invalidateQueries({ queryKey: automationKeys.rules() });
    },
  });
}

export function useToggleAutomationRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      apiFetch<AutomationRule>(`/automation/rules/${id}/enabled`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled }),
      }),
    onSuccess: saved => {
      qc.setQueryData(automationKeys.rule(saved.id), saved);
      return qc.invalidateQueries({ queryKey: automationKeys.rules() });
    },
  });
}

export function useDeleteAutomationRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/automation/rules/${id}`, { method: 'DELETE' }),
    onSuccess: (_r, id) => {
      qc.removeQueries({ queryKey: automationKeys.rule(id) });
      return qc.invalidateQueries({ queryKey: automationKeys.rules() });
    },
  });
}

/** «Надіслати тест» (BR-AUT-051): журнал повідомлень після нього — свіжий. */
export function useTestAutomationRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, documentId }: { id: string; documentId: string }) =>
      apiFetch<AutomationTestResult>(`/automation/rules/${id}/test`, {
        method: 'POST',
        body: JSON.stringify({ documentId }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: [...automationKeys.all, 'messages'] }),
  });
}
