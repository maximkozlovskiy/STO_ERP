'use client';

import {
  useEffect, useState, useCallback, useMemo, useRef, memo,
  type CSSProperties, type PointerEvent as ReactPointerEvent,
} from 'react';
import { Plus, ChevronLeft, ChevronRight, Trash2 } from 'lucide-react';
import { useRequireAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api-client';
import { getCached, setCache } from '@/lib/ref-cache';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { DatePickerInput } from '@/components/ui/date-picker-input';
import { Spinner } from '@/components/ui/spinner';
import {
  DndContext, useDraggable, useDroppable,
  type DragEndEvent, PointerSensor, useSensor, useSensors,
} from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';

// ─── Types ───────────────────────────────────────────────────────────────────

interface CalendarSlot {
  id: string;
  liftId?: string | null;
  employeeId?: string | null;
  workOrderId?: string | null;
  startAt: string;
  endAt: string;
  notes?: string | null;
  workOrderNumber?: string;
  counterpartyName?: string;
}
interface Lift { id: string; name: string; }
interface WorkOrderOption { id: string; number: string; counterpartyName?: string; }

// Ghost while drawing a new slot on the grid
interface GhostSlot { liftId: string; startH: number; endH: number; }

// Resize state for dragging slot edges
interface ResizeState {
  slotId: string;
  edge: 'start' | 'end';
  origStartH: number;
  origEndH: number;
  pointerStartX: number;
  liftId: string | null;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const KYIV_TZ = 'Europe/Kyiv';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOURS = Array.from({ length: 12 }, (_, i) => i + 8); // 08:00–19:00
const TOTAL_HOURS = HOURS.length;
const SIDEBAR_W = 160; // px — lift label column width
const WINDOW_START = HOURS[0];                 // 8 — earliest valid hour
const WINDOW_END   = HOURS[HOURS.length - 1] + 1; // 20 — latest valid hour (end of last column)

// ─── Helpers ─────────────────────────────────────────────────────────────────

function pad(n: number) { return String(n).padStart(2, '0'); }
function toDateString(d: Date) { return new Intl.DateTimeFormat('sv-SE', { timeZone: KYIV_TZ }).format(d); }

function kyivHours(iso: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: KYIV_TZ, hour: 'numeric', minute: 'numeric', hour12: false,
  }).formatToParts(new Date(iso));
  const h = parseInt(parts.find(p => p.type === 'hour')?.value ?? '0', 10);
  const m = parseInt(parts.find(p => p.type === 'minute')?.value ?? '0', 10);
  return h + m / 60;
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString('uk-UA', { timeZone: KYIV_TZ, hour: '2-digit', minute: '2-digit', hour12: false });
}

function decimalHoursToHHMM(h: number): string {
  // Clamp to a valid 24h window so callers never build an invalid "24:30"/"-1:00" time.
  const totalMin = Math.min(24 * 60, Math.max(0, Math.round(h * 60)));
  return `${pad(Math.floor(totalMin / 60))}:${pad(totalMin % 60)}`;
}

// Build an ISO timestamp from a calendar date (YYYY-MM-DD) + decimal hours.
// Parsed in the runtime timezone (Kyiv-pinned deployment), matching addSlot.
function decimalHoursToISO(date: string, h: number): string {
  return new Date(`${date}T${decimalHoursToHHMM(h)}:00`).toISOString();
}

function snapTo15(h: number): number {
  return Math.round(h * 4) / 4;
}

// Convert pixel delta → hour shift given timeline container width
function pxToHours(px: number, timelineW: number): number {
  return (px / timelineW) * TOTAL_HOURS;
}

// ─── DraggableSlot ───────────────────────────────────────────────────────────

interface DraggableSlotProps {
  slot: CalendarSlot;
  onRemove: (id: string) => void;
  onResizeStart: (e: ReactPointerEvent<HTMLDivElement>, slotId: string, edge: 'start' | 'end') => void;
}

const DraggableSlot = memo(function DraggableSlot({ slot, onRemove, onResizeStart }: DraggableSlotProps) {
  const startH = kyivHours(slot.startAt);
  const endH   = kyivHours(slot.endAt);
  const left   = ((startH - HOURS[0]) / TOTAL_HOURS) * 100;
  const width  = ((endH - startH)     / TOTAL_HOURS) * 100;

  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: slot.id, data: { slot } });
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
  ].filter(Boolean).join(' ');

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-calendar-slot
      className="absolute top-1 bottom-1 bg-primary rounded text-white text-xs flex items-center overflow-hidden group select-none"
      title={label}
    >
      {/* Left resize handle */}
      <div
        className="absolute left-0 top-0 bottom-0 w-2 cursor-col-resize z-20 hover:bg-white/20 rounded-l flex items-center justify-center"
        onPointerDown={e => { e.stopPropagation(); onResizeStart(e, slot.id, 'start'); }}
        aria-label="Змінити початок"
      >
        <div className="w-0.5 h-4 bg-white/50 rounded" />
      </div>

      {/* Slot label — draggable area */}
      <div
        className="flex-1 flex items-center px-3 cursor-grab active:cursor-grabbing min-w-0"
        {...listeners}
        {...attributes}
      >
        <span className="truncate">{label}</span>
      </div>

      {/* Delete button */}
      <button
        onPointerDown={e => e.stopPropagation()}
        onClick={() => onRemove(slot.id)}
        className="mr-1 opacity-0 group-hover:opacity-100 text-white/80 hover:text-white shrink-0"
        aria-label="Видалити слот"
      >
        <Trash2 className="h-3 w-3" />
      </button>

      {/* Right resize handle */}
      <div
        className="absolute right-0 top-0 bottom-0 w-2 cursor-col-resize z-20 hover:bg-white/20 rounded-r flex items-center justify-center"
        onPointerDown={e => { e.stopPropagation(); onResizeStart(e, slot.id, 'end'); }}
        aria-label="Змінити кінець"
      >
        <div className="w-0.5 h-4 bg-white/50 rounded" />
      </div>
    </div>
  );
});

// ─── DroppableLiftRow ────────────────────────────────────────────────────────

interface DroppableLiftRowProps {
  liftId: string;
  liftSlots: CalendarSlot[];
  ghost: GhostSlot | null;
  onRemove: (id: string) => void;
  onResizeStart: (e: ReactPointerEvent<HTMLDivElement>, slotId: string, edge: 'start' | 'end') => void;
  onDrawStart: (e: ReactPointerEvent<HTMLDivElement>, liftId: string) => void;
}

const DroppableLiftRow = memo(function DroppableLiftRow({
  liftId, liftSlots, ghost, onRemove, onResizeStart, onDrawStart,
}: DroppableLiftRowProps) {
  const { setNodeRef, isOver } = useDroppable({ id: `lift-${liftId}`, data: { liftId } });

  const showGhost = ghost?.liftId === liftId && ghost.endH > ghost.startH;
  const ghostLeft  = showGhost ? ((ghost!.startH - HOURS[0]) / TOTAL_HOURS) * 100 : 0;
  const ghostWidth = showGhost ? ((ghost!.endH - ghost!.startH) / TOTAL_HOURS) * 100 : 0;

  return (
    <div
      ref={setNodeRef}
      className={`col-span-12 relative min-h-12 transition-colors ${isOver ? 'bg-primary/5' : ''}`}
      style={{ gridColumn: `2 / span ${TOTAL_HOURS}` }}
      onPointerDown={e => onDrawStart(e, liftId)}
    >
      {/* Hour grid lines */}
      <div className="flex h-full pointer-events-none">
        {HOURS.map(h => (
          <div key={h} className="flex-1 border-r last:border-r-0 border-border min-h-12" />
        ))}
      </div>

      {/* Ghost slot while drawing */}
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

      {/* Existing slots */}
      {liftSlots.map(s => (
        <DraggableSlot key={s.id} slot={s} onRemove={onRemove} onResizeStart={onResizeStart} />
      ))}
    </div>
  );
});

// ─── CalendarPage ─────────────────────────────────────────────────────────────

export default function CalendarPage() {
  useRequireAuth(['OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC']);

  const [date, setDate] = useState('');
  const [slots, setSlots] = useState<CalendarSlot[]>([]);
  const [loading, setLoading] = useState(true);
  const [lifts, setLifts] = useState<Lift[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({
    liftId: '', employeeId: '', workOrderId: '', workOrderDisplay: '',
    startAt: '', endAt: '', notes: '', normoHours: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Drawing new slot by dragging on empty grid
  const [ghost, setGhost] = useState<GhostSlot | null>(null);
  const drawingRef = useRef<{ liftId: string; startH: number } | null>(null);

  // Resizing existing slot edges
  const [resizing, setResizing] = useState<ResizeState | null>(null);
  // Live preview of resized slot (local optimistic copy)
  const [resizePreview, setResizePreview] = useState<{ id: string; startH: number; endH: number } | null>(null);

  const timelineRef = useRef<HTMLDivElement>(null);
  const mountedRef  = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  useEffect(() => { setDate(toDateString(new Date())); }, []);

  // Load lifts (with sessionStorage cache)
  useEffect(() => {
    const cached = getCached<Lift[]>('cache:lifts');
    if (cached && mountedRef.current) setLifts(cached);
    apiFetch<Lift[]>('/lifts')
      .then(data => { setCache('cache:lifts', data); if (mountedRef.current) setLifts(data); })
      .catch((e: unknown) => { if (mountedRef.current && !cached) setError(e instanceof Error ? e.message : 'Помилка завантаження'); });
  }, []);

  const load = useCallback(() => {
    if (!date) return;
    setLoading(true);
    apiFetch<CalendarSlot[]>(`/calendar/slots?date=${date}`)
      .then(data => { if (mountedRef.current) setSlots(data); })
      .catch((e: unknown) => { if (mountedRef.current) setError(e instanceof Error ? e.message : 'Помилка завантаження'); })
      .finally(() => { if (mountedRef.current) setLoading(false); });
  }, [date]);

  useEffect(() => { load(); }, [load]);

  const prevDay = () => { const d = new Date(date); d.setDate(d.getDate() - 1); setDate(toDateString(d)); };
  const nextDay = () => { const d = new Date(date); d.setDate(d.getDate() + 1); setDate(toDateString(d)); };

  // ── Helpers ─────────────────────────────────────────────────────────────────

  // Convert pointer clientX → decimal hours on the timeline
  const pxToDecimalHours = useCallback((clientX: number): number => {
    const rect = timelineRef.current?.getBoundingClientRect();
    if (!rect) return HOURS[0];
    const timelineX = clientX - rect.left - SIDEBAR_W;
    const timelineW = rect.width - SIDEBAR_W;
    const raw = HOURS[0] + (timelineX / timelineW) * TOTAL_HOURS;
    return Math.max(HOURS[0], Math.min(HOURS[HOURS.length - 1], raw));
  }, []);

  // ── Draw new slot ────────────────────────────────────────────────────────────

  const handleDrawStart = useCallback((e: ReactPointerEvent<HTMLDivElement>, liftId: string) => {
    if (e.button !== 0) return;
    if (showAdd) return; // form is open — don't start drawing
    const target = e.target as HTMLElement;
    if (target.closest('[data-calendar-slot]')) return;

    const startH = snapTo15(pxToDecimalHours(e.clientX));
    drawingRef.current = { liftId, startH };
    setGhost({ liftId, startH, endH: startH + 1 });
  }, [pxToDecimalHours, showAdd]);

  // ── Resize existing slot ─────────────────────────────────────────────────────

  const handleResizeStart = useCallback((e: ReactPointerEvent<HTMLDivElement>, slotId: string, edge: 'start' | 'end') => {
    e.stopPropagation();
    const slot = slots.find(s => s.id === slotId);
    if (!slot) return;
    setResizing({
      slotId, edge,
      origStartH: kyivHours(slot.startAt),
      origEndH:   kyivHours(slot.endAt),
      pointerStartX: e.clientX,
      liftId: slot.liftId ?? null,
    });
    setResizePreview({ id: slotId, startH: kyivHours(slot.startAt), endH: kyivHours(slot.endAt) });
  }, [slots]);

  // ── Global window listeners (pointermove / pointerup) ────────────────────────
  // Using window instead of timelineRef handlers because setPointerCapture on
  // a child element (DroppableLiftRow / resize handle) redirects all pointer
  // events to that element — parent onPointerMove/Up never fire.

  const resizingRef = useRef(resizing);
  resizingRef.current = resizing;
  const resizePreviewRef = useRef(resizePreview);
  resizePreviewRef.current = resizePreview;
  const ghostRef = useRef(ghost);
  ghostRef.current = ghost;
  const dateRef = useRef(date);
  dateRef.current = date;

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const curH = pxToDecimalHours(e.clientX);

      if (drawingRef.current) {
        const { startH } = drawingRef.current;
        const endH = snapTo15(Math.max(curH, startH + 0.25));
        setGhost(g => g ? { ...g, endH } : null);
        return;
      }

      const res = resizingRef.current;
      if (res) {
        const rect = timelineRef.current?.getBoundingClientRect();
        if (!rect) return;
        const deltaH = pxToHours(e.clientX - res.pointerStartX, rect.width - SIDEBAR_W);
        if (res.edge === 'start') {
          const newStartH = snapTo15(Math.max(WINDOW_START, Math.min(res.origStartH + deltaH, res.origEndH - 0.25)));
          setResizePreview(p => p ? { ...p, startH: newStartH } : null);
        } else {
          const newEndH = snapTo15(Math.min(WINDOW_END, Math.max(res.origEndH + deltaH, res.origStartH + 0.25)));
          setResizePreview(p => p ? { ...p, endH: newEndH } : null);
        }
      }
    };

    const onUp = async (e: PointerEvent) => {
      // ── Finish drawing → open form ──────────────────────────────────────
      if (drawingRef.current) {
        const { liftId, startH } = drawingRef.current;
        const endH = snapTo15(Math.max(pxToDecimalHours(e.clientX), startH + 0.25));
        drawingRef.current = null;
        setGhost(null);

        if (endH - startH >= 0.25) {
          setGhost(null); // ensure ghost is cleared before form opens
          setForm(f => ({
            ...f,
            liftId,
            startAt: decimalHoursToHHMM(startH),
            endAt:   decimalHoursToHHMM(endH),
            normoHours: String(+(endH - startH).toFixed(2)),
          }));
          setShowAdd(true);
        }
        return;
      }

      // ── Finish resizing → PATCH ─────────────────────────────────────────
      const res = resizingRef.current;
      const preview = resizePreviewRef.current;
      if (res && preview) {
        const { slotId, origStartH, origEndH } = res;
        const { startH, endH } = preview;
        setResizing(null);
        setResizePreview(null);

        if (Math.abs(startH - origStartH) < 0.01 && Math.abs(endH - origEndH) < 0.01) return;

        try {
          await apiFetch(`/calendar/slots/${slotId}`, {
            method: 'PATCH',
            body: JSON.stringify({ startAt: decimalHoursToISO(dateRef.current, startH), endAt: decimalHoursToISO(dateRef.current, endH) }),
          });
          load();
        } catch (err: unknown) {
          if (mountedRef.current) setError(err instanceof Error ? err.message : 'Помилка оновлення слоту');
          load();
        }
      }
    };

    const onCancel = () => {
      if (drawingRef.current) { drawingRef.current = null; setGhost(null); }
      if (resizingRef.current) { setResizing(null); setResizePreview(null); }
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
    };
  }, [pxToDecimalHours, load]);

  // ── Drag-and-drop move (existing behaviour + now PATCH actually works) ───────

  const handleDragEnd = useCallback(async (event: DragEndEvent) => {
    const { active, delta, over } = event;
    if (!active || !delta) return;

    const slot = slots.find(s => s.id === active.id);
    if (!slot) return;

    const newLiftId: string | null = over?.data?.current?.liftId ?? slot.liftId ?? null;

    const containerWidth = timelineRef.current?.getBoundingClientRect().width ?? 0;
    if (!containerWidth) return;

    const timelineWidth = containerWidth - SIDEBAR_W;
    const shiftHours = (delta.x / timelineWidth) * TOTAL_HOURS;

    if (Math.abs(shiftHours) < 0.08 && newLiftId === slot.liftId) return;

    const origStart = new Date(slot.startAt);
    const origEnd   = new Date(slot.endAt);
    const shiftMs   = Math.round(shiftHours * 3600_000 / (15 * 60_000)) * (15 * 60_000);

    const newStart = new Date(origStart.getTime() + shiftMs);
    const newEnd   = new Date(origEnd.getTime()   + shiftMs);

    try {
      await apiFetch(`/calendar/slots/${slot.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          startAt: newStart.toISOString(),
          endAt:   newEnd.toISOString(),
          ...(newLiftId !== slot.liftId && { liftId: newLiftId }),
        }),
      });
      load();
    } catch (e: unknown) {
      if (mountedRef.current) setError(e instanceof Error ? e.message : 'Помилка переміщення слоту');
    }
  }, [slots, load]);

  // ── Add slot (manual form submit) ────────────────────────────────────────────

  const addSlot = async () => {
    if (!form.startAt || !form.endAt) { setError('Вкажіть час початку та завершення'); return; }
    if (form.endAt <= form.startAt)    { setError('Час завершення повинен бути після часу початку'); return; }
    if (form.workOrderId && !UUID_RE.test(form.workOrderId)) {
      setError('Оберіть наряд зі списку'); return;
    }
    setSaving(true); setError('');
    try {
      await apiFetch<CalendarSlot>('/calendar/slots', {
        method: 'POST',
        body: JSON.stringify({
          liftId:      form.liftId      || undefined,
          employeeId:  form.employeeId  || undefined,
          workOrderId: form.workOrderId || undefined,
          startAt: new Date(`${date}T${form.startAt}:00`).toISOString(),
          endAt:   new Date(`${date}T${form.endAt}:00`).toISOString(),
          notes: form.notes || undefined,
        }),
      });
      setShowAdd(false);
      setForm({ liftId: '', employeeId: '', workOrderId: '', workOrderDisplay: '', startAt: '', endAt: '', notes: '', normoHours: '' });
      load();
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка'); }
    finally { setSaving(false); }
  };

  const removeSlot = useCallback(async (id: string) => {
    if (!confirm('Видалити слот?')) return;
    try { await apiFetch<void>(`/calendar/slots/${id}`, { method: 'DELETE' }); load(); }
    catch (e: unknown) { if (mountedRef.current) setError(e instanceof Error ? e.message : 'Помилка видалення'); }
  }, [load]);

  // ── Work-order search ─────────────────────────────────────────────────────────

  const [woSearch, setWoSearch] = useState('');
  const [woOptions, setWoOptions] = useState<WorkOrderOption[]>([]);
  const [woLoading, setWoLoading] = useState(false);
  const [showWoDropdown, setShowWoDropdown] = useState(false);
  const woTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!showAdd) { setWoSearch(''); setWoOptions([]); }
  }, [showAdd]);

  const searchWorkOrders = useCallback((q: string) => {
    if (woTimeoutRef.current) clearTimeout(woTimeoutRef.current);
    if (!q.trim()) { setWoOptions([]); setShowWoDropdown(false); return; }
    woTimeoutRef.current = setTimeout(async () => {
      setWoLoading(true);
      try {
        const data = await apiFetch<{ items: WorkOrderOption[] }>(`/work-orders?q=${encodeURIComponent(q)}&limit=10`);
        if (mountedRef.current) { setWoOptions(data.items); setShowWoDropdown(true); }
      } catch (err: unknown) {
        if (mountedRef.current) {
          setWoOptions([]); setShowWoDropdown(false);
          setError(err instanceof Error ? err.message : 'Помилка пошуку наряду');
        }
      }
      finally { if (mountedRef.current) setWoLoading(false); }
    }, 300);
  }, []);

  useEffect(() => {
    return () => { if (woTimeoutRef.current) clearTimeout(woTimeoutRef.current); };
  }, []);

  // ── Memoized grouping ────────────────────────────────────────────────────────

  // Apply resize preview to slots for optimistic rendering
  const slotsWithPreview = useMemo(() => {
    if (!resizePreview) return slots;
    return slots.map(s => {
      if (s.id !== resizePreview.id) return s;
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
      if (list) list.push(s); else map.set(s.liftId, [s]);
    }
    return map;
  }, [slotsWithPreview]);

  const EMPTY_SLOTS: CalendarSlot[] = useMemo(() => [], []);
  const unassignedSlots = useMemo(() => slotsWithPreview.filter(s => !s.liftId), [slotsWithPreview]);

  const formatDate = (ds: string) => {
    if (!ds) return '';
    return new Date(ds).toLocaleDateString('uk-UA', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric', timeZone: KYIV_TZ });
  };

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div className="page-container">
      {/* Header */}
      <div className="page-header mb-6">
        <h1 className="page-title">Календар</h1>
        <Button onClick={() => setShowAdd(v => !v)}>
          <Plus className="h-4 w-4" />
          Слот
        </Button>
      </div>

      {error && !showAdd && (
        <div className="mb-4 text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-4 py-2.5">{error}</div>
      )}

      {/* Date navigation */}
      <div className="flex items-center gap-4 mb-6">
        <Button variant="outline" size="sm" onClick={prevDay}>
          <ChevronLeft className="h-4 w-4" />
          Попередній
        </Button>
        <div className="flex items-center gap-2">
          <DatePickerInput value={date} onChange={setDate} placeholder="Дата" className="w-48" />
          <span className="text-sm text-muted-foreground capitalize">{formatDate(date)}</span>
        </div>
        <Button variant="outline" size="sm" onClick={nextDay}>
          Наступний
          <ChevronRight className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setDate(toDateString(new Date()))}>
          Сьогодні
        </Button>
      </div>

      {/* Add slot form */}
      {showAdd && (
        <div className="bg-surface border border-border rounded-xl p-5 mb-6 space-y-3">
          <h3 className="font-semibold text-foreground text-sm">Новий слот на {date}</h3>
          {error && <p className="text-[13px] text-destructive-text">{error}</p>}

          <div className="grid grid-cols-4 gap-3">
            {/* Lift */}
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">Підйомник</label>
              <Select value={form.liftId} onChange={e => setForm(f => ({ ...f, liftId: e.target.value }))}>
                <option value="">— будь-який —</option>
                {lifts.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
              </Select>
            </div>

            {/* Start time */}
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">Початок</label>
              <Input
                type="time"
                value={form.startAt}
                onChange={e => {
                  const start = e.target.value;
                  setForm(f => {
                    if (start && f.normoHours && Number(f.normoHours) > 0) {
                      const [h, m] = start.split(':').map(Number);
                      const totalMin = Math.min(h * 60 + m + Math.round(Number(f.normoHours) * 60), 23 * 60 + 59);
                      return { ...f, startAt: start, endAt: `${pad(Math.floor(totalMin / 60))}:${pad(totalMin % 60)}` };
                    }
                    return { ...f, startAt: start };
                  });
                }}
              />
            </div>

            {/* Normo-hours */}
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">
                Норм-год <span className="font-normal text-muted-foreground/70">(авто кінець)</span>
              </label>
              <Input
                type="number" step="0.5" min="0.5"
                value={form.normoHours}
                onChange={e => {
                  const nh = e.target.value;
                  setForm(f => {
                    if (f.startAt && nh && Number(nh) > 0) {
                      const [h, m] = f.startAt.split(':').map(Number);
                      const totalMin = Math.min(h * 60 + m + Math.round(Number(nh) * 60), 23 * 60 + 59);
                      return { ...f, normoHours: nh, endAt: `${pad(Math.floor(totalMin / 60))}:${pad(totalMin % 60)}` };
                    }
                    return { ...f, normoHours: nh };
                  });
                }}
                placeholder="1.5"
              />
            </div>

            {/* End time */}
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">Кінець</label>
              <Input type="time" value={form.endAt} onChange={e => setForm(f => ({ ...f, endAt: e.target.value }))} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            {/* Work order search */}
            <div className="relative">
              <label className="block text-xs font-medium text-muted-foreground mb-1">
                Наряд <span className="font-normal opacity-60">(пошук по номеру / клієнту)</span>
              </label>
              <Input
                value={woSearch || form.workOrderDisplay}
                onChange={e => {
                  const v = e.target.value;
                  setWoSearch(v);
                  if (!v) setForm(f => ({ ...f, workOrderId: '', workOrderDisplay: '' }));
                  searchWorkOrders(v);
                }}
                onFocus={() => { if (woSearch) setShowWoDropdown(true); }}
                placeholder="Введіть номер або прізвище..."
              />
              {form.workOrderDisplay && !woSearch && (
                <button
                  className="absolute right-2 top-7 text-muted-foreground hover:text-foreground text-xs"
                  onClick={() => setForm(f => ({ ...f, workOrderId: '', workOrderDisplay: '' }))}
                  aria-label="Очистити наряд"
                >✕</button>
              )}
              {showWoDropdown && woOptions.length > 0 && (
                <div className="absolute z-50 w-full bg-surface border border-border rounded-lg shadow-lg mt-1 max-h-48 overflow-y-auto">
                  {woLoading && <div className="p-2 text-xs text-muted-foreground">Пошук...</div>}
                  {woOptions.map(wo => (
                    <button
                      key={wo.id}
                      className="w-full text-left px-3 py-2 text-sm hover:bg-secondary transition-colors"
                      onClick={() => {
                        const display = `${wo.number}${wo.counterpartyName ? ` · ${wo.counterpartyName}` : ''}`;
                        setForm(f => ({ ...f, workOrderId: wo.id, workOrderDisplay: display }));
                        setWoSearch('');
                        setShowWoDropdown(false);
                      }}
                    >
                      <span className="font-medium text-foreground">{wo.number}</span>
                      {wo.counterpartyName && <span className="ml-2 text-muted-foreground">{wo.counterpartyName}</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Notes */}
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">Нотатки</label>
              <Input value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
            </div>
          </div>

          <div className="flex gap-2">
            <Button onClick={addSlot} loading={saving} disabled={!form.startAt || !form.endAt}>
              Зберегти
            </Button>
            <Button variant="outline" onClick={() => { setShowAdd(false); setError(''); setGhost(null); }}>
              Скасувати
            </Button>
          </div>
        </div>
      )}

      {/* Timeline grid */}
      {loading && <div className="flex justify-center py-8"><Spinner size="md" /></div>}

      {!loading && lifts.length === 0 && (
        <div className="bg-surface border border-border rounded-xl p-8 text-center text-sm text-muted-foreground">
          Немає підйомників. Додайте їх у розділі <a href="/infrastructure" className="text-primary hover:underline">Інфраструктура</a>.
        </div>
      )}

      {!loading && lifts.length > 0 && (
        <>
          <p className="text-xs text-muted-foreground mb-2">
            Затисніть і перетягніть по рядку підйомника щоб створити слот. Тягніть краї слоту для зміни тривалості.
          </p>
          <DndContext sensors={sensors} onDragEnd={e => { void handleDragEnd(e); }}>
            <div
              ref={timelineRef}
              className="bg-surface border border-border rounded-xl overflow-hidden"
            >
              {/* Hour headers */}
              <div className="grid border-b border-border" style={{ gridTemplateColumns: `${SIDEBAR_W}px repeat(${HOURS.length}, 1fr)` }}>
                <div className="px-3 py-2 text-xs font-medium text-muted-foreground bg-secondary border-r border-border">Підйомник</div>
                {HOURS.map(h => (
                  <div key={h} className="px-1 py-2 text-xs text-center text-muted-foreground bg-secondary border-r border-border last:border-r-0">
                    {pad(h)}:00
                  </div>
                ))}
              </div>

              {/* Lift rows */}
              {lifts.map(lift => (
                <div key={lift.id} className="grid border-b border-border last:border-b-0" style={{ gridTemplateColumns: `${SIDEBAR_W}px repeat(${HOURS.length}, 1fr)` }}>
                  <div className="px-3 py-3 text-sm font-medium text-foreground bg-secondary border-r border-border flex items-center">
                    {lift.name}
                  </div>
                  <DroppableLiftRow
                    liftId={lift.id}
                    liftSlots={slotsByLift.get(lift.id) ?? EMPTY_SLOTS}
                    ghost={ghost}
                    onRemove={removeSlot}
                    onResizeStart={handleResizeStart}
                    onDrawStart={handleDrawStart}
                  />
                </div>
              ))}
            </div>
          </DndContext>
        </>
      )}

      {/* Unassigned slots */}
      {unassignedSlots.length > 0 && (
        <div className="mt-6 bg-surface border border-border rounded-xl p-5">
          <h3 className="font-semibold text-foreground mb-3 text-sm">Без підйомника</h3>
          <div className="space-y-2">
            {unassignedSlots.map(s => (
              <div key={s.id} className="flex items-center justify-between px-3 py-2 bg-secondary rounded-lg">
                <div>
                  <span className="text-sm text-foreground">{fmtTime(s.startAt)} – {fmtTime(s.endAt)}</span>
                  {s.workOrderNumber && <span className="ml-2 text-xs text-primary">Наряд {s.workOrderNumber}</span>}
                  {s.counterpartyName && <span className="ml-2 text-xs text-muted-foreground">{s.counterpartyName}</span>}
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
    </div>
  );
}
