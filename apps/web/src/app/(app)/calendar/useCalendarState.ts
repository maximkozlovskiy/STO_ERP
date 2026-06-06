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
import { PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';

import { apiFetch } from '@/lib/api-client';
import { getCached, setCache } from '@/lib/ref-cache';
import { toast } from '@/lib/toast';
import { useConfirm } from '@/hooks/useConfirm';

import type {
  CalView,
  CalendarSlot,
  GhostSlot,
  Lift,
  MonthSlots,
  PendingResizeState,
  PendingSlot,
  ResizeState,
  SlotForm,
  StatsPeriod,
} from './calendar.types';
import {
  HOURS,
  KYIV_HOUR_FMT,
  SIDEBAR_W,
  STATS_MAX_DAYS,
  TOTAL_HOURS,
  WINDOW_END,
  WINDOW_START,
  decimalHoursToHHMM,
  decimalHoursToISO,
  kyivHours,
  pxToHours,
  snapTo15,
  toDateString,
} from './calendar.utils';

// Shared drag-id for the pending-slot block (used both by the draggable in JSX
// and by handleDragEnd to dispatch logic). Exported so sub-components can use it.
export const PENDING_DRAG_ID = '__pending__';

// Module-level constant — stable ref avoids re-creation on every render.
export const EMPTY_FORM: SlotForm = {
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
 * useCalendarState — encapsulates all state, refs, side-effects and handlers
 * for the calendar day-view (drag/drop, resize, draw, pending slot, fetch slots/lifts,
 * month/stats data, form animation). page.tsx remains a thin render layer.
 */
export type CalendarState = ReturnType<typeof useCalendarState>;

export function useCalendarState() {
  const router = useRouter();
  const searchParams = useSearchParams();
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

  const [slots, setSlots] = useState<CalendarSlot[]>([]);
  const [loading, setLoading] = useState(true);
  const [lifts, setLifts] = useState<Lift[]>([]);
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
    if (!date || !nowMs) return HOURS[0]!;
    const todayKyiv = toDateString(new Date(nowMs));
    if (date !== todayKyiv) return HOURS[0]!;
    const parts = KYIV_HOUR_FMT.formatToParts(new Date(nowMs));
    return parseInt(parts.find(p => p.type === 'hour')?.value ?? '8', 10);
  }, [date, nowMs]);

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

  // Animate form open/close
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

  useEffect(() => {
    const cached = getCached<Lift[]>('cache:lifts');
    if (cached && mountedRef.current) setLifts(cached);
    apiFetch<Lift[]>('/lifts')
      .then(data => {
        setCache('cache:lifts', data);
        if (mountedRef.current) setLifts(data);
      })
      .catch((e: unknown) => {
        if (mountedRef.current && !cached)
          setError(e instanceof Error ? e.message : 'Помилка завантаження');
      });
  }, []);

  const monthAbortRef = useRef<AbortController | null>(null);

  const loadMonth = useCallback(async (yearMonth: string) => {
    const [y, m] = yearMonth.split('-').map(Number);
    if (!y || !m) return;
    const daysInMonth = new Date(y, m, 0).getDate();
    monthAbortRef.current?.abort();
    const ac = new AbortController();
    monthAbortRef.current = ac;
    setMonthLoading(true);
    if (mountedRef.current) setMonthError(false);
    try {
      const days = Array.from({ length: daysInMonth }, (_, i) => {
        const d = i + 1;
        return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      });
      let failures = 0;
      const results = await Promise.all(
        days.map(d =>
          apiFetch<CalendarSlot[]>(`/calendar/slots?date=${d}`, { signal: ac.signal })
            .then(s => ({ d, slots: s }))
            .catch(() => {
              failures++;
              return { d, slots: [] as CalendarSlot[] };
            }),
        ),
      );
      if (ac.signal.aborted) return;
      const acc: MonthSlots = {};
      for (const { d, slots: daySlots } of results) {
        const byLift: Record<string, number> = {};
        for (const s of daySlots) {
          if (s.liftId) byLift[s.liftId] = (byLift[s.liftId] ?? 0) + 1;
        }
        acc[d] = { total: daySlots.length, byLift };
      }
      if (mountedRef.current) {
        setMonthSlots(acc);
        setMonthError(days.length > 0 && failures === days.length);
      }
    } finally {
      if (mountedRef.current && !ac.signal.aborted) setMonthLoading(false);
    }
  }, []);

  const yearMonth = date ? date.slice(0, 7) : '';

  useEffect(() => {
    if (calView === 'month' && yearMonth) loadMonth(yearMonth);
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
      let failures = 0;
      const results = await Promise.all(
        days.map(d =>
          apiFetch<CalendarSlot[]>(`/calendar/slots?date=${d}`, { signal: ac.signal }).catch(() => {
            failures++;
            return [] as CalendarSlot[];
          }),
        ),
      );
      if (ac.signal.aborted) return;
      if (mountedRef.current) {
        setStatsSlots(results.flat());
        setStatsError(days.length > 0 && failures === days.length);
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

  const load = useCallback(() => {
    if (!date) return;
    setLoading(true);
    apiFetch<CalendarSlot[]>(`/calendar/slots?date=${date}`)
      .then(data => {
        if (mountedRef.current) setSlots(data);
      })
      .catch((e: unknown) => {
        if (mountedRef.current) setError(e instanceof Error ? e.message : 'Помилка завантаження');
      })
      .finally(() => {
        if (mountedRef.current) setLoading(false);
      });
  }, [date]);

  // Skip day-view fetch when user is in stats/month view — saves N round-trips
  // on date changes that affect only the other view's data.
  useEffect(() => {
    if (calView === 'day') load();
  }, [load, calView]);

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

  const pxToDecimalHours = useCallback((clientX: number): number => {
    const rect = timelineRef.current?.getBoundingClientRect();
    if (!rect) return HOURS[0]!;
    const timelineX = clientX - rect.left - SIDEBAR_W;
    const timelineW = rect.width - SIDEBAR_W;
    const raw = HOURS[0]! + (timelineX / timelineW) * TOTAL_HOURS;
    return Math.max(HOURS[0]!, Math.min(HOURS[HOURS.length - 1]!, raw));
  }, []);

  const showAddRef = useRef(showAdd);
  showAddRef.current = showAdd;
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
      liftId: p.liftId,
      employeeId: '',
      counterpartyId: '',
      counterpartyDisplay: '',
      vehicleId: '',
      workOrderId: '',
      workOrderDisplay: '',
      startAt: decimalHoursToHHMM(p.startH),
      endAt: decimalHoursToHHMM(p.endH),
      normoHours: String(+(p.endH - p.startH).toFixed(2)),
      notes: '',
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
    setEditingSlotId(slot.id);
    setPendingSlot(null);
    const woDisplay = slot.workOrderNumber
      ? `${slot.workOrderNumber}${slot.counterpartyName ? ` · ${slot.counterpartyName}` : ''}`
      : '';
    const cpDisp = slot.counterpartyName ?? '';
    setCpDisplay(cpDisp);
    setForm({
      liftId: slot.liftId ?? '',
      employeeId: slot.employeeId ?? '',
      counterpartyId: slot.counterpartyId ?? '',
      counterpartyDisplay: cpDisp,
      vehicleId: slot.vehicleId ?? '',
      workOrderId: slot.workOrderId ?? '',
      workOrderDisplay: woDisplay,
      startAt: decimalHoursToHHMM(kyivHours(slot.startAt)),
      endAt: decimalHoursToHHMM(kyivHours(slot.endAt)),
      normoHours: String(+(kyivHours(slot.endAt) - kyivHours(slot.startAt)).toFixed(2)),
      notes: slot.notes ?? '',
    });
    setShowAdd(true);
  }, []);

  // ── Resize existing saved slot ────────────────────────────────────────────

  const handleResizeStart = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>, slotId: string, edge: 'start' | 'end') => {
      e.stopPropagation();
      const slot = slots.find(s => s.id === slotId);
      if (!slot) return;
      setResizing({
        slotId,
        edge,
        origStartH: kyivHours(slot.startAt),
        origEndH: kyivHours(slot.endAt),
        pointerStartX: e.clientX,
        liftId: slot.liftId ?? null,
      });
      setResizePreview({
        id: slotId,
        startH: kyivHours(slot.startAt),
        endH: kyivHours(slot.endAt),
      });
    },
    [slots],
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
      const liftRow = target.closest('[data-lift-id]') as HTMLElement | null;
      const liftId = liftRow?.dataset.liftId;
      if (!liftId) return;
      setPendingSlot(null);
      const todayKyiv = toDateString(new Date());
      if (dateRef.current < todayKyiv) return;
      const pastClamp = dateRef.current === todayKyiv ? minHourRef.current : HOURS[0]!;
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
        const deltaH = pxToHours(e.clientX - pr.pointerStartX, rect.width - SIDEBAR_W);
        const todayKyiv2 = toDateString(new Date());
        const pastFloor = dateRef.current === todayKyiv2 ? minHourRef.current : WINDOW_START;
        if (pr.edge === 'start') {
          const newStartH = snapTo15(
            Math.max(pastFloor, Math.min(pr.origStartH + deltaH, pr.origEndH - 0.25)),
          );
          setPendingSlot(p => (p ? { ...p, startH: newStartH } : null));
        } else {
          const newEndH = snapTo15(
            Math.min(WINDOW_END, Math.max(pr.origEndH + deltaH, pr.origStartH + 0.25)),
          );
          setPendingSlot(p => (p ? { ...p, endH: newEndH } : null));
        }
        return;
      }
      const res = resizingRef.current;
      if (res) {
        const rect = timelineRef.current?.getBoundingClientRect();
        if (!rect) return;
        const deltaH = pxToHours(e.clientX - res.pointerStartX, rect.width - SIDEBAR_W);
        if (res.edge === 'start') {
          const newStartH = snapTo15(
            Math.max(WINDOW_START, Math.min(res.origStartH + deltaH, res.origEndH - 0.25)),
          );
          setResizePreview(p => (p ? { ...p, startH: newStartH } : null));
        } else {
          const newEndH = snapTo15(
            Math.min(WINDOW_END, Math.max(res.origEndH + deltaH, res.origStartH + 0.25)),
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
        const clampedEnd = Math.min(endH, WINDOW_END);
        drawingRef.current = null;
        setGhost(null);
        setPendingSlot({ liftId, startH, endH: clampedEnd });
        setEditingSlotId(null);
        setError('');
        setCpDisplay('');
        setForm({
          liftId,
          employeeId: '',
          counterpartyId: '',
          counterpartyDisplay: '',
          vehicleId: '',
          workOrderId: '',
          workOrderDisplay: '',
          startAt: decimalHoursToHHMM(startH),
          endAt: decimalHoursToHHMM(clampedEnd),
          normoHours: String(+(clampedEnd - startH).toFixed(2)),
          notes: '',
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
        const { slotId, origStartH, origEndH } = res;
        const { startH, endH } = preview;
        setResizing(null);
        setResizePreview(null);
        if (Math.abs(startH - origStartH) < 0.01 && Math.abs(endH - origEndH) < 0.01) return;
        const todayKyiv = toDateString(new Date());
        if (dateRef.current < todayKyiv) {
          toast.warning('Не можна змінювати слоти у минулому дні');
          return;
        }
        if (dateRef.current === todayKyiv && startH < minHourRef.current) {
          toast.warning('Не можна перемістити початок у минулий час');
          return;
        }
        try {
          await apiFetch(`/calendar/slots/${slotId}`, {
            method: 'PATCH',
            body: JSON.stringify({
              startAt: decimalHoursToISO(dateRef.current, startH),
              endAt: decimalHoursToISO(dateRef.current, endH),
            }),
          });
          load();
        } catch (err: unknown) {
          toast.error(err instanceof Error ? err.message : 'Помилка оновлення слоту');
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

    window.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
    };
  }, [pxToDecimalHours, load]);

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
        const shiftH = snapTo15((delta.x / timelineWidth) * TOTAL_HOURS);
        const newLiftId = over?.data?.current?.liftId ?? p.liftId;
        const newStartH = Math.max(
          WINDOW_START,
          Math.min(p.startH + shiftH, WINDOW_END - (p.endH - p.startH)),
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
      if (!slot) return;
      const newLiftId: string | null = over?.data?.current?.liftId ?? slot.liftId ?? null;
      const containerWidth = timelineRef.current?.getBoundingClientRect().width ?? 0;
      if (!containerWidth) return;
      const timelineWidth = containerWidth - SIDEBAR_W;
      const shiftHours = (delta.x / timelineWidth) * TOTAL_HOURS;
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
        toast.warning('Не можна перемістити запис у минулий день');
        return;
      }
      if (newStartDate === todayKyiv && newStartH < minHour) {
        toast.warning('Не можна перемістити запис у минулий час');
        return;
      }

      try {
        await apiFetch(`/calendar/slots/${slot.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            startAt: newStart.toISOString(),
            endAt: newEnd.toISOString(),
            ...(newLiftId !== slot.liftId && { liftId: newLiftId }),
          }),
        });
        load();
      } catch (e: unknown) {
        toast.error(e instanceof Error ? e.message : 'Помилка переміщення слоту');
      }
    },
    [slots, load, nowMs, minHour],
  );

  // ── Remove slot ───────────────────────────────────────────────────────────

  const removeSlot = useCallback(
    async (id: string) => {
      if (!(await confirm({ title: 'Видалити слот?', variant: 'destructive' }))) return;
      try {
        await apiFetch<void>(`/calendar/slots/${id}`, { method: 'DELETE' });
        toast.success('Слот видалено');
        load();
      } catch (e: unknown) {
        if (mountedRef.current) toast.error(e instanceof Error ? e.message : 'Помилка видалення');
      }
    },
    [load, confirm],
  );

  // ── Memoized slot data ────────────────────────────────────────────────────

  const slotsWithPreview = useMemo(() => {
    if (!resizePreview) return slots;
    return slots.map(s => {
      if (s.id !== resizePreview.id) return s;
      // Bug #354: decimalHoursToISO використовує kyivDateTimeToISO внутрішньо
      // (DST-aware Kyiv → UTC), замість попереднього local-time-parsing.
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

  const blockedWidth = useMemo(() => {
    if (!nowMs || !date) return 0;
    const todayKyiv = toDateString(new Date(nowMs));
    if (date < todayKyiv) return 100;
    if (date > todayKyiv) return 0;
    const blockedHours = Math.max(0, minHour - WINDOW_START);
    return (blockedHours / TOTAL_HOURS) * 100;
  }, [nowMs, date, minHour]);

  const isEditingPast = useMemo(() => {
    if (!editingSlotId || !nowMs) return false;
    const slot = slots.find(s => s.id === editingSlotId);
    if (!slot) return false;
    const todayKyiv = toDateString(new Date(nowMs));
    const slotDate = toDateString(new Date(slot.startAt));
    if (slotDate < todayKyiv) return true;
    if (slotDate === todayKyiv) return kyivHours(slot.startAt) < minHour;
    return false;
  }, [editingSlotId, slots, nowMs, minHour]);

  // ── Modal close / save callbacks ──────────────────────────────────────────

  const handleModalClose = useCallback(() => {
    setShowAdd(false);
    setEditingSlotId(null);
    setError('');
    setPendingSlot(null);
  }, []);

  const handleModalSaved = useCallback(() => {
    setShowAdd(false);
    setEditingSlotId(null);
    setPendingSlot(null);
    setForm(EMPTY_FORM);
    setCpDisplay('');
    load();
  }, [load]);

  return {
    // URL / view
    calView,
    setCalView,
    date,
    setDate,
    yearMonth,
    prevDay,
    nextDay,

    // confirm dialog
    confirm,
    dialogProps,

    // Day view data
    slots,
    loading,
    lifts,
    slotsByLift,
    unassignedSlots,
    nextSlotByLift,
    EMPTY_SLOTS,
    blockedWidth,
    nowMs,
    minHour,

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

    // Modal callbacks
    handleModalClose,
    handleModalSaved,
  };
}
