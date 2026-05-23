import { Model } from '@nozbe/watermelondb';
import { field } from '@nozbe/watermelondb/decorators';

export class WorkOrderPartModel extends Model {
  static table = 'work_order_parts';

  @field('remote_id') remoteId!: string;
  @field('work_order_id') workOrderId!: string;
  @field('good_name') goodName!: string | null;
  @field('quantity') quantity!: number;
  @field('price') price!: number;
  @field('amount') amount!: number;
}
