import { Model } from '@nozbe/watermelondb';
import { field, date, readonly } from '@nozbe/watermelondb/decorators';

export class WorkOrderModel extends Model {
  static table = 'work_orders';

  @field('remote_id') remoteId!: string;
  @field('org_id') orgId!: string;
  @field('number') number!: string;
  @field('status') status!: string;
  @field('vehicle_summary') vehicleSummary!: string | null;
  @field('counterparty_name') counterpartyName!: string | null;
  @field('description') description!: string | null;
  @field('in_mileage') inMileage!: number | null;
  @field('out_mileage') outMileage!: number | null;
  @field('planned_at') plannedAt!: number | null;
  @field('completed_at') completedAt!: number | null;
  @field('total_labor') totalLabor!: number;
  @field('total_parts') totalParts!: number;
  @field('total_amount') totalAmount!: number;
  @field('paid_amount') paidAmount!: number;
  @field('synced_at') syncedAt!: number;
  @field('is_dirty') isDirty!: boolean;
}
