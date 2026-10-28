// ─── Shared Calendar Types ───────────────────────────────────────────────────

export interface CalendarSlot {
  id: string;
  liftId?: string | null;
  employeeId?: string | null;
  workOrderId?: string | null;
  vehicleId?: string | null;
  counterpartyId?: string | null;
  parentSlotId?: string | null;
  startAt: string;
  endAt: string;
  notes?: string | null;
  /** AVAILABLE/BOOKED/BLOCKED — UI наразі створює лише BOOKED (WO-прив'язані) слоти. */
  status?: string;
  /** WORK/MAINTENANCE/BREAK/MEETING (BR-CAL-003); без значення — «Робота». */
  type?: string;
  workOrderNumber?: string;
  workOrderStatus?: string | null;
  counterpartyName?: string;
  cpPhone?: string | null;
  vehicleSummary?: string | null;
  vehiclePlate?: string | null;
  /** Механік запису «Прізвище Ім'я»; `null` — не призначено, звільнений чи видалений (BR-CAL-011). */
  employeeName?: string | null;
  /** Наряд запису видалено — завантаження поста запис не рахує (BR-CAL-011). */
  workOrderDeleted?: boolean;
}

/**
 * Механік і підйомник запису, що редагується, на момент відкриття форми (BR-CAL-012): механіка,
 * якого вже не можна обрати, форма показує недоступною опцією, доки його не змінять.
 */
export interface SavedMechanic {
  liftId: string;
  employeeId: string;
  /** `null` — механіка не призначено, або він звільнений чи видалений (BR-CAL-011). */
  employeeName: string | null;
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
  licensePlate: string | null;
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
  /** Наряд запису: нові межі запису наряду змінюють його дати (BR-WO-024). */
  workOrderId: string | null;
}

/** Resize state for pending slot edges */
export interface PendingResizeState {
  edge: 'start' | 'end';
  origStartH: number;
  origEndH: number;
  pointerStartX: number;
}

/** Pending online booking displayed on the calendar grid (read-only) */
export interface BookingSlot {
  id: string;
  liftId: string; // first free lift assigned client-side
  clientName: string;
  clientPhone: string;
  startAt: string;
  endAt: string;
}

export type CalView = 'day' | 'month' | 'stats';

/**
 * Режим виду «День» (BR-CAL-014): `lifts` — планувальник (рядки — підйомники, колонки — години,
 * типовий), `hours` — повернута сітка (рядки — години, колонки — підйомники), `list` — список записів.
 */
export type DayLayout = 'lifts' | 'hours' | 'list';
export type StatsPeriod = 'day' | 'month' | 'custom';
/** Мінімум даних запису, потрібний для категорії (BR-CAL-008). */
export interface CategoryInput {
  /** Кінець ЛАНЦЮЖКА багатоденного запису (`parentSlotId ?? id`), не лише цієї частини. */
  endMs: number;
  workOrderStatus: string | null;
}

/** Запис дня у виді «Місяць»: сам слот (для картки, BR-CAL-009) і дані категорії. */
export interface MonthEntry extends CategoryInput {
  slot: CalendarSlot;
}

export type MonthSlots = Record<
  string,
  {
    /** Усі записи дня — підказка клітинки й лічильники (BR-CAL-008). */
    total: number;
    /** Записи, що займають пост (без скасованих і видалених нарядів) — колір завантаженості. */
    busy: number;
    byLift: Record<string, number>;
    entries: MonthEntry[];
  }
>;

/**
 * Тип запису календаря (BR-CAL-003): «Робота» або службовий — обслуговування, перерва, нарада
 * (без клієнта, авто й наряду). Перелік і іконки — `calendar-categories.ts` (`SLOT_TYPES`).
 */
export type SlotType = 'WORK' | 'MAINTENANCE' | 'BREAK' | 'MEETING';

export interface SlotForm {
  /** Тип запису: обирається лише в новому записі, далі не змінюється (BR-CAL-003). */
  type: SlotType;
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
