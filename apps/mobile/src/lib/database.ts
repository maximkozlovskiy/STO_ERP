import { Database } from '@nozbe/watermelondb';
import SQLiteAdapter from '@nozbe/watermelondb/adapters/sqlite';
import { schema } from './schema';
import { migrations } from './migrations';
import { WorkOrderModel } from '../models/WorkOrderModel';
import { WorkOrderLineModel } from '../models/WorkOrderLineModel';
import { WorkOrderPartModel } from '../models/WorkOrderPartModel';
import { TaskModel } from '../models/TaskModel';

const adapter = new SQLiteAdapter({
  schema,
  migrations,
  jsi: false,
  onSetUpError: error => {
    console.error('WatermelonDB setup error:', error);
  },
});

export const database = new Database({
  adapter,
  modelClasses: [WorkOrderModel, WorkOrderLineModel, WorkOrderPartModel, TaskModel],
});
