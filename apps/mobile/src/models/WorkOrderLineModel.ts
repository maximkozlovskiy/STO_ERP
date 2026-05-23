import { Model } from '@nozbe/watermelondb';
import { field } from '@nozbe/watermelondb/decorators';

export class WorkOrderLineModel extends Model {
  static table = 'work_order_lines';

  @field('remote_id') remoteId!: string;
  @field('work_order_id') workOrderId!: string;
  @field('work_name') workName!: string | null;
  @field('employee_name') employeeName!: string | null;
  @field('normo_hours') normoHours!: number;
  @field('price') price!: number;
  @field('amount') amount!: number;
  @field('notes') notes!: string | null;
}
