import type { CalendarSlot, Lift, MonthEntry, MonthSlots, SlotType } from './calendar.types';
import {
  SLOT_CATEGORIES,
  SLOT_TYPES,
  slotCategory,
  slotType,
  type SlotCategory,
} from './calendar-categories';
import { countsAsLoad } from './calendar-month';
import { taskTone, type CalendarTask, type TaskTone } from './calendar-tasks';

/** Рядок таблиці «Підйомники за типами»; `liftId` = null — записи без підйомника. */
export interface LiftSummaryRow {
  liftId: string | null;
  name: string;
  byType: Record<SlotType, number>;
  total: number;
  hours: number;
  /** Завантаження поста, %; для рядка без підйомника — null. */
  loadPct: number | null;
}

/** Рядок таблиці «Механіки»; `employeeId` = null — записи без механіка. */
export interface MechanicSummaryRow {
  employeeId: string | null;
  name: string;
  records: number;
  hours: number;
  workOrders: number;
}

export const TASK_TONES: readonly TaskTone[] = ['open', 'overdue', 'done', 'cancelled'];

export interface MonthSummary {
  records: number;
  /** Години, що займають пост (`countsAsLoad`: без скасованих і видалених нарядів). */
  busyHours: number;
  workOrders: number;
  /** Середнє завантаження постів, %; null — немає підйомників або робочого вікна. */
  avgLoadPct: number | null;
  lifts: LiftSummaryRow[];
  liftsTotal: Omit<LiftSummaryRow, 'liftId' | 'name'>;
  mechanics: MechanicSummaryRow[];
  categories: Record<SlotCategory, number>;
  tasks: Record<TaskTone, number>;
}

interface Options {
  /** Дні місяця (ключі `monthSlots` поза довантаженим 1-м числом наступного місяця). */
  days: readonly string[];
  windowStart: number;
  windowEnd: number;
  nowMs: number;
}

const emptyByType = (): Record<SlotType, number> =>
  Object.fromEntries(SLOT_TYPES.map(t => [t, 0])) as Record<SlotType, number>;

const hoursOf = (s: CalendarSlot) =>
  (new Date(s.endAt).getTime() - new Date(s.startAt).getTime()) / 3_600_000;

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Підсумки виду «Місяць» (BR-CAL-013) з уже завантажених записів місяця. Запис через північ
 * лежить у клітинках обох діб — рахується один раз (за `slot.id`). Години й завантаження — лише
 * записи, що займають пост (`countsAsLoad`), як колір клітинки й «N год з M» у «Дні».
 * Завантаження — як у вкладці «Статистика»: години / (робоче вікно × дні × підйомники).
 */
export function buildMonthSummary(
  monthSlots: MonthSlots,
  lifts: readonly Lift[],
  tasks: readonly CalendarTask[],
  { days, windowStart, windowEnd, nowMs }: Options,
): MonthSummary {
  const unique = new Map<string, MonthEntry>();
  for (const d of days)
    for (const e of monthSlots[d]?.entries ?? [])
      if (!unique.has(e.slot.id)) unique.set(e.slot.id, e);

  const liftRows = new Map<string | null, LiftSummaryRow>(
    lifts.map(l => [
      l.id,
      { liftId: l.id, name: l.name, byType: emptyByType(), total: 0, hours: 0, loadPct: 0 },
    ]),
  );
  const mechanics = new Map<string | null, MechanicSummaryRow & { wo: Set<string> }>();
  const categories = Object.fromEntries(SLOT_CATEGORIES.map(c => [c, 0])) as Record<
    SlotCategory,
    number
  >;
  const workOrders = new Set<string>();
  let busyHours = 0;

  for (const entry of unique.values()) {
    const s = entry.slot;
    const busy = countsAsLoad(s) ? hoursOf(s) : 0;
    busyHours += busy;
    if (s.workOrderId) workOrders.add(s.workOrderId);
    categories[slotCategory(entry, nowMs)] += 1;

    const liftKey = s.liftId && liftRows.has(s.liftId) ? s.liftId : null;
    let lr = liftRows.get(liftKey);
    if (!lr) {
      lr = { liftId: null, name: '', byType: emptyByType(), total: 0, hours: 0, loadPct: null };
      liftRows.set(null, lr);
    }
    lr.byType[slotType(s.type)] += 1;
    lr.total += 1;
    lr.hours += busy;

    const empKey = s.employeeId ?? null;
    let mr = mechanics.get(empKey);
    if (!mr) {
      mr = {
        employeeId: empKey,
        name: empKey ? (s.employeeName ?? '') : '',
        records: 0,
        hours: 0,
        workOrders: 0,
        wo: new Set(),
      };
      mechanics.set(empKey, mr);
    }
    if (!mr.name && s.employeeName) mr.name = s.employeeName;
    mr.records += 1;
    mr.hours += busy;
    if (s.workOrderId) mr.wo.add(s.workOrderId);
  }

  const capacity = Math.max(0, windowEnd - windowStart) * days.length;
  // Сума й середнє — із сирих годин: сума округлених рядків розходилась би з KPI «Годин на постах».
  const liftHours = [...liftRows.values()]
    .filter(r => r.liftId)
    .reduce((acc, r) => acc + r.hours, 0);
  const liftList = [...liftRows.values()].map(r => ({
    ...r,
    hours: round1(r.hours),
    loadPct: r.liftId && capacity > 0 ? Math.round((r.hours / capacity) * 100) : r.loadPct,
  }));
  // Рядок «без підйомника» — останнім.
  liftList.sort((a, b) => Number(a.liftId === null) - Number(b.liftId === null));

  const liftsTotal = { byType: emptyByType(), total: 0, hours: 0, loadPct: null as number | null };
  for (const r of liftList) {
    for (const t of SLOT_TYPES) liftsTotal.byType[t] += r.byType[t];
    liftsTotal.total += r.total;
  }
  liftsTotal.hours = round1(busyHours);

  const avgLoadPct =
    lifts.length > 0 && capacity > 0
      ? Math.round((liftHours / (capacity * lifts.length)) * 100)
      : null;
  liftsTotal.loadPct = avgLoadPct;

  const mechanicList = [...mechanics.values()]
    .map(({ wo, ...m }) => ({ ...m, hours: round1(m.hours), workOrders: wo.size }))
    .sort(
      (a, b) =>
        Number(a.employeeId === null) - Number(b.employeeId === null) ||
        b.hours - a.hours ||
        a.name.localeCompare(b.name, 'uk'),
    );

  const taskCounts: Record<TaskTone, number> = { open: 0, overdue: 0, done: 0, cancelled: 0 };
  for (const task of tasks) taskCounts[taskTone(task)] += 1;

  return {
    records: unique.size,
    busyHours: round1(busyHours),
    workOrders: workOrders.size,
    avgLoadPct,
    lifts: liftList,
    liftsTotal,
    mechanics: mechanicList,
    categories,
    tasks: taskCounts,
  };
}
