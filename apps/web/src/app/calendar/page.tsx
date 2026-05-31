'use client';

import {
  useEffect,
  useState,
  useCallback,
  useMemo,
  useRef,
  memo,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  Plus,
  ChevronLeft,
  ChevronRight,
  Trash2,
  CalendarDays,
  BarChart2,
  CalendarRange,
} from 'lucide-react';
import { useRequireAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api-client';
import { getCached, setCache } from '@/lib/ref-cache';
import { toast } from '@/lib/toast';
import { Button } from '@/components/ui/button';
import { DatePickerInput } from '@/components/ui/date-picker-input';
import { Spinner } from '@/components/ui/spinner';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useConfirm } from '@/hooks/useConfirm';
import {
  DndContext,
  useDraggable,
  useDroppable,
  type DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';

import type {
  CalendarSlot,
  Lift,
  PendingSlot,
  GhostSlot,
  ResizeState,
  PendingResizeState,
  CalView,
  StatsPeriod,
  MonthSlots,
  SlotForm,
} from './calendar.types';
import {
  HOURS,
  TOTAL_HOURS,
  SIDEBAR_W,
  WINDOW_START,
  WINDOW_END,
  STATS_MAX_DAYS,
  KYIV_HOUR_FMT,
  pad,
  toDateString,
  kyivHours,
  fmtTime,
  decimalHoursToHHMM,
  decimalHoursToISO,
  snapTo15,
  pxToHours,
  formatKyivDate,
  fmtKyivMonthYear,
} from './calendar.utils';
import { CalendarMonthView } from './CalendarMonthView';
import { CalendarStatsTab } from './CalendarStatsTab';
import { CalendarSlotModal } from './CalendarSlotModal';

// ─── DraggableSlot ───────────────────────────────────────────────────────────

interface DraggableSlotProps {
  slot: CalendarSlot;
  isEditing: boolean;
  onRemove: (id: string) => void;
  onEdit: (slot: CalendarSlot) => void;
  onResizeStart: (
    e: ReactPointerEvent<HTMLDivElement>,
    slotId: string,
    edge: 'start' | 'end',
  ) => void;
}

const DraggableSlot = memo(function DraggableSlot({
  slot,
  isEditing,
  onRemove,
  onEdit,
  onResizeStart,
}: DraggableSlotProps) {
  const startH = kyivHours(slot.startAt);
  const endH = kyivHours(slot.endAt);
  const left = ((startH - HOURS[0]!) / TOTAL_HOURS) * 100;
  const width = ((endH - startH) / TOTAL_HOURS) * 100;

  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: slot.id,
    data: { slot },
  });
  const style: CSSProperties = {
    left: `${left}%`,
    width: `${width}%`,
    transform: CSS.Translate.toString(transform),
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 50 : 10,
  };

  const label = [
    `${fmtTime(slot.startAt)}–${fmtTime(slot.endAt)}`,
    slot.workOrderNumber ? `· ${slot.workOrderNumber}` : null,
    slot.counterpartyName ? `· ${slot.counterpartyName}` : null,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-calendar-slot
      className={`absolute top-1 bottom-1 rounded text-white text-xs flex items-center overflow-hidden group select-none ring-2 ring-offset-1 ${isEditing ? 'bg-amber-500 ring-amber-400' : 'bg-primary ring-transparent'}`}
      title={label}
    >
      <div
        className="absolute left-0 top-0 bottom-0 w-2 cursor-col-resize z-20 hover:bg-white/20 rounded-l flex items-center justify-center"
        onPointerDown={e => {
          e.stopPropagation();
          onResizeStart(e, slot.id, 'start');
        }}
        aria-label="Змінити початок"
      >
        <div className="w-0.5 h-4 bg-white/50 rounded" />
      </div>

      <div
        className="flex-1 flex items-center px-3 cursor-grab active:cursor-grabbing min-w-0"
        {...listeners}
        {...attributes}
        onClick={() => onEdit(slot)}
      >
        <span className="truncate">{label}</span>
      </div>

      <button
        onPointerDown={e => e.stopPropagation()}
        onClick={() => onRemove(slot.id)}
        className="mr-1 opacity-0 group-hover:opacity-100 text-white/80 hover:text-white shrink-0"
        aria-label="Видалити слот"
      >
        <Trash2 className="h-3 w-3" />
      </button>

      <div
        className="absolute right-0 top-0 bottom-0 w-2 cursor-col-resize z-20 hover:bg-white/20 rounded-r flex items-center justify-center"
        onPointerDown={e => {
          e.stopPropagation();
          onResizeStart(e, slot.id, 'end');
        }}
        aria-label="Змінити кінець"
      >
        <div className="w-0.5 h-4 bg-white/50 rounded" />
      </div>
    </div>
  );
});

// ─── PendingSlotBlock ────────────────────────────────────────────────────────

interface PendingSlotBlockProps {
  pending: PendingSlot;
  onOpen: () => void;
  onCancel: () => void;
  onPendingResizeStart: (e: ReactPointerEvent<HTMLDivElement>, edge: 'start' | 'end') => void;
}

const PENDING_DRAG_ID = '__pending__';

// Module-level constant — stable ref avoids re-creation on every render
const EMPTY_FORM: SlotForm = {
  liftId: '',
  employeeId: '',
  counterpartyId: '',
  counterpartyDisplay: '',
  workOrderId: '',
  workOrderDisplay: '',
  startAt: '',
  endAt: '',
  notes: '',
  normoHours: '',
};

const PendingSlotBlock = memo(function PendingSlotBlock({
  pending,
  onOpen,
  onCancel,
  onPendingResizeStart,
}: PendingSlotBlockProps) {
  const left = ((pending.startH - HOURS[0]!) / TOTAL_HOURS) * 100;
  const width = ((pending.endH - pending.startH) / TOTAL_HOURS) * 100;

  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: PENDING_DRAG_ID,
    data: { isPending: true },
  });

  const style: CSSProperties = {
    left: `${left}%`,
    width: `${width}%`,
    transform: CSS.Translate.toString(transform),
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 50 : 10,
  };

  return (
    <div
      ref={setNodeRef}
      data-pending-slot
      className="absolute top-1 bottom-1 bg-primary/20 border-2 border-primary rounded flex items-center overflow-hidden group select-none z-10"
      style={style}
      title="Перетягніть щоб змінити підйомник або час. Натисніть щоб відкрити форму"
    >
      <div
        className="absolute left-0 top-0 bottom-0 w-2 cursor-col-resize z-20 hover:bg-primary/20 rounded-l flex items-center justify-center"
        onPointerDown={e => {
          e.stopPropagation();
          onPendingResizeStart(e, 'start');
        }}
        aria-label="Змінити початок"
      >
        <div className="w-0.5 h-4 bg-primary/60 rounded" />
      </div>

      <span
        className="flex-1 text-xs text-primary font-medium px-3 truncate cursor-grab active:cursor-grabbing"
        onClick={onOpen}
        {...listeners}
        {...attributes}
      >
        {decimalHoursToHHMM(pending.startH)}–{decimalHoursToHHMM(pending.endH)}
      </span>

      <button
        onPointerDown={e => e.stopPropagation()}
        onClick={e => {
          e.stopPropagation();
          onCancel();
        }}
        className="mr-1 opacity-0 group-hover:opacity-100 text-primary/70 hover:text-primary shrink-0"
        aria-label="Скасувати"
      >
        <Plus className="h-3 w-3 rotate-45" />
      </button>

      <div
        className="absolute right-0 top-0 bottom-0 w-2 cursor-col-resize z-20 hover:bg-primary/20 rounded-r flex items-center justify-center"
        onPointerDown={e => {
          e.stopPropagation();
          onPendingResizeStart(e, 'end');
        }}
        aria-label="Змінити кінець"
      >
        <div className="w-0.5 h-4 bg-primary/60 rounded" />
      </div>
    </div>
  );
});

// ─── DroppableLiftRow ────────────────────────────────────────────────────────

interface DroppableLiftRowProps {
  liftId: string;
  liftSlots: CalendarSlot[];
  ghost: GhostSlot | null;
  pending: PendingSlot | null;
  editingSlotId: string | null;
  blockedWidth: number;
  onRemove: (id: string) => void;
  onEdit: (slot: CalendarSlot) => void;
  onResizeStart: (
    e: ReactPointerEvent<HTMLDivElement>,
    slotId: string,
    edge: 'start' | 'end',
  ) => void;
  onPendingOpen: () => void;
  onPendingCancel: () => void;
  onPendingResizeStart: (e: ReactPointerEvent<HTMLDivElement>, edge: 'start' | 'end') => void;
}

const DroppableLiftRow = memo(function DroppableLiftRow({
  liftId,
  liftSlots,
  ghost,
  pending,
  editingSlotId,
  blockedWidth,
  onRemove,
  onEdit,
  onResizeStart,
  onPendingOpen,
  onPendingCancel,
  onPendingResizeStart,
}: DroppableLiftRowProps) {
  const { setNodeRef, isOver } = useDroppable({ id: `lift-${liftId}`, data: { liftId } });

  const showGhost = ghost?.liftId === liftId && ghost.endH > ghost.startH;
  const ghostLeft = showGhost ? ((ghost!.startH - HOURS[0]!) / TOTAL_HOURS) * 100 : 0;
  const ghostWidth = showGhost ? ((ghost!.endH - ghost!.startH) / TOTAL_HOURS) * 100 : 0;
  const showPending = pending?.liftId === liftId;

  return (
    <div
      ref={setNodeRef}
      className={`col-span-12 relative min-h-20 transition-colors ${isOver ? 'bg-primary/5' : ''}`}
      style={{ gridColumn: `2 / span ${TOTAL_HOURS}` }}
      data-lift-id={liftId}
    >
      <div className="flex h-full pointer-events-none">
        {HOURS.map(h => (
          <div key={h} className="flex-1 border-r last:border-r-0 border-border min-h-20" />
        ))}
      </div>

      {blockedWidth > 0 && (
        <div
          className="absolute inset-y-0 left-0 pointer-events-none z-1"
          style={{
            width: `${blockedWidth}%`,
            backgroundImage:
              'repeating-linear-gradient(135deg, transparent 0px, transparent 6px, rgba(0,0,0,0.08) 6px, rgba(0,0,0,0.08) 8px)',
            backgroundColor: 'rgba(0,0,0,0.04)',
          }}
          aria-hidden
        >
          {blockedWidth < 100 && (
            <div className="absolute inset-y-0 right-0 w-0.5 bg-foreground/20" />
          )}
        </div>
      )}

      {showGhost && (
        <div
          className="absolute top-1 bottom-1 bg-primary/30 border-2 border-primary border-dashed rounded pointer-events-none z-5"
          style={{ left: `${ghostLeft}%`, width: `${ghostWidth}%` }}
        >
          <span className="text-xs text-primary px-1.5 font-medium">
            {decimalHoursToHHMM(ghost!.startH)}–{decimalHoursToHHMM(ghost!.endH)}
          </span>
        </div>
      )}

      {showPending && (
        <PendingSlotBlock
          pending={pending!}
          onOpen={onPendingOpen}
          onCancel={onPendingCancel}
          onPendingResizeStart={onPendingResizeStart}
        />
      )}

      {liftSlots.map(s => (
        <DraggableSlot
          key={s.id}
          slot={s}
          isEditing={s.id === editingSlotId}
          onRemove={onRemove}
          onEdit={onEdit}
          onResizeStart={onResizeStart}
        />
      ))}
    </div>
  );
});

// ─── CalendarPage ─────────────────────────────────────────────────────────────

export default function CalendarPage() {
  useRequireAuth(['OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC']);

  const { confirm, dialogProps } = useConfirm();
  const [date, setDate] = useState('');
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

  const [calView, setCalView] = useState<CalView>('day');

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
    setDate(toDateString(new Date()));
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

  const prevDay = () => {
    const d = new Date(date);
    d.setDate(d.getDate() - 1);
    setDate(toDateString(d));
  };
  const nextDay = () => {
    const d = new Date(date);
    d.setDate(d.getDate() + 1);
    setDate(toDateString(d));
  };

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
      const toISO = (h: number) => {
        const totalMin = Math.round(h * 60);
        return new Date(
          `${date}T${pad(Math.floor(totalMin / 60))}:${pad(totalMin % 60)}:00`,
        ).toISOString();
      };
      return { ...s, startAt: toISO(resizePreview.startH), endAt: toISO(resizePreview.endH) };
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

  const EMPTY_SLOTS: CalendarSlot[] = useMemo(() => [], []);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="page-container">
      <div className="page-header mb-6">
        <h1 className="page-title">Календар</h1>
        <div className="flex items-center gap-2">
          {/* View switcher */}
          <div className="flex rounded-lg border border-border overflow-hidden text-sm">
            {(
              [
                ['day', 'День', CalendarDays],
                ['month', 'Місяць', CalendarRange],
                ['stats', 'Статистика', BarChart2],
              ] as const
            ).map(([v, label, Icon]) => (
              <button
                key={v}
                onClick={() => {
                  setCalView(v);
                  if (v === 'stats') {
                    setShowAdd(false);
                    setEditingSlotId(null);
                  }
                }}
                className={`flex items-center gap-1.5 px-3 py-1.5 transition-colors ${calView === v ? 'bg-primary text-primary-foreground' : 'bg-surface text-muted-foreground hover:bg-secondary'}`}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </button>
            ))}
          </div>
          {calView !== 'stats' && (
            <Button
              onClick={() => {
                setPendingSlot(null);
                setEditingSlotId(null);
                setError('');
                setCpDisplay('');
                setForm(EMPTY_FORM);
                setShowAdd(v => !v);
              }}
            >
              <Plus className="h-4 w-4" />
              Слот
            </Button>
          )}
        </div>
      </div>

      {/* Date / month navigation — hidden in stats view */}
      {calView !== 'stats' && (
        <div className="flex items-center gap-4 mb-6">
          {calView === 'month' ? (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  const [y, m] = yearMonth.split('-').map(Number);
                  const d = new Date(y, m - 2, 1);
                  setDate(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`);
                }}
              >
                <ChevronLeft className="h-4 w-4" />
                Попередній
              </Button>
              <span className="text-sm font-medium text-foreground capitalize">
                {date ? fmtKyivMonthYear(date) : ''}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  const [y, m] = yearMonth.split('-').map(Number);
                  const d = new Date(y, m, 1);
                  setDate(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`);
                }}
              >
                Наступний
                <ChevronRight className="h-4 w-4" />
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setDate(toDateString(new Date()))}>
                Цей місяць
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" size="sm" onClick={prevDay}>
                <ChevronLeft className="h-4 w-4" />
                Попередній
              </Button>
              <div className="flex items-center gap-2">
                <DatePickerInput
                  value={date}
                  onChange={setDate}
                  placeholder="Дата"
                  className="w-48"
                />
                <span
                  className={`text-sm capitalize ${nowMs && date < toDateString(new Date(nowMs)) ? 'text-destructive-text font-medium' : 'text-muted-foreground'}`}
                >
                  {formatKyivDate(date)}
                  {nowMs && date < toDateString(new Date(nowMs)) ? ' — минулий день' : ''}
                </span>
              </div>
              <Button variant="outline" size="sm" onClick={nextDay}>
                Наступний
                <ChevronRight className="h-4 w-4" />
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setDate(toDateString(new Date()))}>
                Сьогодні
              </Button>
            </>
          )}
        </div>
      )}

      {/* ── Add / edit form — hidden in stats view ──────────────────────────── */}
      <CalendarSlotModal
        open={showAdd && calView !== 'stats'}
        onClose={handleModalClose}
        onSaved={handleModalSaved}
        date={date}
        lifts={lifts}
        form={form}
        setForm={setForm}
        editingSlotId={editingSlotId}
        isEditingPast={isEditingPast}
        pendingSlot={pendingSlot}
        setPendingSlot={setPendingSlot}
        formMounted={formMounted}
        formVisible={formVisible}
        formCollapseRef={formCollapseRef}
        formInnerRef={formInnerRef}
        minHour={minHour}
        nowMs={nowMs}
        error={error}
        setError={setError}
        saving={saving}
        setSaving={setSaving}
        cpDisplay={cpDisplay}
        setCpDisplay={setCpDisplay}
      />

      {/* ── Hint — day view only ─────────────────────────────────────────────── */}
      {calView === 'day' && !loading && lifts.length > 0 && !pendingSlot && !showAdd && (
        <p className="text-xs text-muted-foreground mb-2">
          Затисніть і перетягніть по рядку підйомника щоб створити слот. Тягніть краї для зміни
          тривалості. Натисніть на проміжок щоб зберегти.
        </p>
      )}
      {calView === 'day' && pendingSlot && !showAdd && (
        <p className="text-xs text-primary mb-2 font-medium">
          ↑ Налаштуйте проміжок і натисніть на нього щоб відкрити форму збереження.
        </p>
      )}

      {/* ── MONTH VIEW ──────────────────────────────────────────────────────── */}
      {calView === 'month' && (
        <CalendarMonthView
          yearMonth={yearMonth}
          monthSlots={monthSlots}
          monthLoading={monthLoading}
          monthError={monthError}
          nowMs={nowMs}
          onDayClick={dayStr => {
            setDate(dayStr);
            setCalView('day');
          }}
        />
      )}

      {/* ── STATS VIEW ──────────────────────────────────────────────────────── */}
      {calView === 'stats' && (
        <CalendarStatsTab
          lifts={lifts}
          statsSlots={statsSlots}
          statsLoading={statsLoading}
          statsError={statsError}
          statsPeriod={statsPeriod}
          setStatsPeriod={setStatsPeriod}
          statsFrom={statsFrom}
          setStatsFrom={setStatsFrom}
          statsTo={statsTo}
          setStatsTo={setStatsTo}
          statsRangeTooLong={statsRangeTooLong}
          date={date}
          setDate={setDate}
          statsRange={statsRange}
        />
      )}

      {/* ── DAY VIEW ────────────────────────────────────────────────────────── */}
      {calView === 'day' && loading && (
        <div className="flex justify-center py-8">
          <Spinner size="md" />
        </div>
      )}

      {calView === 'day' && !loading && lifts.length === 0 && (
        <div className="bg-surface border border-border rounded-xl p-8 text-center text-sm text-muted-foreground">
          Немає підйомників. Додайте їх у розділі{' '}
          <a href="/infrastructure" className="text-primary hover:underline">
            Інфраструктура
          </a>
          .
        </div>
      )}

      {calView === 'day' && !loading && lifts.length > 0 && (
        <DndContext
          sensors={sensors}
          onDragEnd={e => {
            void handleDragEnd(e);
          }}
        >
          <div
            ref={timelineRef}
            className="bg-surface border border-border rounded-xl overflow-hidden"
          >
            <div
              className="grid border-b border-border"
              style={{ gridTemplateColumns: `${SIDEBAR_W}px repeat(${HOURS.length}, 1fr)` }}
            >
              <div className="px-3 py-2 text-xs font-medium text-muted-foreground bg-secondary border-r border-border">
                Підйомник
              </div>
              {HOURS.map(h => (
                <div
                  key={h}
                  className="px-1 py-2 text-xs text-center text-muted-foreground bg-secondary border-r border-border last:border-r-0"
                >
                  {pad(h)}:00
                </div>
              ))}
            </div>

            {lifts.map(lift => (
              <div
                key={lift.id}
                className="grid border-b border-border last:border-b-0"
                style={{ gridTemplateColumns: `${SIDEBAR_W}px repeat(${HOURS.length}, 1fr)` }}
              >
                <div className="px-3 py-3 min-h-20 bg-secondary border-r border-border flex flex-col justify-center gap-0.5">
                  <span className="text-sm font-medium text-foreground leading-tight">
                    {lift.name}
                  </span>
                  {nextSlotByLift.get(lift.id) === 'now' ? (
                    <span className="text-[10px] font-medium text-success-text leading-none">
                      ● зараз
                    </span>
                  ) : nextSlotByLift.has(lift.id) ? (
                    <span className="text-[10px] text-muted-foreground leading-none">
                      ↓ {fmtTime(nextSlotByLift.get(lift.id)!)}
                    </span>
                  ) : null}
                </div>
                <DroppableLiftRow
                  liftId={lift.id}
                  liftSlots={slotsByLift.get(lift.id) ?? EMPTY_SLOTS}
                  ghost={ghost}
                  pending={pendingSlot}
                  editingSlotId={editingSlotId}
                  blockedWidth={blockedWidth}
                  onRemove={removeSlot}
                  onEdit={handleEditSlot}
                  onResizeStart={handleResizeStart}
                  onPendingOpen={openFormFromPending}
                  onPendingCancel={cancelPending}
                  onPendingResizeStart={handlePendingResizeStart}
                />
              </div>
            ))}
          </div>
        </DndContext>
      )}

      {/* Unassigned slots — day view only */}
      {calView === 'day' && unassignedSlots.length > 0 && (
        <div className="mt-6 bg-surface border border-border rounded-xl p-5">
          <h3 className="font-semibold text-foreground mb-3 text-sm">Без підйомника</h3>
          <div className="space-y-2">
            {unassignedSlots.map(s => (
              <div
                key={s.id}
                className="flex items-center justify-between px-3 py-2 bg-secondary rounded-lg"
              >
                <div>
                  <span className="text-sm text-foreground">
                    {fmtTime(s.startAt)} – {fmtTime(s.endAt)}
                  </span>
                  {s.workOrderNumber && (
                    <span className="ml-2 text-xs text-primary">Наряд {s.workOrderNumber}</span>
                  )}
                  {s.counterpartyName && (
                    <span className="ml-2 text-xs text-muted-foreground">{s.counterpartyName}</span>
                  )}
                  {s.notes && <span className="ml-2 text-xs text-muted-foreground">{s.notes}</span>}
                </div>
                <Button variant="ghost" size="sm" onClick={() => removeSlot(s.id)}>
                  <Trash2 className="h-3.5 w-3.5 text-destructive" />
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}
      <ConfirmDialog {...dialogProps} />
    </div>
  );
}
