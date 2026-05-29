'use client';

import {
  useEffect, useState, useCallback, useMemo, useRef, memo,
  type CSSProperties, type PointerEvent as ReactPointerEvent,
} from 'react';
import { Plus, ChevronLeft, ChevronRight, Trash2, X, UserPlus, FilePlus, Search } from 'lucide-react';
import { useRequireAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api-client';
import { getCached, setCache } from '@/lib/ref-cache';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { DatePickerInput } from '@/components/ui/date-picker-input';
import { Spinner } from '@/components/ui/spinner';
import { SearchPickerModal, type SearchPickerItem } from '@/components/ui/search-picker-modal';
import { Modal } from '@/components/ui/modal';
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
interface CounterpartyOption { id: string; firstName?: string | null; lastName?: string | null; companyName?: string | null; phone?: string | null; }
interface VehicleOption { id: string; make: string; model: string; licensePlate: string; }

// Pending (not yet saved) slot drawn on the grid
interface PendingSlot { liftId: string; startH: number; endH: number; }

// Ghost while actively drawing (finger still down)
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

// Resize state for pending slot edges
interface PendingResizeState {
  edge: 'start' | 'end';
  origStartH: number;
  origEndH: number;
  pointerStartX: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const KYIV_TZ = 'Europe/Kyiv';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOURS = Array.from({ length: 12 }, (_, i) => i + 8);
const TOTAL_HOURS = HOURS.length;
const SIDEBAR_W = 160;
const WINDOW_START = HOURS[0];
const WINDOW_END   = HOURS[HOURS.length - 1] + 1;

// Time picker: exactly the working hours window (08–19)
const PICK_HOURS = HOURS; // [8, 9, ..., 19]
const PICK_MINUTES = [0, 15, 30, 45];

// Parse "HH:mm" → { h, m } snapped to nearest 15min
function parseHHMM(s: string): { h: number; m: number } {
  const [hh, mm] = s.split(':').map(Number);
  const snapped = Math.round((mm ?? 0) / 15) * 15;
  return { h: hh ?? HOURS[0], m: snapped >= 60 ? 0 : snapped };
}

function buildHHMM(h: number, m: number): string {
  return `${pad(h)}:${pad(m)}`;
}

function displayCounterparty(cp: CounterpartyOption): string {
  return cp.companyName ?? ([cp.lastName, cp.firstName].filter(Boolean).join(' ') || '(без імені)');
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function pad(n: number) { return String(n).padStart(2, '0'); }

// Module-level cached Intl formatters — constructing Intl.DateTimeFormat is expensive
// (locale-data init); kyivHours/fmtTime are called per-slot per-render, so reuse one instance.
const DATE_FMT = new Intl.DateTimeFormat('sv-SE', { timeZone: KYIV_TZ });
const KYIV_HM_FMT = new Intl.DateTimeFormat('en-US', { timeZone: KYIV_TZ, hour: 'numeric', minute: 'numeric', hour12: false });
const KYIV_HOUR_FMT = new Intl.DateTimeFormat('en-US', { timeZone: KYIV_TZ, hour: 'numeric', hour12: false });
const TIME_FMT = new Intl.DateTimeFormat('uk-UA', { timeZone: KYIV_TZ, hour: '2-digit', minute: '2-digit', hour12: false });

function toDateString(d: Date) { return DATE_FMT.format(d); }

function kyivHours(iso: string): number {
  const parts = KYIV_HM_FMT.formatToParts(new Date(iso));
  const h = parseInt(parts.find(p => p.type === 'hour')?.value ?? '0', 10);
  const m = parseInt(parts.find(p => p.type === 'minute')?.value ?? '0', 10);
  return h + m / 60;
}

function fmtTime(iso: string) {
  return TIME_FMT.format(new Date(iso));
}

function decimalHoursToHHMM(h: number): string {
  const totalMin = Math.min(24 * 60, Math.max(0, Math.round(h * 60)));
  return `${pad(Math.floor(totalMin / 60))}:${pad(totalMin % 60)}`;
}

function decimalHoursToISO(date: string, h: number): string {
  return new Date(`${date}T${decimalHoursToHHMM(h)}:00`).toISOString();
}

function snapTo15(h: number): number {
  return Math.round(h * 4) / 4;
}

function pxToHours(px: number, timelineW: number): number {
  return (px / timelineW) * TOTAL_HOURS;
}

// ─── TimeSelect — hour + minute selects, 15-min step, bounded range ──────────

interface TimeSelectProps {
  value: string;      // "HH:mm"
  onChange: (v: string) => void;
  minHour?: number;   // hours before this are disabled (past hours on today)
  minMinute?: number; // when h === minHour, minutes before this are disabled (current minute on today)
}

function TimeSelect({ value, onChange, minHour = 0, minMinute = 0 }: TimeSelectProps) {
  const { h, m } = value ? parseHHMM(value) : { h: HOURS[0], m: 0 };
  const cls = 'w-1/2 rounded-lg border border-border bg-surface px-2 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-50';
  return (
    <div className="flex gap-1">
      <select className={cls} value={h} onChange={e => onChange(buildHHMM(Number(e.target.value), m))}>
        {PICK_HOURS.map(hh => (
          <option key={hh} value={hh} disabled={hh < minHour}>{pad(hh)}</option>
        ))}
      </select>
      <select className={cls} value={m} onChange={e => onChange(buildHHMM(h, Number(e.target.value)))}>
        {PICK_MINUTES.map(mm => (
          <option key={mm} value={mm} disabled={h === minHour && mm < minMinute}>
            {pad(mm)}
          </option>
        ))}
      </select>
    </div>
  );
}

// ─── DraggableSlot ───────────────────────────────────────────────────────────

interface DraggableSlotProps {
  slot: CalendarSlot;
  isEditing: boolean;
  onRemove: (id: string) => void;
  onEdit: (slot: CalendarSlot) => void;
  onResizeStart: (e: ReactPointerEvent<HTMLDivElement>, slotId: string, edge: 'start' | 'end') => void;
}

const DraggableSlot = memo(function DraggableSlot({ slot, isEditing, onRemove, onEdit, onResizeStart }: DraggableSlotProps) {
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
      className={`absolute top-1 bottom-1 rounded text-white text-xs flex items-center overflow-hidden group select-none ring-2 ring-offset-1 ${isEditing ? 'bg-amber-500 ring-amber-400' : 'bg-primary ring-transparent'}`}
      title={label}
    >
      <div
        className="absolute left-0 top-0 bottom-0 w-2 cursor-col-resize z-20 hover:bg-white/20 rounded-l flex items-center justify-center"
        onPointerDown={e => { e.stopPropagation(); onResizeStart(e, slot.id, 'start'); }}
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
        onPointerDown={e => { e.stopPropagation(); onResizeStart(e, slot.id, 'end'); }}
        aria-label="Змінити кінець"
      >
        <div className="w-0.5 h-4 bg-white/50 rounded" />
      </div>
    </div>
  );
});

// ─── PendingSlotBlock — saved on grid, clickable to open form ────────────────

interface PendingSlotBlockProps {
  pending: PendingSlot;
  onOpen: () => void;
  onCancel: () => void;
  onPendingResizeStart: (e: ReactPointerEvent<HTMLDivElement>, edge: 'start' | 'end') => void;
}

const PENDING_DRAG_ID = '__pending__';

const PendingSlotBlock = memo(function PendingSlotBlock({
  pending, onOpen, onCancel, onPendingResizeStart,
}: PendingSlotBlockProps) {
  const left  = ((pending.startH - HOURS[0]) / TOTAL_HOURS) * 100;
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
      {/* Left resize handle */}
      <div
        className="absolute left-0 top-0 bottom-0 w-2 cursor-col-resize z-20 hover:bg-primary/20 rounded-l flex items-center justify-center"
        onPointerDown={e => { e.stopPropagation(); onPendingResizeStart(e, 'start'); }}
        aria-label="Змінити початок"
      >
        <div className="w-0.5 h-4 bg-primary/60 rounded" />
      </div>

      {/* Draggable + clickable label */}
      <span
        className="flex-1 text-xs text-primary font-medium px-3 truncate cursor-grab active:cursor-grabbing"
        onClick={onOpen}
        {...listeners}
        {...attributes}
      >
        {decimalHoursToHHMM(pending.startH)}–{decimalHoursToHHMM(pending.endH)}
      </span>

      {/* Cancel button */}
      <button
        onPointerDown={e => e.stopPropagation()}
        onClick={e => { e.stopPropagation(); onCancel(); }}
        className="mr-1 opacity-0 group-hover:opacity-100 text-primary/70 hover:text-primary shrink-0"
        aria-label="Скасувати"
      >
        <X className="h-3 w-3" />
      </button>

      {/* Right resize handle */}
      <div
        className="absolute right-0 top-0 bottom-0 w-2 cursor-col-resize z-20 hover:bg-primary/20 rounded-r flex items-center justify-center"
        onPointerDown={e => { e.stopPropagation(); onPendingResizeStart(e, 'end'); }}
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
  blockedWidth: number; // % of timeline width that is in the past (0 = nothing blocked)
  onRemove: (id: string) => void;
  onEdit: (slot: CalendarSlot) => void;
  onResizeStart: (e: ReactPointerEvent<HTMLDivElement>, slotId: string, edge: 'start' | 'end') => void;
  onPendingOpen: () => void;
  onPendingCancel: () => void;
  onPendingResizeStart: (e: ReactPointerEvent<HTMLDivElement>, edge: 'start' | 'end') => void;
}

const DroppableLiftRow = memo(function DroppableLiftRow({
  liftId, liftSlots, ghost, pending, editingSlotId, blockedWidth,
  onRemove, onEdit, onResizeStart,
  onPendingOpen, onPendingCancel, onPendingResizeStart,
}: DroppableLiftRowProps) {
  const { setNodeRef, isOver } = useDroppable({ id: `lift-${liftId}`, data: { liftId } });

  const showGhost = ghost?.liftId === liftId && ghost.endH > ghost.startH;
  const ghostLeft  = showGhost ? ((ghost!.startH - HOURS[0]) / TOTAL_HOURS) * 100 : 0;
  const ghostWidth = showGhost ? ((ghost!.endH - ghost!.startH) / TOTAL_HOURS) * 100 : 0;
  const showPending = pending?.liftId === liftId;

  return (
    <div
      ref={setNodeRef}
      className={`col-span-12 relative min-h-12 transition-colors ${isOver ? 'bg-primary/5' : ''}`}
      style={{ gridColumn: `2 / span ${TOTAL_HOURS}` }}
      data-lift-id={liftId}
    >
      <div className="flex h-full pointer-events-none">
        {HOURS.map(h => (
          <div key={h} className="flex-1 border-r last:border-r-0 border-border min-h-12" />
        ))}
      </div>

      {/* Unavailable overlay — past dates (full) or past hours today (partial) */}
      {blockedWidth > 0 && (
        <div
          className="absolute inset-y-0 left-0 pointer-events-none z-1"
          style={{ width: `${blockedWidth}%` }}
          aria-hidden
        >
          {/* Base tint */}
          <div className="absolute inset-0 bg-foreground/[0.07]" />
          {/* Diagonal stripe pattern */}
          <div
            className="absolute inset-0 opacity-30"
            style={{
              backgroundImage: 'repeating-linear-gradient(135deg, transparent, transparent 4px, currentColor 4px, currentColor 5px)',
              color: 'var(--color-foreground)',
            }}
          />
          {/* Right border — boundary line */}
          {blockedWidth < 100 && (
            <div className="absolute inset-y-0 right-0 w-0.5 bg-foreground/20" />
          )}
        </div>
      )}

      {/* Ghost while actively drawing */}
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

      {/* Pending slot — stays on grid until saved or cancelled */}
      {showPending && (
        <PendingSlotBlock
          pending={pending!}
          onOpen={onPendingOpen}
          onCancel={onPendingCancel}
          onPendingResizeStart={onPendingResizeStart}
        />
      )}

      {liftSlots.map(s => (
        <DraggableSlot key={s.id} slot={s} isEditing={s.id === editingSlotId} onRemove={onRemove} onEdit={onEdit} onResizeStart={onResizeStart} />
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
  const [editingSlotId, setEditingSlotId] = useState<string | null>(null);
  const [form, setForm] = useState({
    liftId: '', employeeId: '',
    counterpartyId: '', counterpartyDisplay: '',
    workOrderId: '', workOrderDisplay: '',
    startAt: '', endAt: '', notes: '', normoHours: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Current Kyiv hour — used to disable past hours in TimeSelect on today
  const [nowMs, setNowMs] = useState(0);
  useEffect(() => {
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  // minHour: on today disable hours already passed; on other days no restriction
  const minHour = useMemo(() => {
    if (!date || !nowMs) return HOURS[0];
    const todayKyiv = toDateString(new Date(nowMs));
    if (date !== todayKyiv) return HOURS[0];
    const parts = KYIV_HOUR_FMT.formatToParts(new Date(nowMs));
    return parseInt(parts.find(p => p.type === 'hour')?.value ?? '8', 10);
  }, [date, nowMs]);

  // minMinute: current Kyiv minute on today (used to disable past minutes in the minHour slot)
  const minMinute = useMemo(() => (nowMs ? new Date(nowMs).getMinutes() : 0), [nowMs]);

  // Ghost while finger is down drawing
  const [ghost, setGhost] = useState<GhostSlot | null>(null);
  const drawingRef = useRef<{ liftId: string; startH: number } | null>(null);

  // Pending slot: drawn, stays on grid, awaiting form submit
  const [pendingSlot, setPendingSlot] = useState<PendingSlot | null>(null);
  const pendingSlotRef = useRef<PendingSlot | null>(null);
  pendingSlotRef.current = pendingSlot;

  // Resizing existing saved slot
  const [resizing, setResizing] = useState<ResizeState | null>(null);
  const [resizePreview, setResizePreview] = useState<{ id: string; startH: number; endH: number } | null>(null);

  // Resizing pending slot
  const [pendingResizing, setPendingResizing] = useState<PendingResizeState | null>(null);
  const pendingResizingRef = useRef<PendingResizeState | null>(null);
  pendingResizingRef.current = pendingResizing;

  const timelineRef = useRef<HTMLDivElement>(null);
  const mountedRef  = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  useEffect(() => { setDate(toDateString(new Date())); }, []);

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

  const pxToDecimalHours = useCallback((clientX: number): number => {
    const rect = timelineRef.current?.getBoundingClientRect();
    if (!rect) return HOURS[0];
    const timelineX = clientX - rect.left - SIDEBAR_W;
    const timelineW = rect.width - SIDEBAR_W;
    const raw = HOURS[0] + (timelineX / timelineW) * TOTAL_HOURS;
    return Math.max(HOURS[0], Math.min(HOURS[HOURS.length - 1], raw));
  }, []);

  const showAddRef = useRef(showAdd);
  showAddRef.current = showAdd;

  // minHour for today's date — used inside window pointer listeners (closure needs ref)
  const minHourRef = useRef(minHour);
  minHourRef.current = minHour;

  // ── Open form from pending slot ───────────────────────────────────────────

  const openFormFromPending = useCallback(() => {
    const p = pendingSlotRef.current;
    if (!p) return;
    setForm(f => ({
      ...f,
      liftId: p.liftId,
      startAt: decimalHoursToHHMM(p.startH),
      endAt:   decimalHoursToHHMM(p.endH),
      normoHours: String(+(p.endH - p.startH).toFixed(2)),
    }));
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
      liftId:              slot.liftId ?? '',
      employeeId:          slot.employeeId ?? '',
      counterpartyId:      '',
      counterpartyDisplay: cpDisp,
      workOrderId:         slot.workOrderId ?? '',
      workOrderDisplay:    woDisplay,
      startAt:    decimalHoursToHHMM(kyivHours(slot.startAt)),
      endAt:      decimalHoursToHHMM(kyivHours(slot.endAt)),
      normoHours: String(+(kyivHours(slot.endAt) - kyivHours(slot.startAt)).toFixed(2)),
      notes:      slot.notes ?? '',
    });
    setShowAdd(true);
  }, []);

  // ── Resize existing saved slot ────────────────────────────────────────────

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

  // ── Resize pending slot ───────────────────────────────────────────────────

  const handlePendingResizeStart = useCallback((e: ReactPointerEvent<HTMLDivElement>, edge: 'start' | 'end') => {
    e.stopPropagation();
    const p = pendingSlotRef.current;
    if (!p) return;
    setPendingResizing({
      edge,
      origStartH: p.startH,
      origEndH:   p.endH,
      pointerStartX: e.clientX,
    });
  }, []);

  // ── Global refs ───────────────────────────────────────────────────────────

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
      // Clicks on existing saved slots or pending slot resize handles — handled elsewhere
      if (target.closest('[data-calendar-slot]')) return;
      if (target.closest('[data-pending-slot]')) return;
      // If form is open — a click on grid discards pending and closes form
      if (showAddRef.current) {
        setPendingSlot(null);
        setShowAdd(false);
        setError('');
        return;
      }
      // Start drawing only on lift rows
      const liftRow = target.closest('[data-lift-id]') as HTMLElement | null;
      const liftId = liftRow?.dataset.liftId;
      if (!liftId) return;

      // Discard previous pending slot when starting a new draw
      setPendingSlot(null);

      // Past dates: block drawing entirely; today: clamp to current hour
      const todayKyiv = toDateString(new Date());
      if (dateRef.current < todayKyiv) return;
      const pastClamp = dateRef.current === todayKyiv ? minHourRef.current : HOURS[0];
      const startH = Math.max(snapTo15(pxToDecimalHours(e.clientX)), pastClamp);
      drawingRef.current = { liftId, startH };
      setGhost({ liftId, startH, endH: startH + 1 });
    };

    const onMove = (e: PointerEvent) => {
      // Drawing ghost
      if (drawingRef.current) {
        const curH = pxToDecimalHours(e.clientX);
        const { startH } = drawingRef.current;
        const endH = snapTo15(Math.max(curH, startH + 0.25));
        setGhost(g => g ? { ...g, endH } : null);
        return;
      }

      // Resizing pending slot
      const pr = pendingResizingRef.current;
      if (pr) {
        const rect = timelineRef.current?.getBoundingClientRect();
        if (!rect) return;
        const deltaH = pxToHours(e.clientX - pr.pointerStartX, rect.width - SIDEBAR_W);
        const todayKyiv2 = toDateString(new Date());
        const pastFloor = dateRef.current === todayKyiv2 ? minHourRef.current : WINDOW_START;
        if (pr.edge === 'start') {
          const newStartH = snapTo15(Math.max(pastFloor, Math.min(pr.origStartH + deltaH, pr.origEndH - 0.25)));
          setPendingSlot(p => p ? { ...p, startH: newStartH } : null);
        } else {
          const newEndH = snapTo15(Math.min(WINDOW_END, Math.max(pr.origEndH + deltaH, pr.origStartH + 0.25)));
          setPendingSlot(p => p ? { ...p, endH: newEndH } : null);
        }
        return;
      }

      // Resizing existing saved slot
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
      // ── Finish drawing → create pending slot ───────────────────────────
      if (drawingRef.current) {
        const { liftId, startH } = drawingRef.current;
        const rawEndH = pxToDecimalHours(e.clientX);
        // If user barely moved (< 15 min drag) — use 1-hour default
        const endH = (rawEndH - startH) >= 0.25
          ? snapTo15(rawEndH)
          : startH + 1;
        const clampedEnd = Math.min(endH, WINDOW_END);
        drawingRef.current = null;
        setGhost(null);
        setPendingSlot({ liftId, startH, endH: clampedEnd });
        // Immediately open form pre-filled with drawn times
        setForm(f => ({
          ...f,
          liftId,
          startAt: decimalHoursToHHMM(startH),
          endAt:   decimalHoursToHHMM(clampedEnd),
          normoHours: String(+(clampedEnd - startH).toFixed(2)),
        }));
        setShowAdd(true);
        return;
      }

      // ── Finish pending resize ──────────────────────────────────────────
      if (pendingResizingRef.current) {
        setPendingResizing(null);
        // Update form times if form is already open
        const p = pendingSlotRef.current;
        if (p && showAddRef.current) {
          setForm(f => ({
            ...f,
            startAt: decimalHoursToHHMM(p.startH),
            endAt:   decimalHoursToHHMM(p.endH),
            normoHours: String(+(p.endH - p.startH).toFixed(2)),
          }));
        }
        return;
      }

      // ── Finish saved slot resize → PATCH ──────────────────────────────
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
      if (pendingResizingRef.current) setPendingResizing(null);
      if (resizingRef.current) { setResizing(null); setResizePreview(null); }
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

  // ── Drag-and-drop (move existing slot) ───────────────────────────────────

  const handleDragEnd = useCallback(async (event: DragEndEvent) => {
    const { active, delta, over } = event;
    if (!active || !delta) return;

    // ── Pending slot drag ─────────────────────────────────────────────────
    if (active.id === PENDING_DRAG_ID) {
      const p = pendingSlotRef.current;
      if (!p) return;
      const containerWidth = timelineRef.current?.getBoundingClientRect().width ?? 0;
      if (!containerWidth) return;
      const timelineWidth = containerWidth - SIDEBAR_W;
      const shiftH = snapTo15((delta.x / timelineWidth) * TOTAL_HOURS);
      const newLiftId = over?.data?.current?.liftId ?? p.liftId;
      const newStartH = Math.max(WINDOW_START, Math.min(p.startH + shiftH, WINDOW_END - (p.endH - p.startH)));
      const newEndH   = newStartH + (p.endH - p.startH);
      setPendingSlot({ liftId: newLiftId, startH: newStartH, endH: newEndH });
      setForm(f => ({
        ...f,
        liftId: newLiftId,
        startAt: decimalHoursToHHMM(newStartH),
        endAt:   decimalHoursToHHMM(newEndH),
        normoHours: String(+(newEndH - newStartH).toFixed(2)),
      }));
      return;
    }

    // ── Saved slot drag ───────────────────────────────────────────────────
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
    const newStart  = new Date(origStart.getTime() + shiftMs);
    const newEnd    = new Date(origEnd.getTime()   + shiftMs);
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

  // ── Add slot (form submit) ────────────────────────────────────────────────

  const addSlot = async () => {
    if (!form.startAt || !form.endAt) { setError('Вкажіть час початку та завершення'); return; }
    if (form.endAt <= form.startAt)    { setError('Час завершення повинен бути після часу початку'); return; }
    if (!form.counterpartyId)          { setError('Оберіть клієнта'); return; }
    if (form.workOrderId && !UUID_RE.test(form.workOrderId)) { setError('Оберіть наряд зі списку'); return; }
    // New slots: block past dates entirely; on today block hours before current hour
    if (!editingSlotId && nowMs) {
      const todayKyiv = toDateString(new Date(nowMs));
      if (date < todayKyiv) { setError('Не можна створити запис у минулому'); return; }
      if (date === todayKyiv) {
        const slotHour = parseInt(form.startAt.split(':')[0] ?? '0', 10);
        if (slotHour < minHour) { setError('Не можна створити запис у минулому'); return; }
      }
    }
    setSaving(true); setError('');
    const body = {
      liftId:      form.liftId      || undefined,
      employeeId:  form.employeeId  || undefined,
      workOrderId: form.workOrderId || undefined,
      startAt: new Date(`${date}T${form.startAt}:00`).toISOString(),
      endAt:   new Date(`${date}T${form.endAt}:00`).toISOString(),
      notes: form.notes || undefined,
    };
    try {
      if (editingSlotId) {
        await apiFetch(`/calendar/slots/${editingSlotId}`, { method: 'PATCH', body: JSON.stringify(body) });
      } else {
        await apiFetch<CalendarSlot>('/calendar/slots', { method: 'POST', body: JSON.stringify(body) });
      }
      setShowAdd(false);
      setEditingSlotId(null);
      setPendingSlot(null);
      setForm({ liftId: '', employeeId: '', counterpartyId: '', counterpartyDisplay: '', workOrderId: '', workOrderDisplay: '', startAt: '', endAt: '', notes: '', normoHours: '' });
      setCpDisplay('');
      load();
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка'); }
    finally { setSaving(false); }
  };

  const removeSlot = useCallback(async (id: string) => {
    if (!confirm('Видалити слот?')) return;
    try { await apiFetch<void>(`/calendar/slots/${id}`, { method: 'DELETE' }); load(); }
    catch (e: unknown) { if (mountedRef.current) setError(e instanceof Error ? e.message : 'Помилка видалення'); }
  }, [load]);

  // ── Work-order search ─────────────────────────────────────────────────────

  // ── Counterparty search ───────────────────────────────────────────────────

  const [cpSearch, setCpSearch] = useState('');
  const [cpOptions, setCpOptions] = useState<CounterpartyOption[]>([]);
  const [cpLoading, setCpLoading] = useState(false);
  const [showCpDropdown, setShowCpDropdown] = useState(false);
  const [cpDisplay, setCpDisplay] = useState('');
  const cpTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // New counterparty wizard modal (3 steps: client → garage → vehicle)
  const [newCpOpen, setNewCpOpen] = useState(false);
  const [newCpStep, setNewCpStep] = useState<1 | 2>(1);
  const [newCp, setNewCp] = useState({ firstName: '', lastName: '', phone: '', companyName: '', email: '' });
  const [newVehicle, setNewVehicle] = useState({ make: '', model: '', year: '', licensePlate: '', vin: '' });
  const [savingCp, setSavingCp] = useState(false);
  const [cpWizardError, setCpWizardError] = useState('');
  const [createdCpId, setCreatedCpId] = useState('');
  const [createdGarageId, setCreatedGarageId] = useState('');

  const openNewCpWizard = () => {
    setNewCp({ firstName: '', lastName: '', phone: '', companyName: '', email: '' });
    setNewVehicle({ make: '', model: '', year: '', licensePlate: '', vin: '' });
    setCreatedCpId(''); setCreatedGarageId('');
    setCpWizardError(''); setNewCpStep(1);
    setNewCpOpen(true);
  };

  // Step 1: create counterparty → backend auto-creates default garage → fetch it
  const saveWizardStep1 = async () => {
    if (!newCp.firstName && !newCp.lastName && !newCp.companyName) {
      setCpWizardError("Вкажіть ім'я або назву компанії"); return;
    }
    setSavingCp(true); setCpWizardError('');
    try {
      const created = await apiFetch<CounterpartyOption>('/counterparties', {
        method: 'POST',
        body: JSON.stringify({
          type: 'CLIENT',
          firstName:   newCp.firstName   || undefined,
          lastName:    newCp.lastName    || undefined,
          phone:       newCp.phone       || undefined,
          companyName: newCp.companyName || undefined,
          email:       newCp.email       || undefined,
        }),
      });
      setCreatedCpId(created.id);
      // Fetch the auto-created default garage id (needed for vehicle linking)
      const garages = await apiFetch<{ id: string; isDefault: boolean }[]>(`/counterparties/${created.id}/garages`).catch(() => [] as { id: string; isDefault: boolean }[]);
      const defaultGarage = garages.find(g => g.isDefault) ?? garages[0];
      if (defaultGarage) setCreatedGarageId(defaultGarage.id);
      setNewCpStep(2);
    } catch (e: unknown) { setCpWizardError(e instanceof Error ? e.message : 'Помилка'); }
    finally { setSavingCp(false); }
  };

  // Step 2: optionally add vehicle to default garage, then finish
  const saveWizardStep2 = async (skip = false) => {
    if (!skip) {
      if (!newVehicle.make.trim() || !newVehicle.model.trim()) {
        setCpWizardError('Вкажіть марку та модель авто'); return;
      }
      setSavingCp(true); setCpWizardError('');
      try {
        await apiFetch('/vehicles', {
          method: 'POST',
          body: JSON.stringify({
            customerGarageId: createdGarageId,
            make: newVehicle.make,
            model: newVehicle.model,
            year: newVehicle.year ? Number(newVehicle.year) : undefined,
            licensePlate: newVehicle.licensePlate || undefined,
            vin: newVehicle.vin || undefined,
          }),
        });
      } catch (e: unknown) { setCpWizardError(e instanceof Error ? e.message : 'Помилка'); setSavingCp(false); return; }
      finally { setSavingCp(false); }
    }
    // Select created client in form
    const display = newCp.companyName || [newCp.lastName, newCp.firstName].filter(Boolean).join(' ') || '(без імені)';
    setCpDisplay(display);
    setForm(f => ({ ...f, counterpartyId: createdCpId, counterpartyDisplay: display }));
    setNewCpOpen(false);
  };

  useEffect(() => {
    if (!showAdd) { setCpSearch(''); setCpOptions([]); setCpDisplay(''); setNewCpOpen(false); }
  }, [showAdd]);

  const searchCounterparties = useCallback((q: string) => {
    if (cpTimeoutRef.current) clearTimeout(cpTimeoutRef.current);
    if (!q.trim()) { setCpOptions([]); setShowCpDropdown(false); return; }
    cpTimeoutRef.current = setTimeout(async () => {
      setCpLoading(true);
      try {
        const data = await apiFetch<{ items: CounterpartyOption[] }>(`/counterparties?q=${encodeURIComponent(q)}&limit=10`);
        if (mountedRef.current) { setCpOptions(data.items); setShowCpDropdown(true); }
      } catch { /* ignore */ }
      finally { if (mountedRef.current) setCpLoading(false); }
    }, 300);
  }, []);

  useEffect(() => { return () => { if (cpTimeoutRef.current) clearTimeout(cpTimeoutRef.current); }; }, []);

  // ── New work-order mini-form ──────────────────────────────────────────────

  const [showNewWo, setShowNewWo] = useState(false);
  const [newWo, setNewWo] = useState({ counterpartyId: '', counterpartyDisplay: '', vehicleId: '', branchId: '', description: '' });
  const [newWoVehicles, setNewWoVehicles] = useState<VehicleOption[]>([]);
  const [branches, setBranches] = useState<{ id: string; name: string }[]>([]);
  const [branchesError, setBranchesError] = useState('');
  const [savingWo, setSavingWo] = useState(false);

  useEffect(() => {
    if (!showAdd) { setShowNewWo(false); }
  }, [showAdd]);

  // Load branches once — surface errors so the required «Філія» select isn't silently empty (Bug #159)
  useEffect(() => {
    apiFetch<{ id: string; name: string }[]>('/branches')
      .then(d => { if (mountedRef.current) { setBranches(d); setBranchesError(''); } })
      .catch((e: unknown) => { if (mountedRef.current) setBranchesError(e instanceof Error ? e.message : 'Не вдалося завантажити список філій'); });
  }, []);

  const loadWoVehicles = useCallback(async (counterpartyId: string) => {
    if (!counterpartyId) { setNewWoVehicles([]); return; }
    try {
      const garages = await apiFetch<{ id: string }[]>(`/counterparties/${counterpartyId}/garages`);
      const vehicles = await Promise.all(garages.map(g =>
        apiFetch<VehicleOption[]>(`/vehicles?customerGarageId=${g.id}&limit=50`).catch(() => [] as VehicleOption[])
      ));
      setNewWoVehicles(vehicles.flat());
    } catch { setNewWoVehicles([]); }
  }, []);

  const saveNewWorkOrder = async () => {
    if (!newWo.counterpartyId || !newWo.vehicleId || !newWo.branchId) return;
    setSavingWo(true);
    try {
      const created = await apiFetch<WorkOrderOption>('/work-orders', {
        method: 'POST',
        body: JSON.stringify({
          counterpartyId: newWo.counterpartyId,
          vehicleId: newWo.vehicleId,
          branchId: newWo.branchId,
          description: newWo.description || undefined,
        }),
      });
      const display = `${created.number}${newWo.counterpartyDisplay ? ` · ${newWo.counterpartyDisplay}` : ''}`;
      setForm(f => ({ ...f, workOrderId: created.id, workOrderDisplay: display }));
      setShowNewWo(false);
      setNewWo({ counterpartyId: '', counterpartyDisplay: '', vehicleId: '', branchId: '', description: '' });
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка створення наряду'); }
    finally { setSavingWo(false); }
  };

  // ── Picker modals ─────────────────────────────────────────────────────────

  const [cpPickerOpen, setCpPickerOpen] = useState(false);
  const [woPickerOpen, setWoPickerOpen] = useState(false);
  // For new-WO form: counterparty picker inside it
  const [newWoCpPickerOpen, setNewWoCpPickerOpen] = useState(false);

  type CpItem = SearchPickerItem & { phone?: string | null };
  type WoItem = SearchPickerItem;

  const fetchCpItems = useCallback(async (q: string): Promise<CpItem[]> => {
    const url = q.trim() ? `/counterparties?q=${encodeURIComponent(q)}&limit=30` : '/counterparties?limit=30';
    const data = await apiFetch<{ items: CounterpartyOption[] }>(url);
    return data.items.map(cp => ({
      id: cp.id,
      primary: displayCounterparty(cp),
      secondary: cp.phone ?? undefined,
      phone: cp.phone,
    }));
  }, []);

  const fetchWoItems = useCallback(async (q: string): Promise<WoItem[]> => {
    const url = q.trim() ? `/work-orders?q=${encodeURIComponent(q)}&limit=30` : '/work-orders?limit=30';
    const data = await apiFetch<{ items: WorkOrderOption[] }>(url);
    return data.items.map(wo => ({
      id: wo.id,
      primary: wo.number,
      secondary: wo.counterpartyName ?? undefined,
    }));
  }, []);

  // ── Memoized grouping ─────────────────────────────────────────────────────

  const slotsWithPreview = useMemo(() => {
    if (!resizePreview) return slots;
    return slots.map(s => {
      if (s.id !== resizePreview.id) return s;
      const toISO = (h: number) => {
        const totalMin = Math.round(h * 60);
        return new Date(`${date}T${pad(Math.floor(totalMin / 60))}:${pad(totalMin % 60)}:00`).toISOString();
      };
      return { ...s, startAt: toISO(resizePreview.startH), endAt: toISO(resizePreview.endH) };
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

  // Next upcoming slot per lift — 'now' if currently active, ISO string if future, undefined if none
  const nextSlotByLift = useMemo(() => {
    const map = new Map<string, 'now' | string>();
    if (!nowMs) return map;
    const now = nowMs;
    for (const [liftId, liftSlots] of slotsByLift) {
      const active = liftSlots.find(s => new Date(s.startAt).getTime() <= now && new Date(s.endAt).getTime() > now);
      if (active) { map.set(liftId, 'now'); continue; }
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

  // Width (%) of the unavailable overlay: 100 for past dates, partial for today, 0 for future
  const blockedWidth = useMemo(() => {
    if (!nowMs || !date) return 0;
    const todayKyiv = toDateString(new Date(nowMs));
    if (date < todayKyiv) return 100;
    if (date > todayKyiv) return 0;
    // Today: block hours strictly before current hour
    const blockedHours = Math.max(0, minHour - WINDOW_START);
    return (blockedHours / TOTAL_HOURS) * 100;
  }, [nowMs, date, minHour]);

  const formatDate = (ds: string) => {
    if (!ds) return '';
    return new Date(ds).toLocaleDateString('uk-UA', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric', timeZone: KYIV_TZ });
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="page-container">
      <div className="page-header mb-6">
        <h1 className="page-title">Календар</h1>
        <Button onClick={() => { setPendingSlot(null); setShowAdd(v => !v); }}>
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
          <span className={`text-sm capitalize ${nowMs && date < toDateString(new Date(nowMs)) ? 'text-destructive-text font-medium' : 'text-muted-foreground'}`}>
            {formatDate(date)}
            {nowMs && date < toDateString(new Date(nowMs)) && ' — минулий день'}
          </span>
        </div>
        <Button variant="outline" size="sm" onClick={nextDay}>
          Наступний
          <ChevronRight className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setDate(toDateString(new Date()))}>
          Сьогодні
        </Button>
      </div>

      {/* Add / edit form */}
      {showAdd && (
        <div className="bg-surface border border-border rounded-xl p-5 mb-6 space-y-3">
          <h3 className="font-semibold text-foreground text-sm">
            {editingSlotId ? 'Редагування слоту' : pendingSlot ? `Новий слот ${decimalHoursToHHMM(pendingSlot.startH)}–${decimalHoursToHHMM(pendingSlot.endH)} на ${date}` : `Новий слот на ${date}`}
          </h3>
          {error && <p className="text-[13px] text-destructive-text">{error}</p>}

          <div className="grid grid-cols-4 gap-3">
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">Підйомник</label>
              <Select value={form.liftId} onChange={e => setForm(f => ({ ...f, liftId: e.target.value }))}>
                <option value="">— будь-який —</option>
                {lifts.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
              </Select>
            </div>
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">Початок</label>
              <TimeSelect
                value={form.startAt}
                minHour={editingSlotId ? HOURS[0] : minHour}
                minMinute={0}
                onChange={start => {
                  setForm(f => {
                    let next = { ...f, startAt: start };
                    if (start && f.normoHours && Number(f.normoHours) > 0) {
                      const [h, m] = start.split(':').map(Number);
                      const totalMin = Math.min(h * 60 + m + Math.round(Number(f.normoHours) * 60), 23 * 60 + 59);
                      const em = Math.round((totalMin % 60) / 15) * 15;
                      next = { ...next, endAt: `${pad(Math.floor(totalMin / 60))}:${pad(em >= 60 ? 0 : em)}` };
                    }
                    // sync pending slot on grid
                    if (pendingSlotRef.current) {
                      const { h: sh, m: sm } = parseHHMM(start);
                      const { h: eh, m: em } = parseHHMM(next.endAt || start);
                      setPendingSlot(p => p ? { ...p, startH: sh + sm / 60, endH: eh + em / 60 } : p);
                    }
                    return next;
                  });
                }}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">
                Норм-год <span className="font-normal text-muted-foreground/70">(авто кінець)</span>
              </label>
              <Input
                type="number" step="0.5" min="0.5" value={form.normoHours}
                onChange={e => {
                  const nh = e.target.value;
                  setForm(f => {
                    if (f.startAt && nh && Number(nh) > 0) {
                      const [h, m] = f.startAt.split(':').map(Number);
                      const totalMin = Math.min(h * 60 + m + Math.round(Number(nh) * 60), 23 * 60 + 59);
                      const em = Math.round((totalMin % 60) / 15) * 15;
                      const endAt = `${pad(Math.floor(totalMin / 60))}:${pad(em >= 60 ? 0 : em)}`;
                      if (pendingSlotRef.current) {
                        const { h: eh, m: em2 } = parseHHMM(endAt);
                        setPendingSlot(p => p ? { ...p, endH: eh + em2 / 60 } : p);
                      }
                      return { ...f, normoHours: nh, endAt };
                    }
                    return { ...f, normoHours: nh };
                  });
                }}
                placeholder="1.5"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">Кінець</label>
              <TimeSelect
                value={form.endAt}
                minHour={editingSlotId ? HOURS[0] : minHour}
                minMinute={0}
                onChange={endAt => {
                  setForm(f => ({ ...f, endAt }));
                  if (pendingSlotRef.current) {
                    const { h, m } = parseHHMM(endAt);
                    setPendingSlot(p => p ? { ...p, endH: h + m / 60 } : p);
                  }
                }}
              />
            </div>
          </div>

          {/* Client + Work-order row */}
          <div className="grid grid-cols-2 gap-3">
            {/* Клієнт */}
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">Клієнт <span className="text-destructive-text">*</span></label>
              <div className="flex gap-1">
                <button
                  type="button"
                  onClick={() => setCpPickerOpen(true)}
                  className="flex-1 flex items-center justify-between gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-left hover:border-primary transition-colors min-w-0"
                >
                  <span className={form.counterpartyDisplay ? 'text-foreground truncate' : 'text-muted-foreground'}>
                    {form.counterpartyDisplay || 'Обрати клієнта…'}
                  </span>
                  <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                </button>
                {form.counterpartyDisplay && (
                  <button type="button" onClick={() => { setCpDisplay(''); setForm(f => ({ ...f, counterpartyId: '', counterpartyDisplay: '' })); }}
                    className="px-2 text-muted-foreground hover:text-foreground" aria-label="Очистити">
                    <X className="h-4 w-4" />
                  </button>
                )}
                <Button variant="outline" size="sm" onClick={openNewCpWizard} title="Новий клієнт">
                  <UserPlus className="h-4 w-4" />
                </Button>
              </div>
            </div>

            {/* Наряд */}
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">Наряд</label>
              <div className="flex gap-1">
                <button
                  type="button"
                  onClick={() => setWoPickerOpen(true)}
                  className="flex-1 flex items-center justify-between gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-left hover:border-primary transition-colors min-w-0"
                >
                  <span className={form.workOrderDisplay ? 'text-foreground truncate' : 'text-muted-foreground'}>
                    {form.workOrderDisplay || 'Обрати наряд…'}
                  </span>
                  <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                </button>
                {form.workOrderDisplay && (
                  <button type="button" onClick={() => setForm(f => ({ ...f, workOrderId: '', workOrderDisplay: '' }))}
                    className="px-2 text-muted-foreground hover:text-foreground" aria-label="Очистити">
                    <X className="h-4 w-4" />
                  </button>
                )}
                <Button variant="outline" size="sm" onClick={() => setShowNewWo(v => !v)} title="Новий наряд">
                  <FilePlus className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </div>

          {/* New client wizard modal */}
          <Modal
            open={newCpOpen}
            onClose={() => setNewCpOpen(false)}
            title={newCpStep === 1 ? 'Новий клієнт' : 'Автомобіль клієнта'}
            size="md"
          >
            {/* Step indicator — 2 steps */}
            <div className="flex items-center gap-2 mb-5">
              {([1, 2] as const).map(s => (
                <div key={s} className="flex items-center gap-2">
                  <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-semibold ${s === newCpStep ? 'bg-primary text-primary-foreground' : s < newCpStep ? 'bg-success-text text-white' : 'bg-secondary text-muted-foreground border border-border'}`}>
                    {s < newCpStep ? '✓' : s}
                  </div>
                  <span className={`text-xs ${s === newCpStep ? 'text-foreground font-medium' : 'text-muted-foreground'}`}>
                    {s === 1 ? 'Клієнт' : 'Авто'}
                  </span>
                  {s < 2 && <div className="w-8 h-px bg-border mx-1" />}
                </div>
              ))}
            </div>

            {cpWizardError && (
              <p className="text-sm text-destructive-text bg-destructive-subtle border border-destructive/20 rounded-lg px-3 py-2 mb-4">{cpWizardError}</p>
            )}

            {/* Step 1 — Client (garage «Основний» created automatically by backend) */}
            {newCpStep === 1 && (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <Input label="Ім'я" placeholder="Іван" value={newCp.firstName} onChange={e => setNewCp(v => ({ ...v, firstName: e.target.value }))} />
                  <Input label="Прізвище" placeholder="Коваль" value={newCp.lastName} onChange={e => setNewCp(v => ({ ...v, lastName: e.target.value }))} />
                </div>
                <Input label="Назва компанії" placeholder="ТОВ «Авто»" value={newCp.companyName} onChange={e => setNewCp(v => ({ ...v, companyName: e.target.value }))} />
                <div className="grid grid-cols-2 gap-3">
                  <Input label="Телефон" placeholder="+38 (067) 123-45-67" value={newCp.phone} onChange={e => setNewCp(v => ({ ...v, phone: e.target.value }))} />
                  <Input label="Email" type="email" placeholder="ivan@example.com" value={newCp.email} onChange={e => setNewCp(v => ({ ...v, email: e.target.value }))} />
                </div>
                <div className="flex gap-2 pt-2">
                  <Button onClick={saveWizardStep1} loading={savingCp} disabled={!newCp.firstName && !newCp.lastName && !newCp.companyName}>
                    Далі →
                  </Button>
                  <Button variant="outline" onClick={() => setNewCpOpen(false)}>Скасувати</Button>
                </div>
              </div>
            )}

            {/* Step 2 — Vehicle (optional) */}
            {newCpStep === 2 && (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <Input label="Марка" placeholder="Toyota" value={newVehicle.make} onChange={e => setNewVehicle(v => ({ ...v, make: e.target.value }))} />
                  <Input label="Модель" placeholder="Camry" value={newVehicle.model} onChange={e => setNewVehicle(v => ({ ...v, model: e.target.value }))} />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <Input label="Рік" placeholder="2021" value={newVehicle.year} onChange={e => setNewVehicle(v => ({ ...v, year: e.target.value }))} />
                  <Input label="Держ. номер" placeholder="АА 1234 ВВ" value={newVehicle.licensePlate} onChange={e => setNewVehicle(v => ({ ...v, licensePlate: e.target.value }))} />
                </div>
                <Input label="VIN (необов'язково)" placeholder="1HGBH41JXMN109186" value={newVehicle.vin} onChange={e => setNewVehicle(v => ({ ...v, vin: e.target.value }))} />
                <div className="flex gap-2 pt-2">
                  <Button onClick={() => saveWizardStep2(false)} loading={savingCp} disabled={!newVehicle.make.trim() || !newVehicle.model.trim()}>
                    Зберегти
                  </Button>
                  <Button variant="outline" onClick={() => saveWizardStep2(true)}>Пропустити</Button>
                </div>
              </div>
            )}
          </Modal>

          {/* New work-order mini-form */}
          {showNewWo && (
            <div className="bg-secondary rounded-lg p-3 space-y-2 border border-border">
              <p className="text-xs font-medium text-foreground">Новий наряд</p>
              <div className="flex gap-1">
                <button type="button" onClick={() => setNewWoCpPickerOpen(true)}
                  className="flex-1 flex items-center justify-between gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-left hover:border-primary transition-colors">
                  <span className={newWo.counterpartyDisplay ? 'text-foreground truncate' : 'text-muted-foreground'}>
                    {newWo.counterpartyDisplay || 'Обрати клієнта…'}
                  </span>
                  <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                </button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Select value={newWo.vehicleId} onChange={e => setNewWo(v => ({ ...v, vehicleId: e.target.value }))}
                  disabled={!newWo.counterpartyId}>
                  <option value="">— Автомобіль —</option>
                  {newWoVehicles.map(v => (
                    <option key={v.id} value={v.id}>{v.make} {v.model} ({v.licensePlate})</option>
                  ))}
                </Select>
                <Select value={newWo.branchId} onChange={e => setNewWo(v => ({ ...v, branchId: e.target.value }))}>
                  <option value="">— Філія —</option>
                  {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                </Select>
              </div>
              {branchesError && <p className="text-xs text-destructive-text">{branchesError}</p>}
              <Input placeholder="Опис (необов'язково)" value={newWo.description}
                onChange={e => setNewWo(v => ({ ...v, description: e.target.value }))} />
              <div className="flex gap-2">
                <Button size="sm" onClick={saveNewWorkOrder} loading={savingWo}
                  disabled={!newWo.counterpartyId || !newWo.vehicleId || !newWo.branchId}>
                  Зберегти наряд
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setShowNewWo(false)}>Скасувати</Button>
              </div>
            </div>
          )}

          {/* Notes */}
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">Нотатки</label>
            <Input value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
          </div>

          {/* Picker modals */}
          <SearchPickerModal<CpItem>
            open={cpPickerOpen}
            onClose={() => setCpPickerOpen(false)}
            title="Оберіть клієнта"
            selectedId={form.counterpartyId}
            fetchItems={fetchCpItems}
            searchPlaceholder="Ім'я, телефон, компанія..."
            emptyText="Клієнтів не знайдено"
            onSelect={item => {
              setCpDisplay(item.primary);
              setForm(f => ({ ...f, counterpartyId: item.id, counterpartyDisplay: item.primary }));
            }}
          />
          <SearchPickerModal<WoItem>
            open={woPickerOpen}
            onClose={() => setWoPickerOpen(false)}
            title="Оберіть наряд"
            selectedId={form.workOrderId}
            fetchItems={fetchWoItems}
            searchPlaceholder="Номер наряду або клієнт..."
            emptyText="Нарядів не знайдено"
            onSelect={item => {
              const display = item.secondary ? `${item.primary} · ${item.secondary}` : item.primary;
              setForm(f => ({ ...f, workOrderId: item.id, workOrderDisplay: display }));
            }}
          />
          <SearchPickerModal<CpItem>
            open={newWoCpPickerOpen}
            onClose={() => setNewWoCpPickerOpen(false)}
            title="Клієнт для наряду"
            selectedId={newWo.counterpartyId}
            fetchItems={fetchCpItems}
            searchPlaceholder="Ім'я, телефон..."
            emptyText="Клієнтів не знайдено"
            onSelect={async item => {
              setNewWo(v => ({ ...v, counterpartyId: item.id, counterpartyDisplay: item.primary, vehicleId: '' }));
              await loadWoVehicles(item.id);
            }}
          />

          <div className="flex gap-2">
            <Button onClick={addSlot} loading={saving} disabled={!form.startAt || !form.endAt || !form.counterpartyId}>
              {editingSlotId ? 'Оновити' : 'Зберегти'}
            </Button>
            <Button variant="outline" onClick={() => { setShowAdd(false); setEditingSlotId(null); setError(''); setPendingSlot(null); }}>
              Скасувати
            </Button>
          </div>
        </div>
      )}

      {/* Hint */}
      {!loading && lifts.length > 0 && !pendingSlot && !showAdd && (
        <p className="text-xs text-muted-foreground mb-2">
          Затисніть і перетягніть по рядку підйомника щоб створити слот. Тягніть краї для зміни тривалості. Натисніть на проміжок щоб зберегти.
        </p>
      )}
      {pendingSlot && !showAdd && (
        <p className="text-xs text-primary mb-2 font-medium">
          ↑ Налаштуйте проміжок і натисніть на нього щоб відкрити форму збереження.
        </p>
      )}

      {/* Timeline grid */}
      {loading && <div className="flex justify-center py-8"><Spinner size="md" /></div>}

      {!loading && lifts.length === 0 && (
        <div className="bg-surface border border-border rounded-xl p-8 text-center text-sm text-muted-foreground">
          Немає підйомників. Додайте їх у розділі <a href="/infrastructure" className="text-primary hover:underline">Інфраструктура</a>.
        </div>
      )}

      {!loading && lifts.length > 0 && (
        <DndContext sensors={sensors} onDragEnd={e => { void handleDragEnd(e); }}>
          <div ref={timelineRef} className="bg-surface border border-border rounded-xl overflow-hidden">
            <div className="grid border-b border-border" style={{ gridTemplateColumns: `${SIDEBAR_W}px repeat(${HOURS.length}, 1fr)` }}>
              <div className="px-3 py-2 text-xs font-medium text-muted-foreground bg-secondary border-r border-border">Підйомник</div>
              {HOURS.map(h => (
                <div key={h} className="px-1 py-2 text-xs text-center text-muted-foreground bg-secondary border-r border-border last:border-r-0">
                  {pad(h)}:00
                </div>
              ))}
            </div>

            {lifts.map(lift => (
              <div key={lift.id} className="grid border-b border-border last:border-b-0" style={{ gridTemplateColumns: `${SIDEBAR_W}px repeat(${HOURS.length}, 1fr)` }}>
                <div className="px-3 py-3 bg-secondary border-r border-border flex flex-col justify-center gap-0.5">
                  <span className="text-sm font-medium text-foreground leading-tight">{lift.name}</span>
                  {nextSlotByLift.get(lift.id) === 'now' ? (
                    <span className="text-[10px] font-medium text-success-text leading-none">● зараз</span>
                  ) : nextSlotByLift.has(lift.id) ? (
                    <span className="text-[10px] text-muted-foreground leading-none">↓ {fmtTime(nextSlotByLift.get(lift.id)!)}</span>
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
