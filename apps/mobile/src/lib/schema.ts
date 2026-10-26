import { appSchema, tableSchema, type ColumnSchema } from '@nozbe/watermelondb';

/**
 * Колонки таблиці `tasks` — одне джерело для схеми й кроку міграції `createTable` (версія 3):
 * якщо вони розійдуться, свіжа база й оновлена матимуть різні таблиці.
 */
export const TASK_COLUMNS: readonly ColumnSchema[] = [
  { name: 'remote_id', type: 'string', isIndexed: true },
  { name: 'title', type: 'string' },
  { name: 'description', type: 'string', isOptional: true },
  { name: 'status', type: 'string', isIndexed: true },
  { name: 'priority', type: 'string' },
  { name: 'start_at', type: 'number', isOptional: true },
  { name: 'due_at', type: 'number', isOptional: true },
  { name: 'completed_at', type: 'number', isOptional: true },
  { name: 'created_by_name', type: 'string', isOptional: true },
  { name: 'work_order_id', type: 'string', isOptional: true },
  { name: 'work_order_number', type: 'string', isOptional: true },
  { name: 'work_order_deleted', type: 'boolean' },
  { name: 'vehicle_summary', type: 'string', isOptional: true },
  { name: 'counterparty_name', type: 'string', isOptional: true },
  { name: 'synced_at', type: 'number', isOptional: true },
  { name: 'is_dirty', type: 'boolean' },
];

export const schema = appSchema({
  version: 3,
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
        { name: 'total_net', type: 'number', isOptional: true },
        { name: 'total_vat', type: 'number', isOptional: true },
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
    tableSchema({ name: 'tasks', columns: [...TASK_COLUMNS] }),
  ],
});
