import { Model } from '@nozbe/watermelondb';
import { field } from '@nozbe/watermelondb/decorators';

/**
 * Локальна копія «моєї» задачі (docs/objects/task.md). `status` змінюється офлайн разом з
 * `is_dirty = true`; на сервер іде через `POST /tasks/:id/transition` (`pushDirtyTasks`), бо
 * FSM задачі (BR-TASK-003) сервер перевіряє сам. Мітки часу — мс UTC.
 */
export class TaskModel extends Model {
  static table = 'tasks';

  @field('remote_id') remoteId!: string;
  @field('title') title!: string;
  @field('description') description!: string | null;
  @field('status') status!: string;
  @field('priority') priority!: string;
  @field('start_at') startAt!: number | null;
  @field('due_at') dueAt!: number | null;
  @field('completed_at') completedAt!: number | null;
  @field('created_by_name') createdByName!: string | null;
  @field('work_order_id') workOrderId!: string | null;
  @field('work_order_number') workOrderNumber!: string | null;
  @field('work_order_deleted') workOrderDeleted!: boolean;
  @field('vehicle_summary') vehicleSummary!: string | null;
  @field('counterparty_name') counterpartyName!: string | null;
  @field('synced_at') syncedAt!: number | null;
  @field('is_dirty') isDirty!: boolean;
}
