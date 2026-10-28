'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';

import { apiFetch } from '@/lib/api-client';
import { getCached, setCache } from '@/lib/ref-cache';
import { notifyCalendarChanged, onCalendarChanged } from '@/lib/calendar-events';
import { toast } from '@/lib/toast';
import { workOrdersKeys } from '@/hooks/api/useWorkOrders';
import { useConfirm } from '@/hooks/useConfirm';
import { useBranchWorkHours } from '@/hooks/useBranchWorkHours';
import { useTranslation } from 'react-i18next';

import type {
  BookingSlot,
  CalView,
  DayLayout,
  CalendarSlot,
  GhostSlot,
  Lift,
  MonthSlots,
  PendingResizeState,
  PendingSlot,
  ResizeState,
  SavedMechanic,
  SlotForm,
  StatsPeriod,
} from './calendar.types';
import {
  KYIV_HOUR_FMT,
  SIDEBAR_W,
  STATS_MAX_DAYS,
  decimalHoursToHHMM,
  decimalHoursToISO,
  kyivHours,
  snapTo15,
  nextDateString,
  toDateString,
} from './calendar.utils';
import { buildMonthSlots, chainEnds, liveSlots, slotsByKyivDay } from './calendar-month';
import { slotType } from './calendar-categories';
import {
  nowLinePercent,
  pastPercent,
  slotDeleteConfirmOptions,
  workOrderDeleteLock,
  workOrderTimeLock,
} from './calendar-day';
import { mechanicDroppedText, type MechanicDropResponse } from './calendar-mechanic-drop';

// Shared drag-id for the pending-slot block (used both by the draggable in JSX
// and by handleDragEnd to dispatch logic). Exported so sub-components can use it.
export const PENDING_DRAG_ID = '__pending__';

/** Ключ останнього режиму «Дня» у `localStorage` (BR-CAL-014). */
export const DAY_LAYOUT_KEY = 'sto_calendar_day_layout';
const DAY_LAYOUTS: ReadonlySet<string> = new Set<DayLayout>(['lifts', 'hours', 'list']);
const isDayLayout = (v: string | null): v is DayLayout => v !== null && DAY_LAYOUTS.has(v);

function readStoredDayLayout(): DayLayout | null {
  try {
    const v = localStorage.getItem(DAY_LAYOUT_KEY);
    return isDayLayout(v) ? v : null;
  } catch {
    return null;
  }
}

// Module-level constant — stable ref avoids re-creation on every render.
export const EMPTY_FORM: SlotForm = {
  type: 'WORK',
  liftId: '',
  employeeId: '',
  counterpartyId: '',
  counterpartyDisplay: '',
  vehicleId: '',
  workOrderId: '',
  workOrderDisplay: '',
  startAt: '',
  endAt: '',
  notes: '',
  normoHours: '',
};

/**
 * Запис, відкритий у формі, на момент відкриття (чи останньої звірки з сервером): механік і
 * підйомник — для недоступної опції збереженого механіка (BR-CAL-012), час — щоб помітити, що
 * наряд переніс запис поверх форми (Bug #884); наряд — щоб відкріплення чи видалення запису
 * наряду теж скидало кеш нарядів (Bug #904); номер і статус наряду — чи можна змінити час і
 * підйомник (BR-WO-027) і текст підтвердження видалення (BR-WO-026).
 */
type EditingSaved = {
  id: string;
  startAt: string;
  endAt: string;
  workOrderId: string | null;
  workOrderNumber: string | null;
  workOrderStatus: string | null;
} & SavedMechanic;

function savedOf(slot: CalendarSlot): EditingSaved {
  return {
    id: slot.id,
    startAt: slot.startAt,
    endAt: slot.endAt,
    workOrderId: slot.workOrderId ?? null,
    workOrderNumber: slot.workOrderNumber ?? null,
    workOrderStatus: slot.workOrderStatus ?? null,
    liftId: slot.liftId ?? '',
    employeeId: slot.employeeId ?? '',
    employeeName: slot.employeeName ?? null,
  };
}

/** Форма запису з його збережених полів (час — київський «HH:mm» дня запису). */
function slotToForm(slot: CalendarSlot): SlotForm {
  const counterpartyDisplay = slot.counterpartyName ?? '';
  const startH = kyivHours(slot.startAt);
  const endH = kyivHours(slot.endAt);
  return {
    type: slotType(slot.type),
    liftId: slot.liftId ?? '',
    employeeId: slot.employeeId ?? '',
    counterpartyId: slot.counterpartyId ?? '',
    counterpartyDisplay,
    vehicleId: slot.vehicleId ?? '',
    workOrderId: slot.workOrderId ?? '',
    workOrderDisplay: slot.workOrderNumber
      ? `${slot.workOrderNumber}${slot.counterpartyName ? ` · ${slot.counterpartyName}` : ''}`
      : '',
    startAt: decimalHoursToHHMM(startH),
    endAt: decimalHoursToHHMM(endH),
    normoHours: String(+(endH - startH).toFixed(2)),
    notes: slot.notes ?? '',
  };
}

/**
 * useCalendarState — encapsulates all state, refs, side-effects and handlers
 * for the calendar day-view (drag/drop, resize, draw, pending slot, fetch slots/lifts,
 * month/stats data, form animation). page.tsx remains a thin render layer.
 */
export type CalendarState = ReturnType<typeof useCalendarState>;

interface UseCalendarStateOptions {
  /**
   * Чи може користувач створювати й змінювати записи (`canManageCalendarSlots`). Ні —
   * перетягування, зміна меж і «Новий запис» нічого не роблять: API відповів би 403 (Bug #871).
   */
  canManageSlots?: boolean;
}

export function useCalendarState({ canManageSlots = true }: UseCalendarStateOptions = {}) {
  // i18n тут потрібен, бо хук сам показує toast-и (переміщення слотів, видалення) —
  // раніше вони були жорстко українськими рядками, попри двомовний UI.
  const { t } = useTranslation('calendar');
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  // Запис наряду змінено чи видалено — картка, списки й лічильники нарядів (BR-WO-024, BR-WO-026).
  const invalidateWorkOrders = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: workOrdersKeys.all });
  }, [queryClient]);
  const { confirm, dialogProps } = useConfirm();

  // URL-persistent view — back/forward and bookmarks work correctly
  const calView = (searchParams.get('view') ?? 'day') as CalView;
  const setCalView = useCallback(
    (v: CalView) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set('view', v);
      router.replace(`?${params.toString()}`, { scroll: false });
    },
    [router, searchParams],
  );

  // Режим «Дня» (BR-CAL-014): адреса `?layout=` > останній вибір у браузері > планувальник.
  const urlLayout = searchParams.get('layout');
  const [storedLayout, setStoredLayout] = useState<DayLayout | null>(readStoredDayLayout);
  const dayLayout: DayLayout = isDayLayout(urlLayout) ? urlLayout : (storedLayout ?? 'lifts');
  const setDayLayout = useCallback(
    (l: DayLayout) => {
      const params = new URLSearchParams(searchParams.toString());
      if (l === 'lifts') params.delete('layout');
      else params.set('layout', l);
      router.replace(`?${params.toString()}`, { scroll: false });
      setStoredLayout(l);
      try {
        localStorage.setItem(DAY_LAYOUT_KEY, l);
      } catch {
        // Приватне вікно чи заблоковане сховище — режим лишається в адресі.
      }
    },
    [router, searchParams],
  );

  // URL-persistent date — ?date=2026-06-01; defaults to today on first visit
  const urlDate = searchParams.get('date') ?? '';
  const [date, setDateState] = useState(urlDate);
  const setDate = useCallback(
    (d: string) => {
      setDateState(d);
      const params = new URLSearchParams(searchParams.toString());
      params.set('date', d);
      router.replace(`?${params.toString()}`, { scroll: false });
    },
    [router, searchParams],
  );

  /**
   * Вид «День» на дату — ОДНИМ `router.replace`. Пара `setDate(d)` + `setCalView('day')` давала
   * два replace від того самого `searchParams`, і другий повертав у URL стару дату: сторінка
   * показувала обраний день, а оновлення сторінки — інший.
   */
  const openDay = useCallback(
    (d: string) => {
      setDateState(d);
      const params = new URLSearchParams(searchParams.toString());
      params.set('date', d);
      params.set('view', 'day');
      router.replace(`?${params.toString()}`, { scroll: false });
    },
    [router, searchParams],
  );

  const [slots, setSlots] = useState<CalendarSlot[]>([]);
  // Записи наступного дня — лише щоб знати кінець ланцюжка багатоденного запису для
  // «прострочено» в рядку лічильників виду «День» (BR-CAL-008). Не показуються.
  const [nextDaySlots, setNextDaySlots] = useState<CalendarSlot[]>([]);
  const [bookingSlots, setBookingSlots] = useState<BookingSlot[]>([]);
  const [loading, setLoading] = useState(true);
  const [lifts, setLifts] = useState<Lift[]>([]);
  // Години основної філії (`GET /settings/work-hours`); до відповіді й при її збої — типові
  // 09–18, як на сервері (`DEFAULT_WORK_HOURS`): форма запису ділить запис на дні за цими ж
  // межами (BR-CAL-007).
  const { startHour: workStartHour, endHour: workEndHour } = useBranchWorkHours(null, {
    mainBranch: true,
  });
  // Ref so `load` useCallback can read current lifts without adding them as dependency
  const liftsRef = useRef<Lift[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [formMounted, setFormMounted] = useState(false);
  const [formVisible, setFormVisible] = useState(false);
  const formHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const formCollapseRef = useRef<HTMLDivElement>(null);
  const formInnerRef = useRef<HTMLDivElement>(null);
  const [editingSlotId, setEditingSlotId] = useState<string | null>(null);

  const [monthSlots, setMonthSlots] = useState<MonthSlots>({});
  const [monthLoading, setMonthLoading] = useState(false);
  const [monthError, setMonthError] = useState(false);
  // Запис, відкритий карткою виду «Місяць» (BR-CAL-009): денного списку `slots` у цьому виді
  // немає, тож «минулий» рахується від самого слота.
  const [monthEditSlot, setMonthEditSlot] = useState<CalendarSlot | null>(null);
  // Запис у формі на момент відкриття (`savedOf`): збережений механік, якого вже не можна обрати,
  // форма показує недоступною опцією, доки його не змінять (BR-CAL-012). Прапорець — «наряд
  // змінено поверх форми» (Bug #884): збереження картки наряду переносить його запис на сервері
  // (BR-WO-020), і форма звіряється з перечитаним видом — інакше «Оновити» повернув би запис на
  // старий час.
  const [editingSaved, setEditingSaved] = useState<EditingSaved>();
  const resyncEditRef = useRef(false);

  const [statsPeriod, setStatsPeriod] = useState<StatsPeriod>('day');
  const [statsFrom, setStatsFrom] = useState('');
  const [statsTo, setStatsTo] = useState('');
  const [statsSlots, setStatsSlots] = useState<CalendarSlot[]>([]);
  const [statsLoading, setStatsLoading] = useState(false);
  const [statsError, setStatsError] = useState(false);

  const [form, setForm] = useState<SlotForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [cpDisplay, setCpDisplay] = useState('');

  const [nowMs, setNowMs] = useState(0);
  useEffect(() => {
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const minHour = useMemo(() => {
    if (!date || !nowMs) return workStartHour;
    const todayKyiv = toDateString(new Date(nowMs));
    if (date !== todayKyiv) return workStartHour;
    const parts = KYIV_HOUR_FMT.formatToParts(new Date(nowMs));
    return parseInt(parts.find(p => p.type === 'hour')?.value ?? String(workStartHour), 10);
  }, [date, nowMs, workStartHour]);

  const dynHours = useMemo(
    () => Array.from({ length: workEndHour - workStartHour }, (_, i) => i + workStartHour),
    [workStartHour, workEndHour],
  );
  const dynWindowStart = workStartHour;
  const dynWindowEnd = workEndHour;
  const dynTotalHours = dynHours.length;

  const [ghost, setGhost] = useState<GhostSlot | null>(null);
  const drawingRef = useRef<{ liftId: string; startH: number } | null>(null);

  const [pendingSlot, setPendingSlot] = useState<PendingSlot | null>(null);
  const pendingSlotRef = useRef<PendingSlot | null>(null);
  pendingSlotRef.current = pendingSlot;

  const [resizing, setResizing] = useState<ResizeState | null>(null);
  const [resizePreview, setResizePreview] = useState<{
    id: string;
    startH: number;
    endH: number;
  } | null>(null);

  const [pendingResizing, setPendingResizing] = useState<PendingResizeState | null>(null);
  const pendingResizingRef = useRef<PendingResizeState | null>(null);
  pendingResizingRef.current = pendingResizing;

  const timelineRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const formCloseRafRef = useRef<number | null>(null);

  useEffect(() => {
    if (formHideTimerRef.current) clearTimeout(formHideTimerRef.current);
    if (formCloseRafRef.current !== null) {
      cancelAnimationFrame(formCloseRafRef.current);
      formCloseRafRef.current = null;
    }
    if (showAdd) {
      setFormMounted(true);
      requestAnimationFrame(() => requestAnimationFrame(() => setFormVisible(true)));
    } else {
      const outer = formCollapseRef.current;
      if (outer) {
        outer.style.height = `${outer.scrollHeight}px`;
        formCloseRafRef.current = requestAnimationFrame(() => {
          formCloseRafRef.current = null;
          if (formCollapseRef.current) {
            formCollapseRef.current.style.transition =
              'height 320ms cubic-bezier(0.4,0,0.6,1), margin-bottom 320ms cubic-bezier(0.4,0,0.6,1)';
            formCollapseRef.current.style.height = '0px';
            formCollapseRef.current.style.marginBottom = '0px';
          }
        });
      }
      setFormVisible(false);
      formHideTimerRef.current = setTimeout(() => setFormMounted(false), 420);
    }
  }, [showAdd]);

  useEffect(
    () => () => {
      if (formHideTimerRef.current) {
        clearTimeout(formHideTimerRef.current);
        formHideTimerRef.current = null;
      }
      if (formCloseRafRef.current !== null) {
        cancelAnimationFrame(formCloseRafRef.current);
        formCloseRafRef.current = null;
      }
    },
    [],
  );

  // ResizeObserver: keep form collapse wrapper height in sync with actual content
  useEffect(() => {
    if (!formMounted) return;
    const inner = formInnerRef.current;
    if (!inner) return;
    const ro = new ResizeObserver(() => {
      if (!formVisible) return;
      if (formCollapseRef.current && formInnerRef.current) {
        formCollapseRef.current.style.height = `${formInnerRef.current.scrollHeight}px`;
      }
    });
    ro.observe(inner);
    return () => ro.disconnect();
  }, [formMounted, formVisible]);

  useEffect(() => {
    if (!date) setDate(toDateString(new Date()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // /lifts читає sessionStorage cache синхронно для миттєвого first-paint, потім — свіжий список.
  useEffect(() => {
    const cached = getCached<Lift[]>('cache:lifts');
    if (cached && mountedRef.current) {
      setLifts(cached);
      liftsRef.current = cached;
    }
    apiFetch<Lift[]>('/lifts').then(
      data => {
        if (!mountedRef.current) return;
        setCache('cache:lifts', data);
        setLifts(data);
        liftsRef.current = data;
      },
      (e: unknown) => {
        if (mountedRef.current && !cached)
          setError(e instanceof Error ? e.message : t('slot.errLoad'));
      },
    );
  }, [t]);

  const monthAbortRef = useRef<AbortController | null>(null);

  /**
   * `silent` — перечитування після збереження чи видалення запису: без спінера на місці сітки,
   * щоб місяць не блимав під формою, що згортається.
   */
  const loadMonth = useCallback(async (yearMonth: string, silent = false) => {
    const [y, m] = yearMonth.split('-').map(Number);
    if (!y || !m) return;
    const daysInMonth = new Date(y, m, 0).getDate();
    monthAbortRef.current?.abort();
    const ac = new AbortController();
    monthAbortRef.current = ac;
    if (!silent) setMonthLoading(true);
    if (mountedRef.current) setMonthError(false);
    try {
      const days = Array.from({ length: daysInMonth }, (_, i) => {
        const d = i + 1;
        return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      });
      // Перший день наступного місяця не показується, але продовження багатоденного запису
      // на ньому — кінець ланцюжка для «прострочено» останнього дня (BR-CAL-008).
      const next = new Date(y, m, 1);
      const nextDay = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-01`;
      // Один запит на весь місяць: запит на кожен день (32 за відкриття) впирався в ліміт API
      // 200/хв — 429 і порожні дні без жодного знаку (TECH-DEBT, календар п. 5).
      let slots: CalendarSlot[] | null = null;
      try {
        slots = liveSlots(
          await apiFetch<CalendarSlot[]>(`/calendar/slots?from=${days[0]}&to=${nextDay}`, {
            signal: ac.signal,
          }),
        );
      } catch {
        slots = null;
      }
      if (ac.signal.aborted) return;
      if (mountedRef.current) {
        setMonthSlots(
          slots ? buildMonthSlots(slotsByKyivDay(slots, [...days, nextDay]), days) : {},
        );
        setMonthError(slots === null);
      }
    } finally {
      if (mountedRef.current && !ac.signal.aborted) setMonthLoading(false);
    }
  }, []);

  const yearMonth = date ? date.slice(0, 7) : '';

  useEffect(() => {
    // `void`: loadMonth сам тримає `monthError`/`monthLoading` (їх рендерить
    // CalendarMonthView) — effect не має куди повертати проміс.
    if (calView === 'month' && yearMonth) void loadMonth(yearMonth);
  }, [calView, yearMonth, loadMonth]);

  const statsRange = useMemo((): { from: string; to: string } | null => {
    if (!date) return null;
    if (statsPeriod === 'day') return { from: date, to: date };
    if (statsPeriod === 'month') {
      const [y, m] = date.split('-').map(Number);
      const from = `${y}-${String(m).padStart(2, '0')}-01`;
      const last = new Date(y, m, 0).getDate();
      const to = `${y}-${String(m).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
      return { from, to };
    }
    if (statsPeriod === 'custom' && statsFrom && statsTo && statsFrom <= statsTo)
      return { from: statsFrom, to: statsTo };
    return null;
  }, [statsPeriod, date, statsFrom, statsTo]);

  const statsAbortRef = useRef<AbortController | null>(null);

  const loadStats = useCallback(async (from: string, to: string) => {
    statsAbortRef.current?.abort();
    const ac = new AbortController();
    statsAbortRef.current = ac;
    setStatsLoading(true);
    if (mountedRef.current) setStatsError(false);
    try {
      const days: string[] = [];
      const cur = new Date(from + 'T12:00:00');
      const end = new Date(to + 'T12:00:00');
      while (cur <= end && days.length < STATS_MAX_DAYS) {
        days.push(toDateString(cur));
        cur.setDate(cur.getDate() + 1);
      }
      // Один запит на період (як «Місяць»): ще й без дублів — запис через північ раніше
      // приходив у відповідях обох днів і рахувався двічі.
      let slots: CalendarSlot[] | null = null;
      if (days.length > 0) {
        try {
          slots = await apiFetch<CalendarSlot[]>(
            `/calendar/slots?from=${days[0]}&to=${days[days.length - 1]}`,
            { signal: ac.signal },
          );
        } catch {
          slots = null;
        }
      }
      if (ac.signal.aborted) return;
      if (mountedRef.current) {
        setStatsSlots(liveSlots(slots ?? []));
        setStatsError(days.length > 0 && slots === null);
      }
    } finally {
      if (mountedRef.current && !ac.signal.aborted) setStatsLoading(false);
    }
  }, []);

  const statsRangeTooLong = useMemo(() => {
    if (statsPeriod !== 'custom' || !statsFrom || !statsTo || statsFrom > statsTo) return false;
    const cur = new Date(statsFrom + 'T12:00:00');
    const end = new Date(statsTo + 'T12:00:00');
    let n = 0;
    while (cur <= end) {
      n++;
      cur.setDate(cur.getDate() + 1);
      if (n > STATS_MAX_DAYS) return true;
    }
    return false;
  }, [statsPeriod, statsFrom, statsTo]);

  useEffect(() => {
    if (calView === 'stats' && statsRange) void loadStats(statsRange.from, statsRange.to);
  }, [calView, statsRange, loadStats]);

  // Номер останнього запиту дня: відповідь попереднього дня, що прийшла пізніше (швидке
  // «‹ ›»), не перезаписує записи нового дня. Запит дня — три виклики, найповільніший вирішує.
  const loadReqRef = useRef(0);

  const load = useCallback(() => {
    if (!date) return;
    const req = ++loadReqRef.current;
    const isStale = () => !mountedRef.current || req !== loadReqRef.current;
    setLoading(true);
    Promise.all([
      apiFetch<CalendarSlot[]>(`/calendar/slots?date=${date}`),
      // Збій довантаження наступного дня не ламає день — лише «прострочено» рахується
      // за власним кінцем частини.
      apiFetch<CalendarSlot[]>(`/calendar/slots?date=${nextDateString(date)}`).catch(
        () => [] as CalendarSlot[],
      ),
      apiFetch<{
        items: Array<{
          id: string;
          clientName: string;
          clientPhone: string;
          requestedDate: string;
        }>;
      }>(`/booking?date=${date}&status=PENDING`).catch(() => ({
        items: [] as Array<{
          id: string;
          clientName: string;
          clientPhone: string;
          requestedDate: string;
        }>,
      })),
    ])
      .then(([rawSlots, nextSlots, bookingRes]) => {
        if (isStale()) return;
        const calSlots = liveSlots(rawSlots);
        setSlots(calSlots);
        setNextDaySlots(liveSlots(nextSlots));
        // Assign each PENDING booking to the first lift that has no CalendarSlot conflict.
        // lifts state may not be populated yet on first load — read from the ref captured below.
        const currentLifts = liftsRef.current;
        const slotDurationMs = 60 * 60 * 1000; // 1h default slot

        // sto-optimize: pre-bucket calSlots by liftId + pre-parse Date once.
        // Раніше: O(bookings × lifts × calSlots) з `new Date()` allocation на кожній
        // ітерації; для 10 booking × 5 lifts × 50 slots = 2500 allocations. Тепер:
        // (1) Map<liftId, ParsedSlot[]> будуємо один раз → O(C) startup
        // (2) Числове порівняння замість Date object construction.
        const slotsByLiftLocal = new Map<string, { startMs: number; endMs: number }[]>();
        for (const s of calSlots) {
          if (!s.liftId) continue;
          const parsed = {
            startMs: new Date(s.startAt).getTime(),
            endMs: new Date(s.endAt).getTime(),
          };
          const arr = slotsByLiftLocal.get(s.liftId);
          if (arr) arr.push(parsed);
          else slotsByLiftLocal.set(s.liftId, [parsed]);
        }

        const assigned: BookingSlot[] = [];
        for (const b of bookingRes.items) {
          const startMs = new Date(b.requestedDate).getTime();
          const endMs = startMs + slotDurationMs;
          const freeLift = currentLifts.find(lift => {
            const busy = slotsByLiftLocal.get(lift.id);
            if (!busy) return true;
            for (const p of busy) {
              if (p.startMs < endMs && p.endMs > startMs) return false;
            }
            return true;
          });
          if (freeLift) {
            assigned.push({
              id: b.id,
              liftId: freeLift.id,
              clientName: b.clientName,
              clientPhone: b.clientPhone,
              startAt: new Date(startMs).toISOString(),
              endAt: new Date(endMs).toISOString(),
            });
          }
        }
        setBookingSlots(assigned);
      })
      .catch((e: unknown) => {
        if (!isStale()) setError(e instanceof Error ? e.message : t('slot.errLoad'));
      })
      .finally(() => {
        if (!isStale()) setLoading(false);
      });
  }, [date, t]);

  // Skip day-view fetch when user is in stats/month view — saves N round-trips
  // on date changes that affect only the other view's data.
  // `lifts.length` in deps because `load()` reads `liftsRef.current` in `.then()`
  // for matching PENDING bookings to a free lift. If /lifts returns AFTER
  // /booking + /calendar/slots (cold cache, slow network),
  // `liftsRef.current === []` → `freeLift = undefined` для всіх бронювань →
  // `bookingSlots` порожній до явної ре-навігації. Додавання `lifts.length` гарантує
  // що ефект перевикличе load() коли lifts стейт вперше населений.
  useEffect(() => {
    if (calView === 'day') load();
  }, [load, calView, lifts.length]);

  const prevDay = useCallback(() => {
    const d = new Date(date);
    d.setDate(d.getDate() - 1);
    setDate(toDateString(d));
  }, [date, setDate]);

  const nextDay = useCallback(() => {
    const d = new Date(date);
    d.setDate(d.getDate() + 1);
    setDate(toDateString(d));
  }, [date, setDate]);

  const workStartHourRef = useRef(workStartHour);
  workStartHourRef.current = workStartHour;
  const dynTotalHoursRef = useRef(dynTotalHours);
  dynTotalHoursRef.current = dynTotalHours;
  const dynWindowEndRef = useRef(dynWindowEnd);
  dynWindowEndRef.current = dynWindowEnd;
  const dynWindowStartRef = useRef(dynWindowStart);
  dynWindowStartRef.current = dynWindowStart;

  const pxToDecimalHours = useCallback((clientX: number): number => {
    const rect = timelineRef.current?.getBoundingClientRect();
    if (!rect) return workStartHourRef.current;
    const timelineX = clientX - rect.left - SIDEBAR_W;
    const timelineW = rect.width - SIDEBAR_W;
    const raw = workStartHourRef.current + (timelineX / timelineW) * dynTotalHoursRef.current;
    return Math.max(workStartHourRef.current, Math.min(dynWindowEndRef.current - 1, raw));
  }, []);

  const showAddRef = useRef(showAdd);
  showAddRef.current = showAdd;
  const canManageRef = useRef(canManageSlots);
  canManageRef.current = canManageSlots;
  const minHourRef = useRef(minHour);
  minHourRef.current = minHour;

  // ── Open form from pending slot ───────────────────────────────────────────

  const openFormFromPending = useCallback(() => {
    const p = pendingSlotRef.current;
    if (!p) return;
    setEditingSlotId(null);
    setError('');
    setCpDisplay('');
    setForm({
      ...EMPTY_FORM,
      liftId: p.liftId,
      startAt: decimalHoursToHHMM(p.startH),
      endAt: decimalHoursToHHMM(p.endH),
      normoHours: String(+(p.endH - p.startH).toFixed(2)),
    });
    setShowAdd(true);
  }, []);

  const cancelPending = useCallback(() => {
    setPendingSlot(null);
    setEditingSlotId(null);
    setShowAdd(false);
    setError('');
  }, []);

  const handleEditSlot = useCallback((slot: CalendarSlot) => {
    // Відкрито з виду «День»: «минулий» — за правилом дня, не за знімком запису з місяця.
    // `openMonthSlot` ставить свій знімок ПІСЛЯ цього виклику.
    setMonthEditSlot(null);
    setEditingSlotId(slot.id);
    setPendingSlot(null);
    const next = slotToForm(slot);
    setCpDisplay(next.counterpartyDisplay);
    setEditingSaved(savedOf(slot));
    setForm(next);
    setShowAdd(true);
  }, []);

  // ── Resize existing saved slot ────────────────────────────────────────────

  const handleResizeStart = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>, slotId: string, edge: 'start' | 'end') => {
      e.stopPropagation();
      if (!canManageSlots) return;
      const slot = slots.find(s => s.id === slotId);
      // BR-WO-027: ручок у такого запису немає; сторож — на випадок застарілого рендера.
      if (!slot || workOrderTimeLock(slot)) return;
      setResizing({
        slotId,
        edge,
        origStartH: kyivHours(slot.startAt),
        origEndH: kyivHours(slot.endAt),
        pointerStartX: e.clientX,
        liftId: slot.liftId ?? null,
        workOrderId: slot.workOrderId ?? null,
      });
      setResizePreview({
        id: slotId,
        startH: kyivHours(slot.startAt),
        endH: kyivHours(slot.endAt),
      });
    },
    [slots, canManageSlots],
  );

  // ── Resize pending slot ───────────────────────────────────────────────────

  const handlePendingResizeStart = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>, edge: 'start' | 'end') => {
      e.stopPropagation();
      const p = pendingSlotRef.current;
      if (!p) return;
      setPendingResizing({
        edge,
        origStartH: p.startH,
        origEndH: p.endH,
        pointerStartX: e.clientX,
      });
    },
    [],
  );

  const resizingRef = useRef(resizing);
  resizingRef.current = resizing;
  const resizePreviewRef = useRef(resizePreview);
  resizePreviewRef.current = resizePreview;
  const dateRef = useRef(date);
  dateRef.current = date;

  // ── Global window listeners ───────────────────────────────────────────────

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      if (!timelineRef.current?.contains(target)) return;
      if (target.closest('[data-calendar-slot]')) return;
      if (target.closest('[data-pending-slot]')) return;
      if (showAddRef.current) {
        setPendingSlot(null);
        setShowAdd(false);
        setError('');
        return;
      }
      // generic-параметр, а не каст: closest() віддає Element, а .dataset є лише в HTMLElement.
      const liftRow = target.closest<HTMLElement>('[data-lift-id]');
      const liftId = liftRow?.dataset.liftId;
      if (!liftId || !canManageRef.current) return;
      setPendingSlot(null);
      const todayKyiv = toDateString(new Date());
      if (dateRef.current < todayKyiv) return;
      const pastClamp =
        dateRef.current === todayKyiv ? minHourRef.current : dynWindowStartRef.current;
      const startH = Math.max(snapTo15(pxToDecimalHours(e.clientX)), pastClamp);
      drawingRef.current = { liftId, startH };
      setGhost({ liftId, startH, endH: startH + 1 });
    };

    const onMove = (e: PointerEvent) => {
      if (drawingRef.current) {
        const curH = pxToDecimalHours(e.clientX);
        const { startH } = drawingRef.current;
        const endH = snapTo15(Math.max(curH, startH + 0.25));
        setGhost(g => (g ? { ...g, endH } : null));
        return;
      }
      const pr = pendingResizingRef.current;
      if (pr) {
        const rect = timelineRef.current?.getBoundingClientRect();
        if (!rect) return;
        // Inline px→decimal-hours: pxToHours helper removed because it used hardcoded TOTAL_HOURS=12.
        const deltaH =
          ((e.clientX - pr.pointerStartX) / (rect.width - SIDEBAR_W)) * dynTotalHoursRef.current;
        const todayKyiv2 = toDateString(new Date());
        const pastFloor =
          dateRef.current === todayKyiv2 ? minHourRef.current : dynWindowStartRef.current;
        if (pr.edge === 'start') {
          const newStartH = snapTo15(
            Math.max(pastFloor, Math.min(pr.origStartH + deltaH, pr.origEndH - 0.25)),
          );
          setPendingSlot(p => (p ? { ...p, startH: newStartH } : null));
        } else {
          const newEndH = snapTo15(
            Math.min(dynWindowEndRef.current, Math.max(pr.origEndH + deltaH, pr.origStartH + 0.25)),
          );
          setPendingSlot(p => (p ? { ...p, endH: newEndH } : null));
        }
        return;
      }
      const res = resizingRef.current;
      if (res) {
        const rect = timelineRef.current?.getBoundingClientRect();
        if (!rect) return;
        // Inline px→decimal-hours (see above — pxToHours used hardcoded TOTAL_HOURS=12).
        const deltaH =
          ((e.clientX - res.pointerStartX) / (rect.width - SIDEBAR_W)) * dynTotalHoursRef.current;
        if (res.edge === 'start') {
          const newStartH = snapTo15(
            Math.max(
              dynWindowStartRef.current,
              Math.min(res.origStartH + deltaH, res.origEndH - 0.25),
            ),
          );
          setResizePreview(p => (p ? { ...p, startH: newStartH } : null));
        } else {
          const newEndH = snapTo15(
            Math.min(
              dynWindowEndRef.current,
              Math.max(res.origEndH + deltaH, res.origStartH + 0.25),
            ),
          );
          setResizePreview(p => (p ? { ...p, endH: newEndH } : null));
        }
      }
    };

    const onUp = async (e: PointerEvent) => {
      if (drawingRef.current) {
        const { liftId, startH } = drawingRef.current;
        const rawEndH = pxToDecimalHours(e.clientX);
        const endH = rawEndH - startH >= 0.25 ? snapTo15(rawEndH) : startH + 1;
        const clampedEnd = Math.min(endH, dynWindowEndRef.current);
        drawingRef.current = null;
        setGhost(null);
        setPendingSlot({ liftId, startH, endH: clampedEnd });
        setEditingSlotId(null);
        setError('');
        setCpDisplay('');
        setForm({
          ...EMPTY_FORM,
          liftId,
          startAt: decimalHoursToHHMM(startH),
          endAt: decimalHoursToHHMM(clampedEnd),
          normoHours: String(+(clampedEnd - startH).toFixed(2)),
        });
        setShowAdd(true);
        return;
      }
      if (pendingResizingRef.current) {
        setPendingResizing(null);
        const p = pendingSlotRef.current;
        if (p && showAddRef.current) {
          setForm(f => ({
            ...f,
            startAt: decimalHoursToHHMM(p.startH),
            endAt: decimalHoursToHHMM(p.endH),
            normoHours: String(+(p.endH - p.startH).toFixed(2)),
          }));
        }
        return;
      }
      const res = resizingRef.current;
      const preview = resizePreviewRef.current;
      if (res && preview) {
        const { slotId, origStartH, origEndH, workOrderId } = res;
        const { startH, endH } = preview;
        setResizing(null);
        setResizePreview(null);
        if (Math.abs(startH - origStartH) < 0.01 && Math.abs(endH - origEndH) < 0.01) return;
        const todayKyiv = toDateString(new Date());
        if (dateRef.current < todayKyiv) {
          toast.warning(t('slot.pastSlotLocked'));
          return;
        }
        if (dateRef.current === todayKyiv && startH < minHourRef.current) {
          toast.warning(t('slot.pastStartLocked'));
          return;
        }
        try {
          // BR-WO-024: нові межі запису наряду сервер робить плановими датами наряду (ті самі
          // перевірки, що й збереження наряду); відмова — 400, запис повертається на місце.
          await apiFetch(`/calendar/slots/${slotId}`, {
            method: 'PATCH',
            body: JSON.stringify({
              startAt: decimalHoursToISO(dateRef.current, startH),
              endAt: decimalHoursToISO(dateRef.current, endH),
            }),
          });
          if (workOrderId) {
            // Картка й списки нарядів — нові планові дати; ланцюжок записів сервер перебудовує,
            // тож вид перечитується з resync відкритої форми (як після перетягування, Bug #884).
            invalidateWorkOrders();
            notifyCalendarChanged();
          } else load();
        } catch (err: unknown) {
          toast.error(err instanceof Error ? err.message : t('slot.errUpdateFallback'));
          load();
        }
      }
    };

    const onCancel = () => {
      if (drawingRef.current) {
        drawingRef.current = null;
        setGhost(null);
      }
      if (pendingResizingRef.current) setPendingResizing(null);
      if (resizingRef.current) {
        setResizing(null);
        setResizePreview(null);
      }
    };

    // onUp — async (PATCH слоту при resize). addEventListener чекає void-листенер, тож
    // обгортаємо у ОДНУ стабільну константу: і add, і remove бачать ту саму функцію
    // (інлайн-стрілка у двох місцях дала б різні ідентичності → листенер не знявся б).
    // `void` тут безпечний: onUp має власний try/catch із `toast.error` + повторний `load()`.
    const onUpListener = (e: PointerEvent): void => {
      void onUp(e);
    };

    window.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUpListener);
    window.addEventListener('pointercancel', onCancel);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUpListener);
      window.removeEventListener('pointercancel', onCancel);
    };
  }, [pxToDecimalHours, load, t, invalidateWorkOrders]);

  // ── Drag-and-drop ─────────────────────────────────────────────────────────

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const { active, delta, over } = event;
      if (!active || !delta) return;

      if (active.id === PENDING_DRAG_ID) {
        const p = pendingSlotRef.current;
        if (!p) return;
        const containerWidth = timelineRef.current?.getBoundingClientRect().width ?? 0;
        if (!containerWidth) return;
        const timelineWidth = containerWidth - SIDEBAR_W;
        const shiftH = snapTo15((delta.x / timelineWidth) * dynTotalHoursRef.current);
        const newLiftId = over?.data?.current?.liftId ?? p.liftId;
        const newStartH = Math.max(
          dynWindowStartRef.current,
          Math.min(p.startH + shiftH, dynWindowEndRef.current - (p.endH - p.startH)),
        );
        const newEndH = newStartH + (p.endH - p.startH);
        setPendingSlot({ liftId: newLiftId, startH: newStartH, endH: newEndH });
        setForm(f => ({
          ...f,
          liftId: newLiftId,
          startAt: decimalHoursToHHMM(newStartH),
          endAt: decimalHoursToHHMM(newEndH),
          normoHours: String(+(newEndH - newStartH).toFixed(2)),
        }));
        return;
      }

      const slot = slots.find(s => s.id === active.id);
      // BR-WO-027: запис наряду не в редагованому статусі не перетягується (сервер відповів би 400).
      if (!slot || !canManageSlots || workOrderTimeLock(slot)) return;
      const newLiftId: string | null = over?.data?.current?.liftId ?? slot.liftId ?? null;
      const containerWidth = timelineRef.current?.getBoundingClientRect().width ?? 0;
      if (!containerWidth) return;
      const timelineWidth = containerWidth - SIDEBAR_W;
      const shiftHours = (delta.x / timelineWidth) * dynTotalHoursRef.current;
      if (Math.abs(shiftHours) < 0.08 && newLiftId === slot.liftId) return;
      const origStart = new Date(slot.startAt);
      const origEnd = new Date(slot.endAt);
      const shiftMs = Math.round((shiftHours * 3600_000) / (15 * 60_000)) * (15 * 60_000);
      const newStart = new Date(origStart.getTime() + shiftMs);
      const newEnd = new Date(origEnd.getTime() + shiftMs);

      const todayKyiv = toDateString(new Date(nowMs || Date.now()));
      const newStartDate = toDateString(newStart);
      const newStartH = kyivHours(newStart.toISOString());
      if (newStartDate < todayKyiv) {
        toast.warning(t('slot.pastDayLocked'));
        return;
      }
      if (newStartDate === todayKyiv && newStartH < minHour) {
        toast.warning(t('slot.pastTimeLocked'));
        return;
      }

      const liftChanged = newLiftId !== slot.liftId;
      try {
        // BR-WO-023: запис наряду переміщується лише разом із нарядом — сервер зсуває планові
        // дати наряду (і підйомник — рядок, на який перенесено) і переносить увесь ланцюжок
        // записів тими самими перевірками, що й збереження наряду. Відмова — 400: нічого не
        // змінено, запис лишається на місці, тост — причина.
        if (slot.workOrderId) {
          const moved = await apiFetch<MechanicDropResponse>(
            `/work-orders/${slot.workOrderId}/reschedule`,
            {
              method: 'PATCH',
              body: JSON.stringify({
                slotId: slot.id,
                startAt: newStart.toISOString(),
                ...(newLiftId && { liftId: newLiftId }),
              }),
            },
          );
          if (moved?.mechanicDropped) {
            const lift = liftsRef.current.find(l => l.id === newLiftId)?.name ?? '';
            toast.warning(
              mechanicDroppedText(t, moved.mechanicDroppedReason, slot.employeeName, lift),
            );
          }
          // Картка наряду, списки нарядів — нові планові дати й підйомник.
          invalidateWorkOrders();
          // Ланцюжок записів сервер перебудовує (продовження — нові записи), тож перечитуємо вид
          // з resync відкритої форми запису (refreshView через подію), а не лише сітку (Bug #884).
          notifyCalendarChanged();
          return;
        }
        const saved = await apiFetch<MechanicDropResponse>(`/calendar/slots/${slot.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            startAt: newStart.toISOString(),
            endAt: newEnd.toISOString(),
            // BR-CAL-012: механік, не закріплений за новим підйомником, знімається сервером
            // (рішення власника 2026-10-16) — перетягування не відхиляється.
            ...(liftChanged && { liftId: newLiftId, dropMechanicNotOnLift: true }),
          }),
        });
        if (saved?.mechanicDropped) {
          const lift = liftsRef.current.find(l => l.id === newLiftId)?.name ?? '';
          toast.warning(
            mechanicDroppedText(t, saved.mechanicDroppedReason, slot.employeeName, lift),
          );
        }
        load();
      } catch (e: unknown) {
        toast.error(e instanceof Error ? e.message : t('slot.errMoveFallback'));
      }
    },
    [slots, load, nowMs, minHour, t, canManageSlots, invalidateWorkOrders],
  );

  // ── Remove slot ───────────────────────────────────────────────────────────

  const removeSlot = useCallback(
    async (id: string) => {
      const slot = slots.find(s => s.id === id);
      // BR-WO-026: запис наряду не в редагованому статусі не видаляється (сервер відповів би 400),
      // крім скасованого наряду — його запис видаляється без зміни дат наряду.
      const timeLock = slot ? workOrderTimeLock(slot) : null;
      if (workOrderDeleteLock(timeLock)) return;
      const woNumber = slot?.workOrderId ? (slot.workOrderNumber ?? '') : null;
      const ok = await confirm(slotDeleteConfirmOptions(t, woNumber, timeLock));
      if (!ok) return;
      try {
        await apiFetch<void>(`/calendar/slots/${id}`, { method: 'DELETE' });
        toast.success(t('slot.slotDeleted'));
        // BR-WO-026: запис наряду стер планові дати наряду — картка, списки й лічильники нарядів.
        if (woNumber !== null) invalidateWorkOrders();
        load();
      } catch (e: unknown) {
        if (mountedRef.current)
          toast.error(e instanceof Error ? e.message : t('slot.errDeleteFallback'));
      }
    },
    [slots, load, confirm, t, invalidateWorkOrders],
  );

  // ── Memoized slot data ────────────────────────────────────────────────────

  const slotsWithPreview = useMemo(() => {
    if (!resizePreview) return slots;
    return slots.map(s => {
      if (s.id !== resizePreview.id) return s;
      // DST-aware: decimalHoursToISO uses kyivDateTimeToISO internally
      // (Kyiv → UTC), not local-time-parsing.
      return {
        ...s,
        startAt: decimalHoursToISO(date, resizePreview.startH),
        endAt: decimalHoursToISO(date, resizePreview.endH),
      };
    });
  }, [slots, resizePreview, date]);

  const slotsByLift = useMemo(() => {
    const map = new Map<string, CalendarSlot[]>();
    for (const s of slotsWithPreview) {
      if (!s.liftId) continue;
      const list = map.get(s.liftId);
      if (list) list.push(s);
      else map.set(s.liftId, [s]);
    }
    return map;
  }, [slotsWithPreview]);

  const EMPTY_SLOTS = useMemo<CalendarSlot[]>(() => [], []);
  const unassignedSlots = useMemo(
    () => slotsWithPreview.filter(s => !s.liftId),
    [slotsWithPreview],
  );

  const nextSlotByLift = useMemo(() => {
    const map = new Map<string, 'now' | string>();
    if (!nowMs) return map;
    const now = nowMs;
    for (const [liftId, liftSlots] of slotsByLift) {
      const active = liftSlots.find(
        s => new Date(s.startAt).getTime() <= now && new Date(s.endAt).getTime() > now,
      );
      if (active) {
        map.set(liftId, 'now');
        continue;
      }
      let earliest: CalendarSlot | null = null;
      for (const s of liftSlots) {
        if (new Date(s.startAt).getTime() > now) {
          if (!earliest || new Date(s.startAt) < new Date(earliest.startAt)) earliest = s;
        }
      }
      if (earliest) map.set(liftId, earliest.startAt);
    }
    return map;
  }, [slotsByLift, nowMs]);

  // Приглушене минуле: сьогодні — до лінії «зараз» (BR-CAL-011), не до початку поточної години.
  // Заборону малювати в минулому тримає `minHour`, а не ця ширина.
  const blockedWidth = useMemo(
    () => pastPercent(nowMs, date, dynWindowStart, dynWindowEnd),
    [nowMs, date, dynWindowStart, dynWindowEnd],
  );

  // Лінія «зараз» — лише сьогодні за Києвом і в межах робочих годин (BR-CAL-011).
  const nowLine = useMemo(
    () => nowLinePercent(nowMs, date, dynWindowStart, dynWindowEnd),
    [nowMs, date, dynWindowStart, dynWindowEnd],
  );

  // Кінець ланцюжка кожного запису дня (з продовженнями наступного дня) — для кольору блоку
  // «прострочено» у виді «День» (BR-CAL-011), так само як у рядку лічильників.
  const dayChainEnds = useMemo(() => chainEnds([...slots, ...nextDaySlots]), [slots, nextDaySlots]);

  // Рядок лічильників дня (BR-CAL-008) — та сама збірка, що й у місяці: кінець ланцюжка
  // враховує продовження наступного дня.
  const dayEntries = useMemo(
    () =>
      date
        ? (buildMonthSlots(
            [
              { d: date, slots },
              { d: nextDateString(date), slots: nextDaySlots },
            ],
            [date],
          )[date]?.entries ?? [])
        : [],
    [date, slots, nextDaySlots],
  );

  const isEditingPast = useMemo(() => {
    if (!editingSlotId || !nowMs) return false;
    // Запис, відкритий з виду «Місяць», — минулий за власним `endAt` (BR-CAL-009).
    if (monthEditSlot?.id === editingSlotId) {
      return new Date(monthEditSlot.endAt).getTime() < nowMs;
    }
    const slot = slots.find(s => s.id === editingSlotId);
    if (!slot) return false;
    const todayKyiv = toDateString(new Date(nowMs));
    const slotDate = toDateString(new Date(slot.startAt));
    if (slotDate < todayKyiv) return true;
    if (slotDate === todayKyiv) return kyivHours(slot.startAt) < minHour;
    return false;
  }, [editingSlotId, monthEditSlot, slots, nowMs, minHour]);

  /** Запис, відкритий у формі, як збережено; `null` — новий запис чи збережений ще не прочитано. */
  const editingSavedSlot = useMemo(
    () => (editingSlotId && editingSaved?.id === editingSlotId ? editingSaved : null),
    [editingSlotId, editingSaved],
  );

  /**
   * Наряд запису, відкритого у формі (як збережено): номер — для підтвердження видалення
   * (BR-WO-026), `lockedStatus` — статус, у якому час і підйомник запису не змінюються (BR-WO-027).
   */
  const editingWorkOrder = useMemo(
    () =>
      editingSavedSlot?.workOrderId
        ? {
            number: editingSavedSlot.workOrderNumber ?? '',
            lockedStatus: workOrderTimeLock(editingSavedSlot),
          }
        : null,
    [editingSavedSlot],
  );

  const savedMechanic = useMemo<SavedMechanic | null>(
    () =>
      editingSavedSlot
        ? {
            liftId: editingSavedSlot.liftId,
            employeeId: editingSavedSlot.employeeId,
            employeeName: editingSavedSlot.employeeName,
          }
        : null,
    [editingSavedSlot],
  );

  // ── Modal close / save callbacks ──────────────────────────────────────────

  const handleModalClose = useCallback(() => {
    setShowAdd(false);
    setEditingSlotId(null);
    setMonthEditSlot(null);
    setError('');
    setPendingSlot(null);
  }, []);

  /**
   * Перечитати поточний вид, не закриваючи форму (наряд змінено з його картки). Виклики одного
   * такту зливаються в одне читання: картка наряду після збереження шле подію
   * `notifyCalendarChanged` і одразу кличе `onUpdated` форми запису — без злиття «День» читався
   * двічі (6 запитів замість 3), «Місяць» — 64 замість 32.
   */
  const refreshPendingRef = useRef(false);
  const refreshView = useCallback(() => {
    resyncEditRef.current = true;
    if (refreshPendingRef.current) return;
    refreshPendingRef.current = true;
    queueMicrotask(() => {
      refreshPendingRef.current = false;
      if (calView === 'month') void loadMonth(yearMonth, true);
      else if (calView === 'day') load();
    });
  }, [calView, load, loadMonth, yearMonth]);

  const handleModalSaved = useCallback(
    (opts?: { workOrderChanged?: boolean }) => {
      // BR-WO-024: збережено запис наряду — нові планові дати й підйомник у картці й списках.
      // Запис, що на відкритті належав наряду, відкріплено чи видалено — наряд утратив запис
      // календаря (лічильник у списку нарядів), хоча поля наряду у формі вже немає (Bug #904).
      const hadWorkOrder = !!editingSavedSlot && editingSavedSlot.workOrderId !== null;
      if (opts?.workOrderChanged || hadWorkOrder) invalidateWorkOrders();
      setShowAdd(false);
      setEditingSlotId(null);
      setMonthEditSlot(null);
      setPendingSlot(null);
      setForm(EMPTY_FORM);
      setCpDisplay('');
      // Запис збережено чи видалено з виду «Місяць» — перечитати місяць, а не день (BR-CAL-009).
      refreshView();
    },
    [refreshView, invalidateWorkOrders, editingSavedSlot],
  );

  // Наряд змінив свій запис календаря на сервері (BR-WO-020: збереження планових дат чи
  // підйомника з картки наряду поверх календаря) — перечитати поточний вид.
  useEffect(() => onCalendarChanged(refreshView), [refreshView]);

  // Bug #884: наряд, чий запис відкрито у формі, збережено з його картки — сервер переніс запис
  // (BR-WO-020). Перечитаний запис іншого часу, підйомника чи механіка → форма бере збережене;
  // запису вже немає у виді (переїхав на інший день, продовження створено заново, дати стерто) →
  // форма закривається. Без змін — форма не чіпається (незбережені нотатки лишаються).
  useEffect(() => {
    if (!resyncEditRef.current) return;
    resyncEditRef.current = false;
    if (!showAdd || !editingSlotId || editingSaved?.id !== editingSlotId) return;
    const pool =
      calView === 'month'
        ? Object.values(monthSlots).flatMap(d => d.entries.map(e => e.slot))
        : slots;
    const fresh = pool.find(s => s.id === editingSlotId);
    if (!fresh) {
      handleModalClose();
      return;
    }
    const saved = savedOf(fresh);
    if (
      saved.startAt === editingSaved.startAt &&
      saved.endAt === editingSaved.endAt &&
      saved.liftId === editingSaved.liftId &&
      saved.employeeId === editingSaved.employeeId &&
      saved.workOrderStatus === editingSaved.workOrderStatus
    )
      return;
    setEditingSaved(saved);
    if (calView === 'month') setMonthEditSlot(fresh);
    const { liftId, employeeId, startAt, endAt, normoHours } = slotToForm(fresh);
    setForm(f => ({ ...f, liftId, employeeId, startAt, endAt, normoHours }));
  }, [slots, monthSlots, showAdd, editingSlotId, editingSaved, calView, handleModalClose]);

  // ── Month view: картка запису й «новий запис на дату» (BR-CAL-009) ─────────

  /**
   * Відкриває запис із картки місяця в тій самій формі, що й вид «День». Дата сторінки стає
   * датою запису: форма рахує час від `date`, інакше збереження перенесло б запис на інший день.
   */
  const openMonthSlot = useCallback(
    (slot: CalendarSlot) => {
      setDate(toDateString(new Date(slot.startAt)));
      setError('');
      handleEditSlot(slot);
      setMonthEditSlot(slot);
    },
    [setDate, handleEditSlot],
  );

  const openNewOnDate = useCallback(
    (dayStr: string) => {
      if (!canManageSlots) return;
      setDate(dayStr);
      setMonthEditSlot(null);
      setPendingSlot(null);
      setEditingSlotId(null);
      setError('');
      setCpDisplay('');
      setForm(EMPTY_FORM);
      setShowAdd(true);
    },
    [setDate, canManageSlots],
  );

  return {
    /** Право створювати й змінювати записи (BR-CAL-010): механіку — лише перегляд. */
    canManageSlots,

    // URL / view
    calView,
    setCalView,
    dayLayout,
    setDayLayout,
    date,
    setDate,
    openDay,
    yearMonth,
    prevDay,
    nextDay,

    // confirm dialog
    confirm,
    dialogProps,

    // Day view data
    slots,
    dayEntries,
    bookingSlots,
    loading,
    lifts,
    slotsByLift,
    unassignedSlots,
    nextSlotByLift,
    EMPTY_SLOTS,
    blockedWidth,
    nowLine,
    dayChainEnds,
    nowMs,
    minHour,

    // Dynamic work hours (from BranchSettings)
    hours: dynHours,
    windowStart: dynWindowStart,
    windowEnd: dynWindowEnd,
    totalHours: dynTotalHours,

    // Month / stats
    monthSlots,
    monthLoading,
    monthError,
    statsPeriod,
    setStatsPeriod,
    statsFrom,
    setStatsFrom,
    statsTo,
    setStatsTo,
    statsSlots,
    statsLoading,
    statsError,
    statsRange,
    statsRangeTooLong,

    // Form / modal
    form,
    setForm,
    showAdd,
    setShowAdd,
    formMounted,
    formVisible,
    formCollapseRef,
    formInnerRef,
    editingSlotId,
    setEditingSlotId,
    isEditingPast,
    savedMechanic,
    editingWorkOrder,
    error,
    setError,
    saving,
    setSaving,
    cpDisplay,
    setCpDisplay,

    // Pending / ghost / resize
    pendingSlot,
    setPendingSlot,
    ghost,

    // DnD + handlers
    sensors,
    timelineRef,
    handleDragEnd,
    handleResizeStart,
    handlePendingResizeStart,
    openFormFromPending,
    cancelPending,
    handleEditSlot,
    removeSlot,
    openMonthSlot,
    openNewOnDate,

    // Modal callbacks
    handleModalClose,
    handleModalSaved,
    refreshView,
  };
}
