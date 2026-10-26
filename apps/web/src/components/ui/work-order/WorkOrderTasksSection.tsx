'use client';

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ListPlus, ListTodo } from 'lucide-react';
import { TASK_STATUS_BADGE, isTaskManagerRole } from '@sto/shared';
import { useAuth } from '@/lib/auth';
import { fmtDateTime } from '@/lib/format';
import { taskStatusLabel } from '@/i18n/enumLabel';
import { useTaskList } from '@/hooks/api/useTasks';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { TaskEditModal, type TaskPrefill } from '@/components/ui/TaskEditModal';

interface Props {
  workOrderId: string;
  workOrderNumber: string;
  counterpartyId?: string | null;
  counterpartyName?: string;
  vehicleId?: string | null;
  vehicleSummary?: string | null;
}

/**
 * «Задачі наряду» на вкладці «Документи» картки наряду (docs/objects/task.md): задачі, прив'язані
 * до наряду, і «Створити задачу» з підставленими нарядом, клієнтом і авто. Перелік — той самий
 * `GET /tasks?workOrderId=`, тож механік бачить лише свої задачі наряду (BR-TASK-002).
 */
export function WorkOrderTasksSection({
  workOrderId,
  workOrderNumber,
  counterpartyId,
  counterpartyName,
  vehicleId,
  vehicleSummary,
}: Props) {
  const { t } = useTranslation('tasks');
  const { employee } = useAuth();
  const canCreate = isTaskManagerRole(employee?.role);
  const { data, isLoading } = useTaskList({ page: 1, limit: 50, workOrderId }, !!employee);
  const [card, setCard] = useState<{ taskId: string | null; prefill?: TaskPrefill } | null>(null);
  const items = data?.items ?? [];

  const create = () =>
    setCard({
      taskId: null,
      prefill: {
        workOrderId,
        workOrderDisplay: workOrderNumber,
        counterpartyId: counterpartyId ?? undefined,
        counterpartyDisplay: counterpartyName,
        vehicleId: vehicleId ?? undefined,
        vehicleDisplay: vehicleSummary ?? undefined,
      },
    });

  return (
    <section className="mt-4 rounded-xl border border-border bg-surface p-4" data-testid="wo-tasks">
      <div className="mb-3 flex items-center gap-2">
        <ListTodo className="h-4 w-4 text-primary" aria-hidden="true" />
        <h3 className="text-[13px] font-semibold text-foreground">{t('workOrderSection.title')}</h3>
        {canCreate && (
          <Button size="sm" variant="outline" className="ml-auto" onClick={create}>
            <ListPlus className="h-3.5 w-3.5" aria-hidden="true" />
            {t('workOrderSection.create')}
          </Button>
        )}
      </div>
      {isLoading && (
        <div className="flex justify-center py-3">
          <Spinner size="sm" />
        </div>
      )}
      {!isLoading && items.length === 0 && (
        <p className="text-[13px] text-muted-foreground">{t('workOrderSection.empty')}</p>
      )}
      {items.length > 0 && (
        <ul className="divide-y divide-border">
          {items.map(task => (
            <li key={task.id}>
              <button
                type="button"
                onClick={() => setCard({ taskId: task.id })}
                className="flex w-full items-center gap-2 py-2 text-left text-[13px] hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded"
                data-task-id={task.id}
              >
                <Badge variant={TASK_STATUS_BADGE[task.status] ?? 'secondary'} dot>
                  {taskStatusLabel(task.status)}
                </Badge>
                <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                  {task.title}
                </span>
                <span className="shrink-0 text-muted-foreground">{task.assigneeName}</span>
                <span
                  className={`shrink-0 tabular-nums ${task.overdue ? 'text-destructive-text font-medium' : 'text-muted-foreground'}`}
                >
                  {task.dueAt ? fmtDateTime(task.dueAt) : '—'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <TaskEditModal
        open={!!card}
        taskId={card?.taskId ?? null}
        prefill={card?.prefill}
        onClose={() => setCard(null)}
      />
    </section>
  );
}
