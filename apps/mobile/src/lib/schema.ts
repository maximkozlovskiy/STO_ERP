import { appSchema, tableSchema } from '@nozbe/watermelondb';

export const schema = appSchema({
  version: 1,
  tables: [
    tableSchema({
      name: 'work_orders',
      columns: [
        { name: 'remote_id', type: 'string', isIndexed: true },
        { name: 'org_id', type: 'string' },
        { name: 'number', type: 'string' },
        { name: 'status', type: 'string' },
        { name: 'vehicle_summary', type: 'string', isOptional: true },
        { name: 'counterparty_name', type: 'string', isOptional: true },
        { name: 'description', type: 'string', isOptional: true },
        { name: 'in_mileage', type: 'number', isOptional: true },
        { name: 'out_mileage', type: 'number', isOptional: true },
        { name: 'planned_at', type: 'number', isOptional: true },
        { name: 'completed_at', type: 'number', isOptional: true },
        { name: 'total_labor', type: 'number' },
        { name: 'total_parts', type: 'number' },
        { name: 'total_amount', type: 'number' },
        { name: 'paid_amount', type: 'number' },
        { name: 'synced_at', type: 'number', isOptional: true },
        { name: 'is_dirty', type: 'boolean' },
      ],
    }),
    tableSchema({
      name: 'work_order_lines',
      columns: [
        { name: 'remote_id', type: 'string', isIndexed: true },
        { name: 'work_order_id', type: 'string', isIndexed: true },
        { name: 'work_name', type: 'string', isOptional: true },
        { name: 'employee_name', type: 'string', isOptional: true },
        { name: 'normo_hours', type: 'number' },
        { name: 'price', type: 'number' },
        { name: 'amount', type: 'number' },
        { name: 'notes', type: 'string', isOptional: true },
      ],
    }),
    tableSchema({
      name: 'work_order_parts',
      columns: [
        { name: 'remote_id', type: 'string', isIndexed: true },
        { name: 'work_order_id', type: 'string', isIndexed: true },
        { name: 'good_name', type: 'string', isOptional: true },
        { name: 'quantity', type: 'number' },
        { name: 'price', type: 'number' },
        { name: 'amount', type: 'number' },
      ],
    }),
  ],
});
