import { Q } from '@nozbe/watermelondb';
import { canTransitionTask } from '@sto/shared';
import { database } from './database';
import { ApiError, apiFetch, isNetworkError } from './api';
import type { TaskModel } from '../models/TaskModel';

interface ApiWorkOrder {
  id: string;
  orgId: string;
  number: string;
  status: string;
  vehicleSummary?: string;
  counterpartyName?: string;
  description?: string | null;
  inMileage?: number | null;
  outMileage?: number | null;
  plannedAt?: string | null;
  completedAt?: string | null;
  totalLabor: number;
  totalParts: number;
  totalNet?: number;
  totalVat?: number;
  totalAmount: number;
  paidAmount: number;
  lines: ApiWorkOrderLine[];
  parts: ApiWorkOrderPart[];
}
interface ApiWorkOrderLine {
  id: string;
  workName?: string;
  employeeName?: string;
  normoHours: number;
  price: number;
  amount: number;
  notes?: string | null;
}
interface ApiWorkOrderPart {
  id: string;
  goodName?: string;
  quantity: number;
  price: number;
  amount: number;
}

function applyWorkOrderFields(r: any, api: ApiWorkOrder, syncedAt: number) {
  r.number = api.number;
  r.status = api.status;
  r.vehicleSummary = api.vehicleSummary ?? null;
  r.counterpartyName = api.counterpartyName ?? null;
  r.description = api.description ?? null;
  r.inMileage = api.inMileage ?? null;
  r.outMileage = api.outMileage ?? null;
  r.plannedAt = api.plannedAt ? new Date(api.plannedAt).getTime() : null;
  r.completedAt = api.completedAt ? new Date(api.completedAt).getTime() : null;
  r.totalLabor = Number(api.totalLabor);
  r.totalParts = Number(api.totalParts);
  r.totalNet = api.totalNet == null ? null : Number(api.totalNet);
  r.totalVat = api.totalVat == null ? null : Number(api.totalVat);
  r.totalAmount = Number(api.totalAmount);
  r.paidAmount = Number(api.paidAmount);
  r.syncedAt = syncedAt;
}

export async function syncWorkOrders(): Promise<void> {
  let items: ApiWorkOrder[] = [];

  try {
    const res = await apiFetch<{ items: ApiWorkOrder[] }>(
      '/work-orders?limit=100&include=lines,parts',
    );
    items = res.items ?? [];
  } catch {
    return;
  }

  const wos = database.get('work_orders');
  const lines = database.get('work_order_lines');
  const parts = database.get('work_order_parts');

  // Fetch all existing records BEFORE entering write transaction
  const [existingWos, existingLines, existingParts] = await Promise.all([
    wos.query().fetch(),
    lines.query().fetch(),
    parts.query().fetch(),
  ]);

  const woByRemoteId = new Map(existingWos.map((r: any) => [r.remoteId, r]));
  const linesByWoId = new Map<string, Set<string>>();
  const partsByWoId = new Map<string, Set<string>>();

  for (const l of existingLines as any[]) {
    if (!linesByWoId.has(l.workOrderId)) linesByWoId.set(l.workOrderId, new Set());
    linesByWoId.get(l.workOrderId)!.add(l.remoteId);
  }
  for (const p of existingParts as any[]) {
    if (!partsByWoId.has(p.workOrderId)) partsByWoId.set(p.workOrderId, new Set());
    partsByWoId.get(p.workOrderId)!.add(p.remoteId);
  }

  const now = Date.now();

  await database.write(async () => {
    const operations: any[] = [];

    for (const api of items) {
      const existing = woByRemoteId.get(api.id);

      if (existing) {
        if (!existing.isDirty) {
          operations.push(existing.prepareUpdate((r: any) => applyWorkOrderFields(r, api, now)));
        }
      } else {
        operations.push(
          wos.prepareCreate((r: any) => {
            r.remoteId = api.id;
            r.orgId = api.orgId;
            r.isDirty = false;
            applyWorkOrderFields(r, api, now);
          }),
        );
      }

      const existingLineIds = linesByWoId.get(api.id) ?? new Set<string>();
      for (const line of api.lines ?? []) {
        if (!existingLineIds.has(line.id)) {
          operations.push(
            lines.prepareCreate((r: any) => {
              r.remoteId = line.id;
              r.workOrderId = api.id;
              r.workName = line.workName ?? null;
              r.employeeName = line.employeeName ?? null;
              r.normoHours = line.normoHours;
              r.price = Number(line.price);
              r.amount = Number(line.amount);
              r.notes = line.notes ?? null;
            }),
          );
        }
      }

      const existingPartIds = partsByWoId.get(api.id) ?? new Set<string>();
      for (const part of api.parts ?? []) {
        if (!existingPartIds.has(part.id)) {
          operations.push(
            parts.prepareCreate((r: any) => {
              r.remoteId = part.id;
              r.workOrderId = api.id;
              r.goodName = part.goodName ?? null;
              r.quantity = part.quantity;
              r.price = Number(part.price);
              r.amount = Number(part.amount);
            }),
          );
        }
      }
    }

    await database.batch(...operations);
  });
}

export async function pushDirtyOrders(): Promise<void> {
  const wos = database.get('work_orders');
  const dirty = (await wos.query(Q.where('is_dirty', true)).fetch()) as any[];

  for (const record of dirty) {
    try {
      await apiFetch(`/work-orders/${record.remoteId}/transition`, {
        method: 'POST',
        body: JSON.stringify({ status: record.status }),
      });
      await database.write(async () => {
        await record.update((r: any) => {
          r.isDirty = false;
        });
      });
    } catch {
      // Keep dirty — will retry on next sync
    }
  }
}

// ─── Задачі (docs/objects/task.md) ───────────────────────────────────────────

interface ApiTask {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  startAt: string | null;
  dueAt: string | null;
  completedAt: string | null;
  createdByName: string;
  workOrderId: string | null;
  workOrderNumber: string | null;
  workOrderDeleted: boolean;
  vehicleSummary: string | null;
  counterpartyName: string | null;
}
interface ApiTaskPage {
  items: ApiTask[];
  total: number;
}

/** `limit` ≤ 200 — межа `GET /tasks` (TaskListQueryDto). */
const TASK_PAGE_LIMIT = 200;
/** Запобіжник від нескінченного циклу сторінок: 10 × 200 відкритих задач одного механіка. */
const TASK_MAX_PAGES = 10;
/**
 * Виконаних тримаємо лише останні: API не має відбору за датою виконання, тож беремо
 * щойно поставлені (`createdAt desc`) — решта виконаних з планшета прибирається.
 */
const DONE_TASKS_KEEP = 50;

function taskMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function applyTaskFields(r: TaskModel, api: ApiTask, syncedAt: number) {
  r.title = api.title;
  r.description = api.description ?? null;
  r.status = api.status;
  r.priority = api.priority;
  r.startAt = taskMs(api.startAt);
  r.dueAt = taskMs(api.dueAt);
  r.completedAt = taskMs(api.completedAt);
  r.createdByName = api.createdByName ?? null;
  r.workOrderId = api.workOrderId ?? null;
  r.workOrderNumber = api.workOrderNumber ?? null;
  r.workOrderDeleted = api.workOrderDeleted === true;
  r.vehicleSummary = api.vehicleSummary ?? null;
  r.counterpartyName = api.counterpartyName ?? null;
  r.syncedAt = syncedAt;
}

/** Усі мої відкриті задачі; `complete = false` — прочитано не всі сторінки. */
async function fetchMyOpenTasks(): Promise<{ items: ApiTask[]; complete: boolean }> {
  const items: ApiTask[] = [];
  for (let page = 1; page <= TASK_MAX_PAGES; page++) {
    const res = await apiFetch<ApiTaskPage>(
      `/tasks?mine=1&status=NEW,IN_PROGRESS&sortBy=dueAt&sortDir=asc&limit=${TASK_PAGE_LIMIT}&page=${page}`,
    );
    const pageItems = res.items ?? [];
    items.push(...pageItems);
    if (pageItems.length < TASK_PAGE_LIMIT || items.length >= res.total) {
      return { items, complete: true };
    }
  }
  return { items, complete: false };
}

export type TaskPullResult =
  { status: 'ok' } | { status: 'offline' } | { status: 'error'; message: string };

/**
 * Мої задачі з сервера в локальну базу (BR-TASK-002: `mine=1` — лише ті, де я виконавець;
 * фільтрує сервер). Задача, якої у відповіді вже немає (скасована, переназначена, видалена,
 * давно виконана), прибирається локально — крім `is_dirty`: її ще треба відправити.
 * Невідправлену зміну pull не перезаписує.
 */
export async function pullTasks(): Promise<TaskPullResult> {
  let open: { items: ApiTask[]; complete: boolean };
  let done: ApiTask[];
  try {
    [open, done] = await Promise.all([
      fetchMyOpenTasks(),
      apiFetch<ApiTaskPage>(
        `/tasks?mine=1&status=DONE&sortBy=createdAt&sortDir=desc&limit=${DONE_TASKS_KEEP}`,
      ).then(res => res.items ?? []),
    ]);
  } catch (e: unknown) {
    if (isNetworkError(e)) return { status: 'offline' };
    return { status: 'error', message: e instanceof Error ? e.message : 'Помилка сервера' };
  }

  const byId = new Map<string, ApiTask>();
  for (const t of [...open.items, ...done]) byId.set(t.id, t);

  const tasks = database.get<TaskModel>('tasks');
  const existing = await tasks.query().fetch();
  const existingByRemoteId = new Map(existing.map(r => [r.remoteId, r]));
  const now = Date.now();

  await database.write(async () => {
    const operations: TaskModel[] = [];
    for (const api of byId.values()) {
      const record = existingByRemoteId.get(api.id);
      if (record) {
        // isDirty читається тут, усередині write: статус, змінений поки йшов запит, уже
        // записаний (записи WatermelonDB ідуть чергою) — його не затираємо.
        if (!record.isDirty) {
          operations.push(record.prepareUpdate(r => applyTaskFields(r, api, now)));
        }
      } else {
        operations.push(
          tasks.prepareCreate(r => {
            r.remoteId = api.id;
            r.isDirty = false;
            applyTaskFields(r, api, now);
          }),
        );
      }
    }
    // Список відкритих неповний — невідомо, чого насправді немає: нічого не прибираємо.
    if (open.complete) {
      for (const record of existing) {
        if (!byId.has(record.remoteId) && !record.isDirty) {
          operations.push(record.prepareDestroyPermanently());
        }
      }
    }
    if (operations.length > 0) await database.batch(...operations);
  });
  return { status: 'ok' };
}

export interface TaskPushRejection {
  title: string;
  message: string;
}

/** Сервер відповів, але зміну не прийняв (FSM, задачу скасовано чи переназначено). */
function isRejection(e: unknown): e is ApiError {
  return e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 401;
}

/**
 * Відправляє статуси, змінені на планшеті (`is_dirty`), через `POST /tasks/:id/transition` —
 * FSM (BR-TASK-003) перевіряє сервер. Немає мережі, 401 чи 5xx — зміна лишається до наступної
 * спроби. Сервер відхилив (4xx) — прапорець знімається, наступний pull поверне серверний стан,
 * а відмова повертається, щоб екран показав механіку причину.
 */
export async function pushDirtyTasks(): Promise<TaskPushRejection[]> {
  const tasks = database.get<TaskModel>('tasks');
  const dirty = await tasks.query(Q.where('is_dirty', true)).fetch();
  const rejected: TaskPushRejection[] = [];

  for (const record of dirty) {
    const sentStatus = record.status;
    let rejectedNow = false;
    try {
      await apiFetch(`/tasks/${record.remoteId}/transition`, {
        method: 'POST',
        body: JSON.stringify({ status: sentStatus }),
      });
    } catch (e: unknown) {
      if (!isRejection(e)) continue;
      rejectedNow = true;
      rejected.push({ title: record.title, message: e.message });
    }
    await database.write(async () => {
      // Поки йшов запит, механік міг змінити статус ще раз — нова зміна лишається брудною.
      if (record.status !== sentStatus && !rejectedNow) return;
      await record.update(r => {
        r.isDirty = false;
      });
    });
  }
  return rejected;
}

export interface TaskSyncResult {
  pull: TaskPullResult;
  rejected: TaskPushRejection[];
}

let tasksSyncInFlight: Promise<TaskSyncResult> | null = null;

/**
 * Спершу push, потім pull — щоб pull одразу показав серверний стан відхилених змін. Один
 * прогін за раз: вкладка й екран задачі можуть запустити синхронізацію одночасно, а два
 * паралельні pull створили б дублікати рядків.
 */
export function syncTasks(): Promise<TaskSyncResult> {
  if (!tasksSyncInFlight) {
    tasksSyncInFlight = (async () => {
      const rejected = await pushDirtyTasks();
      const pull = await pullTasks();
      return { pull, rejected };
    })().finally(() => {
      tasksSyncInFlight = null;
    });
  }
  return tasksSyncInFlight;
}

/**
 * Змінює статус моєї задачі на планшеті (`is_dirty`) — працює без мережі; на сервер іде через
 * `pushDirtyTasks`. Виконавцю дозволено лише NEW → IN_PROGRESS → DONE (або одразу DONE), без
 * скасування й повернення в роботу (BR-TASK-003, `canTransitionTask`).
 */
export async function queueTaskTransition(remoteId: string, to: string): Promise<void> {
  const [record] = await database
    .get<TaskModel>('tasks')
    .query(Q.where('remote_id', remoteId))
    .fetch();
  if (!record) throw new Error('Задачу не знайдено на планшеті — оновіть список');
  if (!canTransitionTask(record.status, to, { isManager: false, isAssignee: true })) {
    throw new Error('Такий перехід статусу недоступний');
  }
  await database.write(async () => {
    await record.update(r => {
      r.status = to;
      r.completedAt = to === 'DONE' ? Date.now() : null;
      r.isDirty = true;
    });
  });
}
