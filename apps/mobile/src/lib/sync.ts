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

  await database.write(async () => {
    for (const api of items) {
      const existing = await wos.query().where('remote_id', api.id).fetch();
      const now = Date.now();

      if (existing.length > 0) {
        const record = existing[0] as any;
        if (!record.isDirty) {
          await record.update((r: any) => {
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
            r.syncedAt = now;
          });
        }
      } else {
        await wos.create((r: any) => {
          r.remoteId = api.id;
          r.orgId = api.orgId;
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
          r.syncedAt = now;
          r.isDirty = false;
        });
      }

      // Sync lines
      const existingLines = await lines.query().where('work_order_id', api.id).fetch();
      const existingLineIds = new Set(existingLines.map((l: any) => l.remoteId));
      for (const line of api.lines ?? []) {
        if (!existingLineIds.has(line.id)) {
          await lines.create((r: any) => {
            r.remoteId = line.id;
            r.workOrderId = api.id;
            r.workName = line.workName ?? null;
            r.employeeName = line.employeeName ?? null;
            r.normoHours = line.normoHours;
            r.price = Number(line.price);
            r.amount = Number(line.amount);
            r.notes = line.notes ?? null;
          });
        }
      }

      // Sync parts
      const existingParts = await parts.query().where('work_order_id', api.id).fetch();
      const existingPartIds = new Set(existingParts.map((p: any) => p.remoteId));
      for (const part of api.parts ?? []) {
        if (!existingPartIds.has(part.id)) {
          await parts.create((r: any) => {
            r.remoteId = part.id;
            r.workOrderId = api.id;
            r.goodName = part.goodName ?? null;
            r.quantity = part.quantity;
            r.price = Number(part.price);
            r.amount = Number(part.amount);
          });
        }
      }
    }
  });
}

export async function pushDirtyOrders(): Promise<void> {
  const wos = database.get('work_orders');
  const dirty = await wos.query().where('is_dirty', true).fetch() as any[];

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
