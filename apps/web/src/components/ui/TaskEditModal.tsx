'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, Play, RotateCcw, Trash2, XCircle } from 'lucide-react';
import {
  TASK_DESCRIPTION_MAX,
  TASK_STATUS_BADGE,
  TASK_TITLE_MAX,
  isTaskManagerRole,
  taskFormSchema,
  type TaskFormInput,
  type TaskFormValues,
} from '@sto/shared';
import { Modal, ModalFooter } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import { DateTimePickerInput } from '@/components/ui/datetime-picker-input';
import { EntityPickerField } from '@/components/ui/entity-picker-field';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { DirtyConfirmDialog } from '@/components/ui/dirty-confirm-dialog';
import { CommentsSection } from '@/components/ui/CommentsSection';
import { apiFetch } from '@/lib/api-client';
import { useAuth } from '@/lib/auth';
import { fmtDateTime, isoToKyivLocalDateTime, localDateTimeToISO } from '@/lib/format';
import { i18nZodResolver } from '@/lib/i18nZodResolver';
import { taskActions, type TaskAction } from '@/lib/task-actions';
import { toast } from '@/lib/toast';
import { displayCounterpartyName } from '@/lib/utils';
import { taskStatusLabel, woPriorityLabel } from '@/i18n/enumLabel';
import { useConfirm } from '@/hooks/useConfirm';
import { useDirtyForm } from '@/hooks/useDirtyForm';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import {
  TASK_PRIORITIES,
  useDeleteTask,
  useSaveTask,
  useTask,
  useTaskAssignees,
  useTransitionTask,
  type Task,
} from '@/hooks/api/useTasks';

/** Підставлені значення нової задачі: з календаря (дата), з картки наряду (наряд, авто, клієнт). */
export interface TaskPrefill {
  /** Київський настінний час 'YYYY-MM-DDTHH:mm'. */
  startAt?: string;
  dueAt?: string;
  assigneeId?: string;
  workOrderId?: string;
  workOrderDisplay?: string;
  counterpartyId?: string;
  counterpartyDisplay?: string;
  vehicleId?: string;
  vehicleDisplay?: string;
}

interface Props {
  open: boolean;
  /** `null` — нова задача. */
  taskId: string | null;
  prefill?: TaskPrefill;
  onClose: () => void;
  onSaved?: (task: Task) => void;
}

const EMPTY: TaskFormInput = {
  title: '',
  description: '',
  assigneeId: '',
  priority: 'NORMAL',
  startAt: '',
  dueAt: '',
  workOrderId: '',
  vehicleId: '',
  counterpartyId: '',
};

interface Displays {
  workOrder: string;
  counterparty: string;
  vehicle: string;
}
const NO_DISPLAYS: Displays = { workOrder: '', counterparty: '', vehicle: '' };

type SearchItem = { id: string; primary: string; secondary?: string };
type WoItem = SearchItem & {
  counterpartyId?: string | null;
  counterpartyName?: string;
  vehicleId?: string | null;
  vehicleSummary?: string;
};
interface VehicleOption {
  id: string;
  make?: string | null;
  model?: string | null;
  licensePlate?: string | null;
}

const ACTION_ICON: Record<TaskAction['labelKey'], typeof Play> = {
  'action.start': Play,
  'action.reopen': RotateCcw,
  'action.done': CheckCircle2,
  'action.cancel': XCircle,
};

const vehicleText = (v: VehicleOption) =>
  [v.make, v.model, v.licensePlate].filter(Boolean).join(' ');

function taskToForm(t: Task): TaskFormInput {
  return {
    title: t.title,
    description: t.description ?? '',
    assigneeId: t.assigneeId,
    priority: t.priority,
    startAt: isoToKyivLocalDateTime(t.startAt),
    dueAt: isoToKyivLocalDateTime(t.dueAt),
    workOrderId: t.workOrderId ?? '',
    vehicleId: t.vehicleId ?? '',
    counterpartyId: t.counterpartyId ?? '',
  };
}

/**
 * Картка задачі співробітнику (docs/objects/task.md). Керівник (OWNER / ADMIN / RECEPTIONIST,
 * BR-TASK-001) ставить і править задачу; виконавець бачить поля лише для читання, рухає статус
 * своєї задачі (BR-TASK-003) і пише коментарі (BR-TASK-008). Форма — спільна `taskFormSchema`.
 */
export function TaskEditModal({ open, taskId, prefill, onClose, onSaved }: Props) {
  const { t } = useTranslation('tasks');
  const { employee } = useAuth();
  const features = useUiFeatures();
  const isManager = isTaskManagerRole(employee?.role);
  const dirty = useDirtyForm({ enabled: features.unsavedGuardEnabled });
  const { confirm, dialogProps } = useConfirm();

  const taskQuery = useTask(taskId, open);
  const task = taskId ? taskQuery.data : undefined;
  const assignees = useTaskAssignees(open ? employee?.role : null);
  const saveTask = useSaveTask();
  const transition = useTransitionTask();
  const deleteTask = useDeleteTask();

  const [error, setError] = useState('');
  const [displays, setDisplays] = useState<Displays>(NO_DISPLAYS);
  const [vehicles, setVehicles] = useState<VehicleOption[]>([]);
  const [vehiclesLoaded, setVehiclesLoaded] = useState(false);
  const savingRef = useRef(false);
  // Для якої задачі форма вже заповнена: перечитана після переходу статусу задача не має
  // скидати незбережені правки полів.
  const filledForRef = useRef<string | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    trigger,
    watch,
    formState: { errors, isDirty: rhfDirty },
  } = useForm<TaskFormInput, unknown, TaskFormValues>({
    resolver: i18nZodResolver(taskFormSchema),
    defaultValues: EMPTY,
    // Помилки — після першої спроби зберегти, далі на льоту: на «onBlur» модалка, що забирає
    // фокус з autoFocus-поля, показувала «Вкажіть, що треба зробити» на чистій формі, а зникнення
    // помилки зсувало поля під курсором (перший клік по даті не відкривав вибір).
    mode: 'onSubmit',
    reValidateMode: 'onChange',
  });
  const form = watch();

  // ── Заповнення: нова — з підставлених значень, існуюча — з відповіді сервера (один раз) ──
  useEffect(() => {
    if (!open) {
      filledForRef.current = null;
      return;
    }
    setError('');
    savingRef.current = false;
    if (taskId) return;
    reset({
      ...EMPTY,
      startAt: prefill?.startAt ?? '',
      dueAt: prefill?.dueAt ?? '',
      assigneeId: prefill?.assigneeId ?? '',
      workOrderId: prefill?.workOrderId ?? '',
      counterpartyId: prefill?.counterpartyId ?? '',
      vehicleId: prefill?.vehicleId ?? '',
    });
    setDisplays({
      workOrder: prefill?.workOrderDisplay ?? '',
      counterparty: prefill?.counterpartyDisplay ?? '',
      vehicle: prefill?.vehicleDisplay ?? '',
    });
    dirty.resetDirty();
    filledForRef.current = 'new';
    // prefill — значення на момент відкриття; зміна батьком під відкритою карткою не скидає форму.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, taskId]);

  useEffect(() => {
    if (!open || !task || filledForRef.current === task.id) return;
    reset(taskToForm(task));
    setDisplays({
      workOrder: task.workOrderNumber
        ? task.workOrderDeleted
          ? t('workOrderDeleted', { number: task.workOrderNumber })
          : task.workOrderNumber
        : '',
      counterparty: task.counterpartyName ?? '',
      vehicle: task.vehicleSummary ?? '',
    });
    dirty.resetDirty();
    filledForRef.current = task.id;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, task]);

  useEffect(() => {
    if (rhfDirty) dirty.markDirty();
    else dirty.resetDirty();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rhfDirty]);

  // ── Авто клієнта: перелік читається при зміні клієнта; авто іншого клієнта скидається ──
  const counterpartyId = form.counterpartyId ?? '';
  useEffect(() => {
    setVehicles([]);
    setVehiclesLoaded(false);
    if (!open || !isManager || !counterpartyId) return;
    const ac = new AbortController();
    apiFetch<VehicleOption[]>(`/vehicles?counterpartyId=${counterpartyId}`, { signal: ac.signal })
      .then(list => {
        if (ac.signal.aborted) return;
        setVehicles(list);
        setVehiclesLoaded(true);
      })
      .catch(() => {
        if (!ac.signal.aborted) setVehiclesLoaded(true);
      });
    return () => ac.abort();
  }, [open, isManager, counterpartyId]);

  const fetchWorkOrders = useCallback(async (q: string): Promise<WoItem[]> => {
    const params = new URLSearchParams({ limit: '20' });
    if (q.trim()) params.set('q', q.trim());
    const data = await apiFetch<{
      items: Array<{
        id: string;
        number: string;
        counterpartyId?: string | null;
        counterpartyName?: string;
        vehicleId?: string | null;
        vehicleSummary?: string;
      }>;
    }>(`/work-orders?${params}`);
    return data.items.map(wo => ({
      id: wo.id,
      primary: wo.number,
      secondary: [wo.counterpartyName, wo.vehicleSummary].filter(Boolean).join(' · ') || undefined,
      counterpartyId: wo.counterpartyId,
      counterpartyName: wo.counterpartyName,
      vehicleId: wo.vehicleId,
      vehicleSummary: wo.vehicleSummary,
    }));
  }, []);

  const fetchCounterparties = useCallback(async (q: string): Promise<SearchItem[]> => {
    const params = new URLSearchParams({ limit: '20' });
    params.append('types', 'CLIENT');
    params.append('types', 'BOTH');
    if (q.trim()) params.set('q', q.trim());
    const data = await apiFetch<{
      items: Array<{
        id: string;
        companyName?: string | null;
        firstName?: string | null;
        lastName?: string | null;
        phone?: string | null;
      }>;
    }>(`/counterparties?${params}`);
    return data.items.map(cp => ({
      id: cp.id,
      primary: displayCounterpartyName(cp),
      secondary: cp.phone ?? undefined,
    }));
  }, []);

  const setField = (name: keyof TaskFormInput, value: string) => {
    setValue(name, value, { shouldDirty: true });
    // «Термін раніше початку» (BR-TASK-004) стоїть на полі терміну, а залежить від обох: зміна
    // будь-якого з них перевіряє термін наново, інакше стара помилка лишалась би після виправлення.
    if (name === 'dueAt' || name === 'startAt') void trigger('dueAt');
  };

  // ── Виконавці: активні працівники; збережений недоступний — окремою позначкою, лише коли
  // перелік уже прочитано (інакше на мить «недоступний» висів би й над активним) ──
  const assigneeOptions = useMemo(() => {
    const items = assignees.data?.items ?? [];
    return items
      .filter(e => e.status === 'ACTIVE' && !e.deletedAt)
      .map(e => ({ id: e.id, name: `${e.lastName} ${e.firstName}`.trim() }));
  }, [assignees.data]);
  const savedAssigneeMissing =
    !!task &&
    assignees.isSuccess &&
    form.assigneeId === task.assigneeId &&
    !assigneeOptions.some(o => o.id === task.assigneeId);

  const vehicleOptions = useMemo(() => {
    const list = vehicles.map(v => ({ id: v.id, label: vehicleText(v) }));
    const current = form.vehicleId ?? '';
    if (current && !list.some(v => v.id === current) && displays.vehicle)
      list.unshift({ id: current, label: displays.vehicle });
    return list;
  }, [vehicles, form.vehicleId, displays.vehicle]);

  const handleClose = async () => {
    if (savingRef.current) return;
    if (isManager && !(await dirty.confirmClose())) return;
    onClose();
  };

  const onValid = handleSubmit(async values => {
    if (savingRef.current || !isManager) return;
    savingRef.current = true;
    setError('');
    try {
      const saved = await saveTask.mutateAsync({
        id: taskId,
        body: {
          ...values,
          startAt: values.startAt ? localDateTimeToISO(values.startAt) : undefined,
          dueAt: values.dueAt ? localDateTimeToISO(values.dueAt) : undefined,
        },
      });
      if (features.toastEnabled) toast.success(t(taskId ? 'toast.saved' : 'toast.created'));
      dirty.resetDirty();
      onSaved?.(saved);
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('form.loadError'));
    } finally {
      savingRef.current = false;
    }
  });

  const runAction = async (action: TaskAction) => {
    if (!task) return;
    if (action.to === 'CANCELLED') {
      const ok = await confirm({
        title: t('cancelConfirm.title'),
        message: t('cancelConfirm.message', { title: task.title }),
        confirmLabel: t('action.cancel'),
        variant: 'destructive',
      });
      if (!ok) return;
    }
    try {
      const next = await transition.mutateAsync({ id: task.id, status: action.to });
      toast.success(t('toast.status', { status: taskStatusLabel(next.status) }));
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : t('form.loadError'));
    }
  };

  const remove = async () => {
    if (!task) return;
    const ok = await confirm({
      title: t('deleteConfirm.title'),
      message: t('deleteConfirm.message', { title: task.title }),
      confirmLabel: t('form.delete'),
      variant: 'destructive',
    });
    if (!ok) return;
    try {
      await deleteTask.mutateAsync(task.id);
      if (features.toastEnabled) toast.success(t('toast.deleted'));
      dirty.resetDirty();
      onClose();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : t('form.loadError'));
    }
  };

  const actions = task ? taskActions(task, employee) : [];
  const loading = !!taskId && taskQuery.isLoading;
  const loadFailed = !!taskId && taskQuery.isError && !task;
  const editable = isManager;
  const title = taskId ? (task?.title ?? t('title')) : t('newTaskTitle');

  return (
    <>
      <Modal
        open={open}
        onClose={() => void handleClose()}
        title={title}
        size="lg"
        onSubmit={editable && !loading && !loadFailed ? () => void onValid() : undefined}
        footer={
          <ModalFooter>
            {editable && task && (
              <Button
                variant="ghost"
                className="mr-auto text-destructive/70 hover:text-destructive hover:bg-destructive/10"
                onClick={() => void remove()}
                loading={deleteTask.isPending}
              >
                <Trash2 className="h-4 w-4" aria-hidden="true" />
                {t('form.delete')}
              </Button>
            )}
            {editable ? (
              <>
                <Button variant="outline" onClick={() => void handleClose()}>
                  {t('form.cancel')}
                </Button>
                <Button
                  onClick={() => void onValid()}
                  loading={saveTask.isPending}
                  disabled={loading || loadFailed}
                >
                  {taskId ? t('form.save') : t('form.create')}
                </Button>
              </>
            ) : (
              <Button variant="outline" onClick={onClose}>
                {t('form.close')}
              </Button>
            )}
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
            {taskQuery.error instanceof Error ? taskQuery.error.message : t('form.loadError')}
          </p>
        )}
        {!loading && !loadFailed && (
          <div className="space-y-4" data-testid="task-card">
            {error && (
              <div
                role="alert"
                className="text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-3 py-2"
              >
                {error}
              </div>
            )}

            {task && (
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={TASK_STATUS_BADGE[task.status] ?? 'secondary'} dot>
                  {taskStatusLabel(task.status)}
                </Badge>
                {task.overdue && (
                  <Badge variant="destructive" data-testid="task-overdue">
                    {t('overdue')}
                  </Badge>
                )}
                <div className="ml-auto flex flex-wrap gap-2">
                  {actions.map(a => {
                    const Icon = ACTION_ICON[a.labelKey];
                    return (
                      <Button
                        key={a.to}
                        size="sm"
                        variant={a.to === 'CANCELLED' ? 'outline' : 'default'}
                        onClick={() => void runAction(a)}
                        loading={transition.isPending && transition.variables?.status === a.to}
                        disabled={transition.isPending}
                        data-action={a.to}
                      >
                        <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                        {t(a.labelKey)}
                      </Button>
                    );
                  })}
                </div>
              </div>
            )}

            {!editable && task && (
              <>
                <p className="text-[12px] text-muted-foreground">{t('form.readOnlyHint')}</p>
                <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-[13px]">
                  <dt className="text-muted-foreground">{t('form.title')}</dt>
                  <dd className="font-medium text-foreground wrap-break-word">{task.title}</dd>
                  {task.description && (
                    <>
                      <dt className="text-muted-foreground">{t('form.description')}</dt>
                      <dd className="whitespace-pre-wrap wrap-break-word text-foreground">
                        {task.description}
                      </dd>
                    </>
                  )}
                  <dt className="text-muted-foreground">{t('form.assignee')}</dt>
                  <dd className="text-foreground">{task.assigneeName}</dd>
                  <dt className="text-muted-foreground">{t('form.priority')}</dt>
                  <dd className="text-foreground">{woPriorityLabel(task.priority)}</dd>
                  <dt className="text-muted-foreground">{t('form.startAt')}</dt>
                  <dd className="text-foreground tabular-nums">{fmtDateTime(task.startAt)}</dd>
                  <dt className="text-muted-foreground">{t('form.dueAt')}</dt>
                  <dd
                    className={`tabular-nums ${task.overdue ? 'text-destructive-text font-medium' : 'text-foreground'}`}
                  >
                    {fmtDateTime(task.dueAt)}
                  </dd>
                  {(displays.workOrder || displays.counterparty || displays.vehicle) && (
                    <>
                      <dt className="text-muted-foreground">{t('form.links')}</dt>
                      <dd className="text-foreground">
                        {[displays.workOrder, displays.counterparty, displays.vehicle]
                          .filter(Boolean)
                          .join(' · ')}
                      </dd>
                    </>
                  )}
                  <dt className="text-muted-foreground">{t('form.createdBy')}</dt>
                  <dd className="text-foreground">{task.createdByName}</dd>
                  {task.completedAt && (
                    <>
                      <dt className="text-muted-foreground">{t('form.completedAt')}</dt>
                      <dd className="text-foreground tabular-nums">
                        {fmtDateTime(task.completedAt)}
                      </dd>
                    </>
                  )}
                </dl>
              </>
            )}

            {editable && (
              <>
                <Input
                  label={t('form.title')}
                  required
                  placeholder={t('form.titlePlaceholder')}
                  maxLength={TASK_TITLE_MAX}
                  errorMessage={errors.title?.message}
                  autoFocus={!taskId}
                  {...register('title')}
                />
                <div className="flex flex-col gap-1">
                  <label
                    htmlFor="task-description"
                    className="text-[13px] font-medium text-foreground leading-none"
                  >
                    {t('form.description')}
                  </label>
                  <textarea
                    id="task-description"
                    rows={3}
                    maxLength={TASK_DESCRIPTION_MAX}
                    className="w-full rounded-lg border border-input bg-transparent px-3 py-2 text-[13px] text-foreground outline-none focus:ring-2 focus:ring-primary/30 resize-y"
                    aria-invalid={!!errors.description}
                    {...register('description')}
                  />
                  {errors.description?.message && (
                    <p className="text-[12px] text-destructive-text">
                      {errors.description.message}
                    </p>
                  )}
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Select
                    id="task-assignee"
                    label={t('form.assignee')}
                    required
                    errorMessage={errors.assigneeId?.message}
                    {...register('assigneeId')}
                    // Кероване значення: позначка «(недоступний)» з'являється в переліку ПІСЛЯ
                    // `reset` (значення форми ще порожнє на першому рендері), і некерований select
                    // лишався без вибору — поле виглядало порожнім (Bug #985).
                    value={form.assigneeId ?? ''}
                  >
                    <option value="">{t('form.assigneePlaceholder')}</option>
                    {savedAssigneeMissing && task && (
                      <option value={task.assigneeId} disabled>
                        {t('form.assigneeUnavailable', { name: task.assigneeName })}
                      </option>
                    )}
                    {assigneeOptions.map(o => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                    {/* Збережений виконавець, поки перелік читається, — щоб select не показав
                        порожнє значення на мить */}
                    {task &&
                      !assignees.isSuccess &&
                      !assigneeOptions.some(o => o.id === task.assigneeId) && (
                        <option value={task.assigneeId}>{task.assigneeName}</option>
                      )}
                  </Select>
                  <Select id="task-priority" label={t('form.priority')} {...register('priority')}>
                    {TASK_PRIORITIES.map(p => (
                      <option key={p} value={p}>
                        {woPriorityLabel(p)}
                      </option>
                    ))}
                  </Select>
                  <DateTimePickerInput
                    label={t('form.startAt')}
                    value={form.startAt ?? ''}
                    onChange={v => setField('startAt', v)}
                    clearable
                  />
                  <div>
                    <DateTimePickerInput
                      label={t('form.dueAt')}
                      value={form.dueAt ?? ''}
                      onChange={v => setField('dueAt', v)}
                      clearable
                    />
                    {errors.dueAt?.message && (
                      <p className="mt-1 text-[12px] text-destructive-text" role="alert">
                        {errors.dueAt.message}
                      </p>
                    )}
                  </div>
                </div>
                <p className="text-[12px] text-muted-foreground">{t('form.notTimeBlocking')}</p>

                <fieldset className="space-y-3">
                  <legend className="text-[13px] font-medium text-foreground mb-2">
                    {t('form.links')}
                  </legend>
                  <EntityPickerField<WoItem>
                    label={t('form.workOrder')}
                    display={displays.workOrder}
                    placeholder={t('form.workOrderPlaceholder')}
                    ariaLabel={t('form.workOrder')}
                    hidePick
                    hideDetail
                    onSearch={fetchWorkOrders}
                    onSearchSelect={item => {
                      setField('workOrderId', item.id);
                      const next: Displays = { ...displays, workOrder: item.primary };
                      if (item.counterpartyId) {
                        setField('counterpartyId', item.counterpartyId);
                        next.counterparty = item.counterpartyName ?? '';
                      }
                      if (item.vehicleId) {
                        setField('vehicleId', item.vehicleId);
                        next.vehicle = item.vehicleSummary ?? '';
                      }
                      setDisplays(next);
                    }}
                    onClear={() => {
                      setField('workOrderId', '');
                      setDisplays(d => ({ ...d, workOrder: '' }));
                    }}
                  />
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <EntityPickerField
                      label={t('form.counterparty')}
                      display={displays.counterparty}
                      placeholder={t('form.counterpartyPlaceholder')}
                      ariaLabel={t('form.counterparty')}
                      hidePick
                      hideDetail
                      onSearch={fetchCounterparties}
                      onSearchSelect={item => {
                        if (item.id === counterpartyId) return;
                        // Авто попереднього клієнта не належить новому — скидається.
                        setField('counterpartyId', item.id);
                        setField('vehicleId', '');
                        setDisplays(d => ({ ...d, counterparty: item.primary, vehicle: '' }));
                      }}
                      onClear={() => {
                        setField('counterpartyId', '');
                        setField('vehicleId', '');
                        setDisplays(d => ({ ...d, counterparty: '', vehicle: '' }));
                      }}
                    />
                    <Select
                      id="task-vehicle"
                      label={t('form.vehicle')}
                      value={form.vehicleId ?? ''}
                      disabled={!counterpartyId && !form.vehicleId}
                      onChange={e => {
                        const id = e.target.value;
                        setField('vehicleId', id);
                        setDisplays(d => ({
                          ...d,
                          vehicle: vehicleOptions.find(v => v.id === id)?.label ?? '',
                        }));
                      }}
                    >
                      <option value="">
                        {!counterpartyId && !form.vehicleId
                          ? t('form.vehicleSelectClientFirst')
                          : vehiclesLoaded && vehicles.length === 0
                            ? t('form.noVehicles')
                            : t('form.vehicleNone')}
                      </option>
                      {vehicleOptions.map(v => (
                        <option key={v.id} value={v.id}>
                          {v.label}
                        </option>
                      ))}
                    </Select>
                  </div>
                </fieldset>
              </>
            )}

            {task && (
              <CommentsSection
                entityType="Task"
                entityId={task.id}
                variant="plain"
                className="border-t border-border pt-4"
              />
            )}
          </div>
        )}
      </Modal>
      <ConfirmDialog {...dialogProps} />
      <DirtyConfirmDialog {...dirty.dialogProps} />
    </>
  );
}
