'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CheckCircle2, ListTodo, Play, Plus, Search, User } from 'lucide-react';
import { TASK_STATUS_BADGE, isTaskManagerRole } from '@sto/shared';
import { useRequireAuth } from '@/lib/auth';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { taskActions, type TaskAction } from '@/lib/task-actions';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { taskStatusLabel, woPriorityLabel } from '@/i18n/enumLabel';
import { useDebounce } from '@/hooks/useDebounce';
import { useListPage } from '@/hooks/useListPage';
import { useSortState } from '@/hooks/useSortState';
import { type SavedFilter } from '@/hooks/useSavedFilters';
import {
  TASK_PRIORITIES,
  TASK_STATUSES,
  useTaskAssignees,
  useTaskList,
  useTransitionTask,
  type Task,
  type TaskListFilters,
  type TaskPriority,
  type TaskStatus,
} from '@/hooks/api/useTasks';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { StatusPill } from '@/components/ui/status-pill';
import { ListFiltersRow, ListStatusRow } from '@/components/ui/list-toolbar';
import { DateRangeFilter } from '@/components/ui/date-range-filter';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { Pagination } from '@/components/ui/pagination';
import { ListLoadError } from '@/components/ui/list-load-error';
import { ColumnsDropdown } from '@/components/ui/columns-dropdown';
import { SavedFiltersBar, SaveFilterButton } from '@/components/ui/saved-filters-bar';
import { TableContainer } from '@/components/ui/table-container';
import { TaskEditModal } from '@/components/ui/TaskEditModal';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  SortableHead,
} from '@/components/ui/table';

interface TaskFilters extends Record<string, unknown> {
  search: string;
  status: string;
  priority: string;
  assigneeId: string;
  mine: boolean;
  overdue: boolean;
  from: string;
  to: string;
}

const COLUMN_DEFS: Array<{ key: string; labelKey: string }> = [
  { key: 'title', labelKey: 'columns.title' },
  { key: 'status', labelKey: 'columns.status' },
  { key: 'priority', labelKey: 'columns.priority' },
  { key: 'assignee', labelKey: 'columns.assignee' },
  { key: 'dueAt', labelKey: 'columns.dueAt' },
  { key: 'startAt', labelKey: 'columns.startAt' },
  { key: 'links', labelKey: 'columns.links' },
  { key: 'createdAt', labelKey: 'columns.createdAt' },
];
const DEFAULT_KEYS_JSON = JSON.stringify(COLUMN_DEFS.map(c => c.key));
const SORTABLE = new Set(['dueAt', 'startAt', 'priority', 'createdAt']);
const NO_ITEMS: readonly Task[] = Object.freeze([]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ROW_ACTION_ICON: Partial<Record<TaskAction['labelKey'], typeof Play>> = {
  'action.start': Play,
  'action.done': CheckCircle2,
};

const isStatus = (v: unknown): v is TaskStatus => TASK_STATUSES.includes(v as TaskStatus);
const isPriority = (v: unknown): v is TaskPriority => TASK_PRIORITIES.includes(v as TaskPriority);

/** Картка: `taskId` — існуюча, `null` — нова. */
type CardState = { taskId: string | null } | null;

/**
 * Задачі співробітникам (docs/objects/task.md). Список за стандартом списків: статуси, чип «Мої
 * задачі» (типово увімкнений для ролей поза керуванням — як «Мої наряди»), «Прострочені»,
 * пошук, виконавець, пріоритет, період, колонки, збережені фільтри. Рядок відкриває картку;
 * «Взяти в роботу» / «Виконано» — у рядку. Видимість задач (BR-TASK-002) тримає сервер.
 */
function TasksPageClient() {
  const { employee } = useRequireAuth([
    'OWNER',
    'ADMIN',
    'RECEPTIONIST',
    'MECHANIC',
    'STOREKEEPER',
    'ACCOUNTANT',
  ]);
  const { t } = useTranslation('tasks');
  const router = useRouter();
  const searchParams = useSearchParams();
  const isManager = isTaskManagerRole(employee?.role);

  const columns = useMemo(() => COLUMN_DEFS.map(c => ({ ...c, label: t(c.labelKey) })), [t]);
  const {
    page,
    setPage,
    resetPage,
    activeSavedFilterId,
    setActiveSavedFilterId,
    tableColumns: {
      visibleKeys,
      visibleColumns,
      orderedColumns,
      order,
      customLabels,
      toggle,
      setVisible,
      reorder,
      renameColumn,
      resetConfig,
    },
    dragProps,
    savedFilters: { saved, save, remove },
    features,
    limit,
  } = useListPage<TaskFilters>('tasks', columns, { defaultLimit: 20 });

  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search);
  const [status, setStatus] = useState<TaskStatus | ''>('');
  const [priority, setPriority] = useState<TaskPriority | ''>('');
  const [assigneeId, setAssigneeId] = useState('');
  const [mine, setMine] = useState(false);
  const [overdue, setOverdue] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const { sort, toggle: toggleSort, set: setSort } = useSortState('dueAt', 'asc');
  const [card, setCard] = useState<CardState>(null);

  // «Мої задачі» типово увімкнено для ролей поза керуванням — один раз, коли відомий працівник
  // (як «Мої наряди» механіка). Сервер і без чипа віддає їм лише свої задачі.
  const mineInitRef = useRef(false);
  useEffect(() => {
    if (employee && !mineInitRef.current) {
      mineInitRef.current = true;
      if (!isTaskManagerRole(employee.role)) setMine(true);
    }
  }, [employee]);

  const filters: TaskListFilters = {
    page,
    limit,
    q: debouncedSearch.trim() || undefined,
    statuses: status ? [status] : undefined,
    priorities: priority ? [priority] : undefined,
    assigneeId: assigneeId || undefined,
    mine: mine || undefined,
    overdue: overdue || undefined,
    from: from || undefined,
    to: to || undefined,
    sortBy: SORTABLE.has(sort.sortBy) ? (sort.sortBy as TaskListFilters['sortBy']) : 'dueAt',
    sortDir: sort.sortDir,
  };
  const { data, isLoading, error, refetch } = useTaskList(filters, !!employee);
  const items = data?.items ?? NO_ITEMS;
  const totalPages = data ? Math.ceil(data.total / limit) : 0;

  const assignees = useTaskAssignees(employee?.role);
  const assigneeOptions = useMemo(
    () =>
      (assignees.data?.items ?? [])
        .filter(e => !e.deletedAt)
        .map(e => ({ id: e.id, name: `${e.lastName} ${e.firstName}`.trim() })),
    [assignees.data],
  );

  // ── `?open=<id>` — посилання з календаря / наряду відкриває картку задачі ──
  const openParam = searchParams.get('open');
  useEffect(() => {
    if (!openParam || !UUID_RE.test(openParam)) return;
    setCard({ taskId: openParam });
    router.replace('/tasks', { scroll: false });
  }, [openParam, router]);

  const changed = () => {
    resetPage();
    setActiveSavedFilterId(null);
  };

  const applyFilter = useCallback(
    (preset: SavedFilter<TaskFilters>) => {
      const f = preset.filters;
      setSearch(f.search ?? '');
      setStatus(isStatus(f.status) ? f.status : '');
      setPriority(isPriority(f.priority) ? f.priority : '');
      setAssigneeId(typeof f.assigneeId === 'string' ? f.assigneeId : '');
      setMine(!!f.mine);
      setOverdue(!!f.overdue);
      setFrom(typeof f.from === 'string' ? f.from : '');
      setTo(typeof f.to === 'string' ? f.to : '');
      if (preset.order && preset.order.length > 0) reorder(preset.order);
      if (preset.columns && preset.columns.length > 0) setVisible(preset.columns);
      if (preset.sort) setSort(preset.sort.field, preset.sort.dir);
      resetPage();
      setActiveSavedFilterId(preset.id);
    },
    [reorder, setVisible, setSort, resetPage, setActiveSavedFilterId],
  );

  const handleSaveFilter = useCallback(
    (name: string) => {
      const preset = save(
        name,
        { search, status, priority, assigneeId, mine, overdue, from, to },
        { columns: [...visibleKeys], order, sort: { field: sort.sortBy, dir: sort.sortDir } },
      );
      setActiveSavedFilterId(preset.id);
    },
    [
      save,
      search,
      status,
      priority,
      assigneeId,
      mine,
      overdue,
      from,
      to,
      visibleKeys,
      order,
      sort,
      setActiveSavedFilterId,
    ],
  );

  // ── Перехід статусу з рядка: per-row стан, а не один на сторінку ──
  const transition = useTransitionTask();
  const [busyId, setBusyId] = useState<string | null>(null);
  const runRowAction = async (task: Task, action: TaskAction) => {
    if (busyId) return;
    setBusyId(task.id);
    try {
      const next = await transition.mutateAsync({ id: task.id, status: action.to });
      toast.success(t('toast.status', { status: taskStatusLabel(next.status) }));
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : t('form.loadError'));
    } finally {
      setBusyId(null);
    }
  };

  const colSpan = visibleColumns.length + 1;
  const filtered =
    !!status || !!priority || !!assigneeId || overdue || !!from || !!to || !!debouncedSearch;

  const chip = (active: boolean, onClick: () => void, icon: typeof User, label: string) => {
    const Icon = icon;
    return (
      <button
        type="button"
        aria-pressed={active}
        onClick={onClick}
        className={cn(
          'inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-sm font-medium border transition-colors',
          active
            ? 'bg-primary text-primary-foreground border-primary shadow-sm'
            : 'border-border text-muted-foreground bg-surface hover:bg-secondary hover:text-foreground',
        )}
      >
        <Icon className="h-3 w-3 shrink-0" aria-hidden="true" />
        {label}
      </button>
    );
  };

  return (
    <div className="page-fill p-4 md:p-6">
      <div className="page-header">
        <h1 className="page-title">{t('title')}</h1>
      </div>

      {features.savedFiltersEnabled && (
        <SavedFiltersBar<TaskFilters>
          saved={saved}
          activeId={activeSavedFilterId}
          onApply={applyFilter}
          onSave={handleSaveFilter}
          onRemove={remove}
          hideSaveButton
        />
      )}

      <ListStatusRow
        label={t('statusLabel')}
        right={
          employee && (
            <div className="flex flex-wrap items-center gap-1.5">
              {chip(
                overdue,
                () => {
                  setOverdue(v => !v);
                  changed();
                },
                AlertTriangle,
                t('overdueOnly'),
              )}
              {chip(
                mine,
                () => {
                  setMine(v => !v);
                  changed();
                },
                User,
                t('myTasks'),
              )}
            </div>
          )
        }
      >
        {(['', ...TASK_STATUSES] as const).map(s => (
          <StatusPill
            key={s}
            value={s}
            label={s ? taskStatusLabel(s) : t('all')}
            active={status === s}
            onSelect={v => {
              setStatus(isStatus(v) ? v : '');
              changed();
            }}
          />
        ))}
      </ListStatusRow>

      <ListFiltersRow
        actions={
          <>
            {features.savedFiltersEnabled && <SaveFilterButton onSave={handleSaveFilter} />}
            <ColumnsDropdown
              columns={orderedColumns}
              visibleKeys={visibleKeys}
              onToggle={toggle}
              onReorder={reorder}
              onRename={renameColumn}
              onReset={resetConfig}
              hasCustomization={
                JSON.stringify(order) !== DEFAULT_KEYS_JSON || Object.keys(customLabels).length > 0
              }
            />
            {isManager && (
              <Button onClick={() => setCard({ taskId: null })}>
                <Plus className="h-4 w-4" aria-hidden="true" />
                {t('newTask')}
              </Button>
            )}
          </>
        }
      >
        <Input
          value={search}
          onChange={e => {
            setSearch(e.target.value);
            changed();
          }}
          placeholder={t('searchPlaceholder')}
          aria-label={t('searchPlaceholder')}
          maxLength={100}
          leftElement={<Search />}
          className="w-72 h-8 text-[13px]"
        />
        {isManager && (
          <Select
            aria-label={t('columns.assignee')}
            value={assigneeId}
            onChange={e => {
              setAssigneeId(e.target.value);
              changed();
            }}
            className="w-52 h-8 text-[13px] py-0.5 px-2 pr-7"
          >
            <option value="">{t('assigneeAll')}</option>
            {assigneeOptions.map(o => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </Select>
        )}
        <Select
          aria-label={t('columns.priority')}
          value={priority}
          onChange={e => {
            setPriority(isPriority(e.target.value) ? e.target.value : '');
            changed();
          }}
          className="w-44 h-8 text-[13px] py-0.5 px-2 pr-7"
        >
          <option value="">{t('priorityAll')}</option>
          {TASK_PRIORITIES.map(p => (
            <option key={p} value={p}>
              {woPriorityLabel(p)}
            </option>
          ))}
        </Select>
        <DateRangeFilter
          from={from}
          to={to}
          onFromChange={v => {
            setFrom(v);
            changed();
          }}
          onToChange={v => {
            setTo(v);
            changed();
          }}
          fromLabel={t('periodFrom')}
          toLabel={t('periodTo')}
        />
      </ListFiltersRow>

      <ListLoadError error={data ? null : error} onRetry={() => void refetch()} />

      <TableContainer>
        <Table>
          <TableHeader>
            <TableRow>
              {visibleColumns.map(col =>
                SORTABLE.has(col.key) ? (
                  <SortableHead
                    key={col.key}
                    sortKey={col.key}
                    currentSort={sort}
                    onSort={toggleSort}
                    {...dragProps(col.key)}
                  >
                    {col.label}
                  </SortableHead>
                ) : (
                  <TableHead key={col.key} {...dragProps(col.key)}>
                    {col.label}
                  </TableHead>
                ),
              )}
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow>
                <TableCell colSpan={colSpan} className="py-12 text-center">
                  <div className="flex justify-center">
                    <Spinner size="md" />
                  </div>
                </TableCell>
              </TableRow>
            )}
            {!isLoading && !error && items.length === 0 && (
              <TableRow>
                <TableCell colSpan={colSpan} className="p-0">
                  <EmptyState
                    icon={ListTodo}
                    title={t('empty.title')}
                    description={filtered ? t('empty.descFilter') : t('empty.desc')}
                    size="sm"
                  />
                </TableCell>
              </TableRow>
            )}
            {!isLoading &&
              items.map(task => {
                const actions = taskActions(task, employee).filter(
                  a => ROW_ACTION_ICON[a.labelKey],
                );
                return (
                  <TableRow
                    key={task.id}
                    data-task-id={task.id}
                    data-overdue={task.overdue ? 'true' : undefined}
                    onClick={() => setCard({ taskId: task.id })}
                    className={cn(
                      'group cursor-pointer transition-colors',
                      task.overdue && 'bg-destructive-subtle/40',
                    )}
                  >
                    {visibleColumns.map(col => {
                      if (col.key === 'title')
                        return (
                          <TableCell key="title" className="max-w-80">
                            <button
                              type="button"
                              className="text-left text-[13px] font-semibold text-foreground hover:text-primary hover:underline line-clamp-2 wrap-break-word"
                              onClick={e => {
                                e.stopPropagation();
                                setCard({ taskId: task.id });
                              }}
                            >
                              {task.title}
                            </button>
                          </TableCell>
                        );
                      if (col.key === 'status')
                        return (
                          <TableCell key="status">
                            <div className="flex flex-wrap items-center gap-1">
                              <Badge variant={TASK_STATUS_BADGE[task.status] ?? 'secondary'} dot>
                                {taskStatusLabel(task.status)}
                              </Badge>
                              {task.overdue && <Badge variant="destructive">{t('overdue')}</Badge>}
                            </div>
                          </TableCell>
                        );
                      if (col.key === 'priority')
                        return (
                          <TableCell key="priority" className="text-[13px]">
                            {woPriorityLabel(task.priority)}
                          </TableCell>
                        );
                      if (col.key === 'assignee')
                        return (
                          <TableCell key="assignee" className="text-[13px]">
                            {task.assigneeName || '—'}
                          </TableCell>
                        );
                      if (col.key === 'dueAt')
                        return (
                          <TableCell
                            key="dueAt"
                            className={cn(
                              'text-[13px] tabular-nums whitespace-nowrap',
                              task.overdue && 'text-destructive-text font-medium',
                            )}
                          >
                            {task.dueAt ? fmtDateTime(task.dueAt) : '—'}
                          </TableCell>
                        );
                      if (col.key === 'startAt')
                        return (
                          <TableCell
                            key="startAt"
                            className="text-[13px] tabular-nums whitespace-nowrap text-muted-foreground"
                          >
                            {task.startAt ? fmtDateTime(task.startAt) : '—'}
                          </TableCell>
                        );
                      if (col.key === 'links') {
                        const wo = task.workOrderNumber
                          ? task.workOrderDeleted
                            ? t('workOrderDeleted', { number: task.workOrderNumber })
                            : task.workOrderNumber
                          : null;
                        return (
                          <TableCell key="links" className="text-[13px] max-w-64">
                            {wo && <p className="font-medium text-foreground">{wo}</p>}
                            <p className="text-[12px] text-muted-foreground truncate">
                              {[task.counterpartyName, task.vehicleSummary]
                                .filter(Boolean)
                                .join(' · ') || (wo ? '' : '—')}
                            </p>
                          </TableCell>
                        );
                      }
                      if (col.key === 'createdAt')
                        return (
                          <TableCell key="createdAt" className="text-[13px] text-muted-foreground">
                            {fmtDate(task.createdAt)}
                          </TableCell>
                        );
                      return null;
                    })}
                    <TableCell className="text-right" onClick={e => e.stopPropagation()}>
                      <div className="flex justify-end gap-1">
                        {actions.map(a => {
                          const Icon = ROW_ACTION_ICON[a.labelKey]!;
                          const label = t(a.labelKey);
                          return (
                            <Button
                              key={a.to}
                              variant="ghost"
                              size="icon-sm"
                              title={label}
                              aria-label={t('action.aria', { action: label, title: task.title })}
                              loading={busyId === task.id}
                              disabled={!!busyId}
                              data-action={a.to}
                              onClick={() => void runRowAction(task, a)}
                            >
                              <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                            </Button>
                          );
                        })}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
          </TableBody>
        </Table>
      </TableContainer>

      <Pagination page={page} totalPages={totalPages} onChange={setPage} />

      <TaskEditModal open={!!card} taskId={card?.taskId ?? null} onClose={() => setCard(null)} />
    </div>
  );
}

export default function TasksPage() {
  return (
    <Suspense fallback={null}>
      <TasksPageClient />
    </Suspense>
  );
}
