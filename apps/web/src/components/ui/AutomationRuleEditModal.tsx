'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { FormProvider, useFieldArray, useForm, useWatch, type FieldErrors } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2 } from 'lucide-react';
import {
  AUTOMATION_ACTION_TYPES,
  AUTOMATION_AMOUNT_DOCUMENT_TYPES,
  AUTOMATION_CLIENT_DOCUMENT_TYPES,
  AUTOMATION_CREATED_STATUSES,
  AUTOMATION_DOCUMENT_TYPES,
  AUTOMATION_EVENT_KINDS,
  AUTOMATION_MESSAGE_KINDS,
  AUTOMATION_PRIORITIES,
  AUTOMATION_PRIORITY_DOCUMENT_TYPES,
  AUTOMATION_REPAIR_CATEGORIES,
  AUTOMATION_RULE_NAME_MAX,
  automationRuleSchema,
  type AutomationActionTypeValue,
  type AutomationDocumentTypeValue,
  type AutomationRuleFormInput,
  type AutomationRuleFormValues,
} from '@sto/shared';
import { apiFetch } from '@/lib/api-client';
import { useAuth } from '@/lib/auth';
import { i18nZodResolver } from '@/lib/i18nZodResolver';
import { getCached, setCache } from '@/lib/ref-cache';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import {
  automationDocumentTypeLabel,
  automationEventKindLabel,
  automationStatusCodes,
  automationStatusLabel,
} from '@/lib/automation';
import { woCategoryLabel, woPriorityLabel } from '@/i18n/enumLabel';
import { useConfirm } from '@/hooks/useConfirm';
import { useDirtyForm } from '@/hooks/useDirtyForm';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import { useTaskAssignees } from '@/hooks/api/useTasks';
import {
  useAutomationRule,
  useDeleteAutomationRule,
  useSaveAutomationRule,
  type AutomationRule,
} from '@/hooks/api/useAutomation';
import {
  AutomationActionCard,
  ACTION_ICONS,
  newAction,
  type EmployeeOption,
} from './AutomationRuleActions';
import { AutomationJournal } from './AutomationJournal';
import { AutomationTestModal } from './AutomationTestModal';
import { Badge } from './badge';
import { Button } from './button';
import { ConfirmDialog } from './confirm-dialog';
import { DirtyConfirmDialog } from './dirty-confirm-dialog';
import { Input } from './input';
import { Modal, ModalFooter } from './modal';
import { Select } from './select';
import { Spinner } from './spinner';
import { Switch } from './switch';

type Tab = 'event' | 'conditions' | 'actions' | 'journal';
interface BranchInfo {
  id: string;
  name: string;
}

const EMPTY_CONDITIONS = {
  branchIds: [],
  fromStatuses: [],
  repairCategories: [],
  priorities: [],
  minAmount: undefined,
};

const EMPTY_RULE: AutomationRuleFormInput = {
  name: '',
  enabled: true,
  documentType: 'WORK_ORDER',
  eventKind: 'STATUS_CHANGED',
  toStatuses: [],
  messageKind: 'SERVICE',
  conditions: EMPTY_CONDITIONS,
  actions: [],
};

/**
 * Правило з API → значення форми. Збережене правило вже пройшло ту саму схему на сервері; тут
 * лише заповнюємо порожні необов'язкові поля, щоб поля форми були керованими.
 */
export function ruleToForm(rule: AutomationRule): AutomationRuleFormInput {
  const raw = {
    name: rule.name,
    enabled: rule.enabled,
    documentType: rule.documentType,
    eventKind: rule.eventKind,
    toStatuses: rule.toStatuses,
    messageKind: rule.messageKind,
    conditions: rule.conditions,
    actions: rule.actions,
  };
  const parsed = automationRuleSchema.safeParse(raw);
  // Правило, що вже не проходить схему (перелік статусів змінився), показуємо як є — помилки
  // з'являться при збереженні, а не зникне саме правило.
  const v = parsed.success ? parsed.data : (raw as unknown as AutomationRuleFormValues);
  return {
    ...v,
    toStatuses: v.toStatuses ?? [],
    conditions: { ...EMPTY_CONDITIONS, ...v.conditions },
    actions: (v.actions ?? []).map(a => {
      switch (a.type) {
        case 'client_message':
          return {
            ...a,
            channels: a.channels ?? [],
            template: { subject: a.template.subject ?? '', body: a.template.body },
          };
        case 'employee_notification':
          return {
            ...a,
            body: a.body ?? '',
            ...(a.external && {
              external: {
                channels: a.external.channels ?? [],
                template: {
                  subject: a.external.template.subject ?? '',
                  body: a.external.template.body,
                },
              },
            }),
          };
        case 'create_task':
          return {
            ...a,
            description: a.description ?? '',
            fallbackEmployeeId: a.fallbackEmployeeId ?? '',
          };
        default:
          return a;
      }
    }),
  };
}

const TAB_FIELDS: Record<
  Exclude<Tab, 'journal'>,
  (keyof FieldErrors<AutomationRuleFormInput>)[]
> = {
  event: ['name', 'enabled', 'documentType', 'eventKind', 'toStatuses', 'messageKind'],
  conditions: ['conditions'],
  actions: ['actions'],
};

function CheckboxGroup({
  legend,
  hint,
  options,
  value,
  onChange,
  error,
  testId,
}: {
  legend: string;
  hint?: string;
  options: { value: string; label: string }[];
  value: readonly string[];
  onChange: (next: string[]) => void;
  error?: string | undefined;
  testId: string;
}) {
  return (
    <fieldset data-testid={testId}>
      <legend className="text-[13px] font-medium text-foreground mb-1.5">{legend}</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
        {options.map(o => (
          <label key={o.value} className="flex items-center gap-1.5 text-[13px] cursor-pointer">
            <input
              type="checkbox"
              checked={value.includes(o.value)}
              onChange={e =>
                onChange(e.target.checked ? [...value, o.value] : value.filter(v => v !== o.value))
              }
            />
            {o.label}
          </label>
        ))}
      </div>
      {hint && <p className="mt-1 text-[12px] text-muted-foreground">{hint}</p>}
      {error && (
        <p className="mt-1 text-[12px] text-destructive-text" role="alert">
          {error}
        </p>
      )}
    </fieldset>
  );
}

/** Перша помилка масиву (`toStatuses.2`) чи самого поля. */
function arrayError(node: unknown): string | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const msg = (node as { message?: unknown }).message;
  if (typeof msg === 'string') return msg;
  for (const child of Object.values(node)) {
    const m = arrayError(child);
    if (m) return m;
  }
  return undefined;
}

interface AutomationRuleEditModalProps {
  open: boolean;
  /** `null` — нове правило. */
  ruleId: string | null;
  onClose: () => void;
  /** Нове правило створено — батько відкриває його картку (журнал, тест). */
  onCreated?: (rule: AutomationRule) => void;
}

/**
 * Картка правила автоматизації (docs/objects/automation.md, US-AUT-1…5): вкладки «Подія / Умови /
 * Дії / Журнал». Валідація — спільна `automationRuleSchema` (та сама, що на сервері); масив дій —
 * `useFieldArray`; незбережені зміни — `useDirtyForm`. Зміна документа чи події скидає умови й
 * статуси, яких у нового документа немає, і перевіряє шаблони наново (каталог змінних інший).
 */
export function AutomationRuleEditModal({
  open,
  ruleId,
  onClose,
  onCreated,
}: AutomationRuleEditModalProps) {
  const { t } = useTranslation('automation');
  const { employee } = useAuth();
  const features = useUiFeatures();
  const dirty = useDirtyForm({ enabled: features.unsavedGuardEnabled });
  const { confirm, dialogProps } = useConfirm();
  const ruleQuery = useAutomationRule(ruleId, open);
  const rule = ruleId ? ruleQuery.data : undefined;
  const save = useSaveAutomationRule();
  const remove = useDeleteAutomationRule();
  const assignees = useTaskAssignees(open ? employee?.role : null);

  const [tab, setTab] = useState<Tab>('event');
  const [error, setError] = useState('');
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [testOpen, setTestOpen] = useState(false);
  const savingRef = useRef(false);
  const filledForRef = useRef<string | null>(null);

  const form = useForm<AutomationRuleFormInput, unknown, AutomationRuleFormValues>({
    resolver: i18nZodResolver(automationRuleSchema),
    defaultValues: EMPTY_RULE,
    mode: 'onSubmit',
    reValidateMode: 'onChange',
  });
  const {
    control,
    register,
    handleSubmit,
    reset,
    setValue,
    trigger,
    getValues,
    formState: { errors, isDirty: rhfDirty, isSubmitted },
  } = form;
  const actionsArray = useFieldArray({ control, name: 'actions' });
  const documentType = useWatch({ control, name: 'documentType' });
  const eventKind = useWatch({ control, name: 'eventKind' });
  const toStatuses = useWatch({ control, name: 'toStatuses' }) ?? [];
  const conditions = useWatch({ control, name: 'conditions' }) ?? EMPTY_CONDITIONS;

  // ── Заповнення: нове — порожня форма, існуюче — з сервера (один раз на правило) ──
  useEffect(() => {
    if (!open) {
      filledForRef.current = null;
      return;
    }
    setError('');
    savingRef.current = false;
    if (ruleId) return;
    setTab('event');
    reset(EMPTY_RULE);
    dirty.resetDirty();
    filledForRef.current = 'new';
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ruleId]);

  useEffect(() => {
    if (!open || !rule || filledForRef.current === rule.id) return;
    // Щойно створене правило (було 'new') лишається на вкладці «Дії» — там «Надіслати тест».
    if (filledForRef.current !== 'new') setTab('event');
    reset(ruleToForm(rule));
    dirty.resetDirty();
    filledForRef.current = rule.id;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, rule]);

  useEffect(() => {
    if (rhfDirty) dirty.markDirty();
    else dirty.resetDirty();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rhfDirty]);

  useEffect(() => {
    if (!open) return;
    const cached = getCached<BranchInfo[]>('cache:branches');
    if (cached) setBranches(cached);
    const ac = new AbortController();
    apiFetch<{ items: BranchInfo[] } | BranchInfo[]>('/branches', { signal: ac.signal })
      .then(d => {
        const list = Array.isArray(d) ? d : d.items;
        setBranches(list);
        setCache(
          'cache:branches',
          list.map(b => ({ id: b.id, name: b.name })),
        );
      })
      .catch(() => {
        /* філії з кешу або без умови філії — не критично для картки */
      });
    return () => ac.abort();
  }, [open]);

  const employees = useMemo<EmployeeOption[]>(
    () =>
      (assignees.data?.items ?? []).map(e => ({
        id: e.id,
        name: `${e.lastName} ${e.firstName}`.trim(),
        active: e.status === 'ACTIVE' && !e.deletedAt,
      })),
    [assignees.data],
  );

  // ── Залежні поля: інший документ / подія → прибрати недоречне й перевірити наново ──
  const revalidate = () => {
    if (isSubmitted) void trigger();
  };
  const changeDocumentType = (next: AutomationDocumentTypeValue) => {
    const opts = { shouldDirty: true } as const;
    setValue('documentType', next, opts);
    setValue('toStatuses', [], opts);
    const c = getValues('conditions') ?? EMPTY_CONDITIONS;
    setValue(
      'conditions',
      {
        ...EMPTY_CONDITIONS,
        branchIds: c.branchIds ?? [],
        priorities: AUTOMATION_PRIORITY_DOCUMENT_TYPES.includes(next) ? (c.priorities ?? []) : [],
        repairCategories: next === 'WORK_ORDER' ? (c.repairCategories ?? []) : [],
        minAmount: AUTOMATION_AMOUNT_DOCUMENT_TYPES.includes(next) ? c.minAmount : undefined,
      },
      opts,
    );
    revalidate();
  };
  const changeEventKind = (next: 'CREATED' | 'STATUS_CHANGED') => {
    const opts = { shouldDirty: true } as const;
    setValue('eventKind', next, opts);
    if (next === 'CREATED') {
      setValue('conditions.fromStatuses', [], opts);
      const allowed = AUTOMATION_CREATED_STATUSES[getValues('documentType')];
      if (allowed)
        setValue(
          'toStatuses',
          (getValues('toStatuses') ?? []).filter(s => allowed.includes(s)),
          opts,
        );
    }
    revalidate();
  };

  const statusOptions = useMemo(() => {
    const codes = automationStatusCodes(documentType);
    const allowed = eventKind === 'CREATED' ? AUTOMATION_CREATED_STATUSES[documentType] : undefined;
    return codes
      .filter(c => !allowed || allowed.includes(c))
      .map(c => ({ value: c, label: automationStatusLabel(documentType, c) }));
  }, [documentType, eventKind]);
  const fromStatusOptions = useMemo(
    () =>
      automationStatusCodes(documentType).map(c => ({
        value: c,
        label: automationStatusLabel(documentType, c),
      })),
    [documentType],
  );

  const tabHasErrors = (key: Tab): boolean =>
    key !== 'journal' && TAB_FIELDS[key].some(f => !!errors[f]);

  const handleClose = async () => {
    if (savingRef.current) return;
    if (!(await dirty.confirmClose())) return;
    onClose();
  };

  const onValid = handleSubmit(
    async values => {
      if (savingRef.current) return;
      savingRef.current = true;
      setError('');
      try {
        const saved = await save.mutateAsync({ id: ruleId, body: values });
        if (features.toastEnabled) toast.success(t(ruleId ? 'toast.saved' : 'toast.created'));
        dirty.resetDirty();
        if (ruleId) onClose();
        else {
          reset(ruleToForm(saved));
          setTab('actions');
          onCreated?.(saved);
        }
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : t('card.loadError'));
      } finally {
        savingRef.current = false;
      }
    },
    errs => {
      setError(t('card.invalid'));
      const first = (['event', 'conditions', 'actions'] as const).find(k =>
        TAB_FIELDS[k].some(f => !!errs[f]),
      );
      if (first) setTab(first);
    },
  );

  const deleteRule = async () => {
    if (!rule) return;
    const ok = await confirm({
      title: t('deleteConfirm.title'),
      message: t('deleteConfirm.message', { name: rule.name }),
      confirmLabel: t('card.delete'),
      variant: 'destructive',
    });
    if (!ok) return;
    try {
      await remove.mutateAsync(rule.id);
      if (features.toastEnabled) toast.success(t('toast.deleted'));
      dirty.resetDirty();
      onClose();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : t('card.loadError'));
    }
  };

  const loading = !!ruleId && ruleQuery.isLoading;
  const loadFailed = !!ruleId && ruleQuery.isError && !rule;
  const sendTestBlockedReason = !ruleId || rhfDirty ? t('card.saveFirst') : undefined;
  const clientAllowed = AUTOMATION_CLIENT_DOCUMENT_TYPES.includes(documentType);
  const amountAllowed = AUTOMATION_AMOUNT_DOCUMENT_TYPES.includes(documentType);
  const priorityAllowed = AUTOMATION_PRIORITY_DOCUMENT_TYPES.includes(documentType);
  const hasExtraConditions =
    eventKind === 'STATUS_CHANGED' ||
    documentType === 'WORK_ORDER' ||
    priorityAllowed ||
    amountAllowed;

  const addableTypes = AUTOMATION_ACTION_TYPES.filter(type =>
    type === 'client_message'
      ? clientAllowed
      : type === 'create_task'
        ? documentType !== 'TASK'
        : true,
  );
  const addAction = (type: AutomationActionTypeValue) => {
    actionsArray.append(newAction(type));
    revalidate();
  };

  const tabs: { key: Tab; label: string; count?: number }[] = [
    { key: 'event', label: t('card.tabs.event') },
    { key: 'conditions', label: t('card.tabs.conditions') },
    { key: 'actions', label: t('card.tabs.actions'), count: actionsArray.fields.length },
    ...(ruleId ? [{ key: 'journal' as const, label: t('card.tabs.journal') }] : []),
  ];

  const title = ruleId ? (rule?.name ?? t('title')) : t('newRuleTitle');

  return (
    <>
      <Modal
        open={open}
        onClose={() => void handleClose()}
        title={title}
        size="xl"
        fixedHeight
        onSubmit={!loading && !loadFailed && tab !== 'journal' ? () => void onValid() : undefined}
        footer={
          <ModalFooter>
            {rule && !rule.systemKey && (
              <Button
                variant="ghost"
                className="mr-auto text-destructive/70 hover:text-destructive hover:bg-destructive/10"
                onClick={() => void deleteRule()}
                loading={remove.isPending}
              >
                <Trash2 className="h-4 w-4" aria-hidden="true" />
                {t('card.delete')}
              </Button>
            )}
            <Button variant="outline" onClick={() => void handleClose()}>
              {t('card.cancel')}
            </Button>
            <Button
              onClick={() => void onValid()}
              loading={save.isPending}
              disabled={loading || loadFailed}
            >
              {ruleId ? t('card.save') : t('card.create')}
            </Button>
          </ModalFooter>
        }
      >
        {loading && (
          <div className="flex justify-center py-8">
            <Spinner size="md" />
          </div>
        )}
        {loadFailed && (
          <p className="text-[13px] text-destructive-text" role="alert">
            {ruleQuery.error instanceof Error ? ruleQuery.error.message : t('card.loadError')}
          </p>
        )}
        {!loading && !loadFailed && (
          <FormProvider {...form}>
            <div data-testid="automation-rule-card">
              <div
                role="tablist"
                className="sticky top-0 z-10 -mx-6 -mt-5 mb-5 flex gap-0 overflow-x-auto border-b border-border bg-surface px-6 pt-1"
              >
                {tabs.map(tb => (
                  <button
                    key={tb.key}
                    type="button"
                    role="tab"
                    aria-selected={tab === tb.key}
                    onClick={() => setTab(tb.key)}
                    className={cn(
                      'flex items-center gap-1.5 px-4 py-2.5 text-[13px] font-medium whitespace-nowrap border-b-2 transition-colors shrink-0',
                      tab === tb.key
                        ? 'text-primary border-primary'
                        : 'text-muted-foreground border-transparent hover:text-foreground',
                    )}
                  >
                    {tb.label}
                    {typeof tb.count === 'number' && (
                      <span className="rounded-full bg-secondary px-1.5 text-[11px] tabular-nums">
                        {tb.count}
                      </span>
                    )}
                    {tabHasErrors(tb.key) && (
                      <span
                        role="img"
                        className="h-1.5 w-1.5 rounded-full bg-destructive"
                        title={t('card.tabHasErrors')}
                        aria-label={t('card.tabHasErrors')}
                      />
                    )}
                  </button>
                ))}
              </div>

              {error && (
                <div
                  role="alert"
                  className="mb-4 text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-3 py-2"
                >
                  {error}
                </div>
              )}

              {tab === 'event' && (
                <div className="space-y-4">
                  {rule?.systemKey && (
                    <Badge variant="info" tooltip={t('systemHint')}>
                      {t('system')}
                    </Badge>
                  )}
                  <Input
                    id="rule-name"
                    label={t('card.name')}
                    required
                    placeholder={t('card.namePlaceholder')}
                    maxLength={AUTOMATION_RULE_NAME_MAX}
                    errorMessage={errors.name?.message}
                    autoFocus={!ruleId}
                    {...register('name')}
                  />
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={!!form.watch('enabled')}
                      onChange={v => setValue('enabled', v, { shouldDirty: true })}
                      ariaLabel={t('card.enabled')}
                    />
                    <span className="text-[13px] text-foreground">{t('card.enabled')}</span>
                  </div>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <Select
                      id="rule-document-type"
                      label={t('card.documentType')}
                      value={documentType}
                      onChange={e => {
                        const v = AUTOMATION_DOCUMENT_TYPES.find(d => d === e.target.value);
                        if (v) changeDocumentType(v);
                      }}
                    >
                      {AUTOMATION_DOCUMENT_TYPES.map(d => (
                        <option key={d} value={d}>
                          {automationDocumentTypeLabel(d)}
                        </option>
                      ))}
                    </Select>
                    <Select
                      id="rule-event-kind"
                      label={t('card.eventKind')}
                      value={eventKind}
                      onChange={e => {
                        const v = AUTOMATION_EVENT_KINDS.find(k => k === e.target.value);
                        if (v) changeEventKind(v);
                      }}
                    >
                      {AUTOMATION_EVENT_KINDS.map(k => (
                        <option key={k} value={k}>
                          {automationEventKindLabel(k)}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <CheckboxGroup
                    legend={
                      eventKind === 'CREATED' ? t('card.toStatusesCreated') : t('card.toStatuses')
                    }
                    hint={t('card.toStatusesHint')}
                    options={statusOptions}
                    value={toStatuses}
                    onChange={next => {
                      setValue('toStatuses', next, { shouldDirty: true });
                      revalidate();
                    }}
                    error={arrayError(errors.toStatuses)}
                    testId="rule-to-statuses"
                  />
                  <div>
                    <Select
                      id="rule-message-kind"
                      label={t('card.messageKind')}
                      hint={t('messageKindHint')}
                      {...register('messageKind')}
                    >
                      {AUTOMATION_MESSAGE_KINDS.map(k => (
                        <option key={k} value={k}>
                          {t(`messageKinds.${k}`)}
                        </option>
                      ))}
                    </Select>
                  </div>
                </div>
              )}

              {tab === 'conditions' && (
                <div className="space-y-5">
                  <p className="text-[12px] text-muted-foreground">{t('card.conditionsHint')}</p>
                  {branches.length > 0 && (
                    <CheckboxGroup
                      legend={t('card.branches')}
                      hint={t('card.branchesHint')}
                      options={branches.map(b => ({ value: b.id, label: b.name }))}
                      value={conditions.branchIds ?? []}
                      onChange={next =>
                        setValue('conditions.branchIds', next, { shouldDirty: true })
                      }
                      error={arrayError(errors.conditions?.branchIds)}
                      testId="rule-branches"
                    />
                  )}
                  {eventKind === 'STATUS_CHANGED' && (
                    <CheckboxGroup
                      legend={t('card.fromStatuses')}
                      hint={t('card.fromStatusesHint')}
                      options={fromStatusOptions}
                      value={conditions.fromStatuses ?? []}
                      onChange={next =>
                        setValue('conditions.fromStatuses', next, { shouldDirty: true })
                      }
                      error={arrayError(errors.conditions?.fromStatuses)}
                      testId="rule-from-statuses"
                    />
                  )}
                  {documentType === 'WORK_ORDER' && (
                    <CheckboxGroup
                      legend={t('card.repairCategories')}
                      options={AUTOMATION_REPAIR_CATEGORIES.map(c => ({
                        value: c,
                        label: woCategoryLabel(c),
                      }))}
                      value={conditions.repairCategories ?? []}
                      onChange={next =>
                        setValue(
                          'conditions.repairCategories',
                          AUTOMATION_REPAIR_CATEGORIES.filter(c => next.includes(c)),
                          { shouldDirty: true },
                        )
                      }
                      error={arrayError(errors.conditions?.repairCategories)}
                      testId="rule-repair-categories"
                    />
                  )}
                  {priorityAllowed && (
                    <CheckboxGroup
                      legend={t('card.priorities')}
                      options={AUTOMATION_PRIORITIES.map(p => ({
                        value: p,
                        label: woPriorityLabel(p),
                      }))}
                      value={conditions.priorities ?? []}
                      onChange={next =>
                        setValue(
                          'conditions.priorities',
                          AUTOMATION_PRIORITIES.filter(p => next.includes(p)),
                          { shouldDirty: true },
                        )
                      }
                      error={arrayError(errors.conditions?.priorities)}
                      testId="rule-priorities"
                    />
                  )}
                  {amountAllowed && (
                    <div className="max-w-60">
                      <Input
                        id="rule-min-amount"
                        type="number"
                        min={0}
                        step="0.01"
                        label={t('card.minAmount')}
                        hint={t('card.minAmountHint')}
                        errorMessage={errors.conditions?.minAmount?.message}
                        {...register('conditions.minAmount', {
                          setValueAs: (v: unknown) =>
                            v === '' || v === null || v === undefined ? undefined : Number(v),
                        })}
                      />
                    </div>
                  )}
                  {!hasExtraConditions && branches.length <= 1 && (
                    <p className="text-[13px] text-muted-foreground">{t('card.noConditions')}</p>
                  )}
                </div>
              )}

              {tab === 'actions' && (
                <div className="space-y-4">
                  {actionsArray.fields.length === 0 && (
                    <p
                      className={cn(
                        'text-[13px]',
                        errors.actions ? 'text-destructive-text' : 'text-muted-foreground',
                      )}
                      role={errors.actions ? 'alert' : undefined}
                    >
                      {errors.actions?.message ??
                        errors.actions?.root?.message ??
                        t('card.noActions')}
                    </p>
                  )}
                  {actionsArray.fields.map((field, i) => (
                    <AutomationActionCard
                      key={field.id}
                      index={i}
                      count={actionsArray.fields.length}
                      documentType={documentType}
                      employees={employees}
                      employeesLoaded={assignees.isSuccess}
                      onRemove={() => {
                        actionsArray.remove(i);
                        revalidate();
                      }}
                      onMove={dir => actionsArray.move(i, i + dir)}
                      onSendTest={ruleId ? () => setTestOpen(true) : undefined}
                      sendTestBlockedReason={sendTestBlockedReason}
                    />
                  ))}
                  <div className="flex flex-wrap items-center gap-2" data-testid="add-action">
                    <span className="text-[13px] font-medium text-foreground">
                      {t('card.addAction')}:
                    </span>
                    {addableTypes.map(type => {
                      const Icon = ACTION_ICONS[type];
                      return (
                        <Button
                          key={type}
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => addAction(type)}
                          data-add-action={type}
                        >
                          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                          <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                          {t(`actionTypes.${type}`)}
                        </Button>
                      );
                    })}
                  </div>
                  {!clientAllowed && (
                    <p className="text-[12px] text-muted-foreground">
                      {t('card.clientMessageUnavailable')}
                    </p>
                  )}
                  {documentType === 'TASK' && (
                    <p className="text-[12px] text-muted-foreground">
                      {t('card.taskOnTaskUnavailable')}
                    </p>
                  )}
                </div>
              )}

              {tab === 'journal' && ruleId && <AutomationJournal ruleId={ruleId} />}
            </div>
          </FormProvider>
        )}
      </Modal>
      {ruleId && (
        <AutomationTestModal
          open={testOpen}
          ruleId={ruleId}
          documentType={documentType}
          onClose={() => setTestOpen(false)}
        />
      )}
      <ConfirmDialog {...dialogProps} />
      <DirtyConfirmDialog {...dirty.dialogProps} />
    </>
  );
}
