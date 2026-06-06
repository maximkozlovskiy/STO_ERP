// ─── Shared Calendar Types ───────────────────────────────────────────────────

export interface CalendarSlot {
  id: string;
  liftId?: string | null;
  employeeId?: string | null;
  workOrderId?: string | null;
  vehicleId?: string | null;
  counterpartyId?: string | null;
  startAt: string;
  endAt: string;
  notes?: string | null;
  workOrderNumber?: string;
  counterpartyName?: string;
  cpPhone?: string | null;
  vehicleSummary?: string | null;
  vehiclePlate?: string | null;
}

export interface Lift {
  id: string;
  name: string;
}

export interface WorkOrderOption {
  id: string;
  number: string;
  counterpartyName?: string;
  counterpartyId?: string | null;
  slotStartAt?: string | null;
  slotEndAt?: string | null;
  slotLiftName?: string | null;
}

export interface CounterpartyOption {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  companyName?: string | null;
  phone?: string | null;
}

export interface VehicleOption {
  id: string;
  make: string;
  model: string;
  licensePlate: string;
}

/** Pending (not yet saved) slot drawn on the grid */
export interface PendingSlot {
  liftId: string;
  startH: number;
  endH: number;
}

/** Ghost while actively drawing (finger still down) */
export interface GhostSlot {
  liftId: string;
  startH: number;
  endH: number;
}

/** Resize state for dragging slot edges */
export interface ResizeState {
  slotId: string;
  edge: 'start' | 'end';
  origStartH: number;
  origEndH: number;
  pointerStartX: number;
  liftId: string | null;
}

/** Resize state for pending slot edges */
export interface PendingResizeState {
  edge: 'start' | 'end';
  origStartH: number;
  origEndH: number;
  pointerStartX: number;
}

export type CalView = 'day' | 'month' | 'stats';
export type StatsPeriod = 'day' | 'month' | 'custom';
export type MonthSlots = Record<string, { total: number; byLift: Record<string, number> }>;

export interface SlotForm {
  liftId: string;
  employeeId: string;
  counterpartyId: string;
  counterpartyDisplay: string;
  vehicleId: string;
  workOrderId: string;
  workOrderDisplay: string;
  startAt: string;
  endAt: string;
  notes: string;
  normoHours: string;
}
