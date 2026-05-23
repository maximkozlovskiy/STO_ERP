import { Q } from '@nozbe/watermelondb';
import { database } from './database';
import { apiFetch } from './api';

interface ApiWorkOrder {
  id: string; orgId: string; number: string; status: string;
  vehicleSummary?: string; counterpartyName?: string;
  description?: string | null; inMileage?: number | null; outMileage?: number | null;
  plannedAt?: string | null; completedAt?: string | null;
  totalLabor: number; totalParts: number; totalAmount: number; paidAmount: number;
  lines: ApiWorkOrderLine[];
  parts: ApiWorkOrderPart[];
}
interface ApiWorkOrderLine {
  id: string; workName?: string; employeeName?: string;
  normoHours: number; price: number; amount: number; notes?: string | null;
}
interface ApiWorkOrderPart {
  id: string; goodName?: string; quantity: number; price: number; amount: number;
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
  r.totalAmount = Number(api.totalAmount);
  r.paidAmount = Number(api.paidAmount);
  r.syncedAt = syncedAt;
}

export async function syncWorkOrders(): Promise<void> {
  let items: ApiWorkOrder[] = [];

  try {
    const res = await apiFetch<{ items: ApiWorkOrder[] }>('/work-orders?limit=100&include=lines,parts');
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
        if (!(existing as any).isDirty) {
          operations.push(
            (existing as any).prepareUpdate((r: any) => applyWorkOrderFields(r, api, now)),
          );
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
  const dirty = await wos.query(Q.where('is_dirty', true)).fetch() as any[];

  for (const record of dirty) {
    try {
      await apiFetch(`/work-orders/${record.remoteId}/transition`, {
        method: 'POST',
        body: JSON.stringify({ status: record.status }),
      });
      await database.write(async () => {
        await record.update((r: any) => { r.isDirty = false; });
      });
    } catch {
      // Keep dirty — will retry on next sync
    }
  }
}
