'use client';

import { useEffect, useState, useCallback, useRef, memo, type CSSProperties } from 'react';
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

interface CalendarSlot {
  id: string;
  liftId?: string | null;
  employeeId?: string | null;
  workOrderId?: string | null;
  startAt: string;
  endAt: string;
  notes?: string | null;
  workOrderNumber?: string;
}
interface Lift { id: string; name: string; }

const KYIV_TZ = 'Europe/Kyiv';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

const HOURS = Array.from({ length: 12 }, (_, i) => i + 8); // 08:00–19:00
const TOTAL_HOURS = HOURS.length;

// ─── DnD helpers ─────────────────────────────────────────────────────────────

interface DraggableSlotProps {
  slot: CalendarSlot;
  onRemove: (id: string) => void;
}
const DraggableSlot = memo(function DraggableSlot({ slot, onRemove }: DraggableSlotProps) {
  const startH = kyivHours(slot.startAt);
  const endH   = kyivHours(slot.endAt);
  const left  = ((startH - HOURS[0]) / TOTAL_HOURS) * 100;
  const width = ((endH - startH)     / TOTAL_HOURS) * 100;

  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: slot.id, data: { slot } });
  const style: CSSProperties = {
    left:      `${left}%`,
    width:     `${width}%`,
    transform: CSS.Translate.toString(transform),
    opacity:   isDragging ? 0.5 : 1,
    zIndex:    isDragging ? 50 : 10,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...listeners}
      {...attributes}
      className="absolute top-1 bottom-1 bg-primary rounded text-white text-xs flex items-center px-1.5 overflow-hidden cursor-grab active:cursor-grabbing hover:opacity-90 group"
      title={slot.workOrderNumber ? `Наряд ${slot.workOrderNumber}` : slot.notes ?? ''}
    >
      <span className="truncate select-none">{fmtTime(slot.startAt)}–{fmtTime(slot.endAt)}{slot.workOrderNumber ? ` · ${slot.workOrderNumber}` : ''}</span>
      <button
        onPointerDown={e => e.stopPropagation()}
        onClick={() => onRemove(slot.id)}
        className="ml-auto opacity-0 group-hover:opacity-100 text-white/80 hover:text-white px-0.5"
        aria-label="Видалити слот"
      >
        <Trash2 className="h-3 w-3" />
      </button>
    </div>
  );
});

interface DroppableLiftRowProps {
  liftId: string;
  liftSlots: CalendarSlot[];
  onRemove: (id: string) => void;
}
const DroppableLiftRow = memo(function DroppableLiftRow({ liftId, liftSlots, onRemove }: DroppableLiftRowProps) {
  const { setNodeRef, isOver } = useDroppable({ id: `lift-${liftId}`, data: { liftId } });

  return (
    <div
      ref={setNodeRef}
      className={`col-span-12 relative min-h-12 transition-colors ${isOver ? 'bg-primary/5' : ''}`}
      style={{ gridColumn: `2 / span ${TOTAL_HOURS}` }}
    >
      <div className="flex h-full">
        {HOURS.map(h => (
          <div key={h} className="flex-1 border-r last:border-r-0 border-border min-h-12" />
        ))}
      </div>
      {liftSlots.map(s => (
        <DraggableSlot key={s.id} slot={s} onRemove={onRemove} />
      ))}
    </div>
  );
});

// ─────────────────────────────────────────────────────────────────────────────

export default function CalendarPage() {
  useRequireAuth(['OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC']);

  const [date, setDate] = useState('');
  const [slots, setSlots] = useState<CalendarSlot[]>([]);
  const [loading, setLoading] = useState(true);
  const [lifts, setLifts] = useState<Lift[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ liftId: '', employeeId: '', workOrderId: '', startAt: '', endAt: '', notes: '', normoHours: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const timelineRef = useRef<HTMLDivElement>(null);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => { setDate(toDateString(new Date())); }, []);

  useEffect(() => {
    // Reference data — paint instantly from sessionStorage, refresh in background.
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

  const addSlot = async () => {
    if (!form.startAt || !form.endAt) {
      setError('Вкажіть час початку та завершення'); return;
    }
    if (form.endAt <= form.startAt) {
      setError('Час завершення повинен бути після часу початку'); return;
    }
    if (form.workOrderId && !UUID_RE.test(form.workOrderId)) {
      setError('ID наряду має бути у форматі UUID (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)'); return;
    }
    if (form.employeeId && !UUID_RE.test(form.employeeId)) {
      setError('ID співробітника має бути у форматі UUID'); return;
    }
    setSaving(true); setError('');
    try {
      await apiFetch<CalendarSlot>('/calendar/slots', {
        method: 'POST',
        body: JSON.stringify({
          liftId: form.liftId || undefined,
          employeeId: form.employeeId || undefined,
          workOrderId: form.workOrderId || undefined,
          startAt: form.startAt ? new Date(`${date}T${form.startAt}:00`).toISOString() : undefined,
          endAt: form.endAt ? new Date(`${date}T${form.endAt}:00`).toISOString() : undefined,
          notes: form.notes || undefined,
        }),
      });
      setShowAdd(false);
      setForm({ liftId: '', employeeId: '', workOrderId: '', startAt: '', endAt: '', notes: '', normoHours: '' });
      load();
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка'); }
    finally { setSaving(false); }
  };

  const removeSlot = useCallback(async (id: string) => {
    if (!confirm('Видалити слот?')) return;
    setSaving(true); setError('');
    try { await apiFetch<void>(`/calendar/slots/${id}`, { method: 'DELETE' }); load(); }
    catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка видалення'); }
    finally { setSaving(false); }
  }, [load]);

  const handleDragEnd = useCallback(async (event: DragEndEvent) => {
    const { active, delta, over } = event;
    if (!active || !delta) return;

    const slot = slots.find(s => s.id === active.id);
    if (!slot) return;

    // Determine new liftId from drop target (if dropped onto a different lift row)
    const newLiftId: string | null = over?.data?.current?.liftId ?? slot.liftId ?? null;

    // Calculate time shift from horizontal drag delta
    const containerWidth = timelineRef.current?.getBoundingClientRect().width ?? 0;
    if (!containerWidth) return;

    // timeline area excludes the 160px lift-label column
    const timelineWidth = containerWidth - 160;
    const hoursPer100Px = TOTAL_HOURS / timelineWidth;
    const shiftHours = delta.x * hoursPer100Px;

    if (Math.abs(shiftHours) < 0.08 && newLiftId === slot.liftId) return; // negligible move

    const origStart = new Date(slot.startAt);
    const origEnd   = new Date(slot.endAt);
    const shiftMs   = Math.round(shiftHours * 3600 * 1000 / (15 * 60 * 1000)) * (15 * 60 * 1000); // snap to 15min

    const newStart = new Date(origStart.getTime() + shiftMs);
    const newEnd   = new Date(origEnd.getTime()   + shiftMs);

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
      setError(e instanceof Error ? e.message : 'Помилка переміщення слоту');
    }
  }, [slots, load]);

  const slotsForLift = (liftId: string) => slots.filter(s => s.liftId === liftId);
  const unassignedSlots = slots.filter(s => !s.liftId);

  const formatDate = (ds: string) => {
    if (!ds) return '';
    const d = new Date(ds);
    return d.toLocaleDateString('uk-UA', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric', timeZone: KYIV_TZ });
  };

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

      {/* Date nav */}
      <div className="flex items-center gap-4 mb-6">
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
          <span className="text-sm text-muted-foreground capitalize">{formatDate(date)}</span>
        </div>
        <Button variant="outline" size="sm" onClick={nextDay}>
          Наступний
          <ChevronRight className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="sm" onClick={() => {
          const now = new Date();
          setDate(toDateString(now));
        }}>
          Сьогодні
        </Button>
      </div>

      {/* Add slot form */}
      {showAdd && (
        <div className="bg-surface border border-border rounded-xl p-5 mb-6 space-y-3">
          <h3 className="font-semibold text-foreground text-sm">Новий слот на {date}</h3>
          {error && <p className="text-[13px] text-destructive-text">{error}</p>}
          <div className="grid grid-cols-4 gap-3">
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">Підйомник</label>
              <Select
                value={form.liftId}
                onChange={e => setForm(f => ({ ...f, liftId: e.target.value }))}
              >
                <option value="">— будь-який —</option>
                {lifts.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
              </Select>
            </div>
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
                      // Clamp end-time within the same calendar day (23:59 max).
                      // Slot cannot cross midnight in STO scheduling model.
                      const totalMin = Math.min(h * 60 + m + Math.round(Number(f.normoHours) * 60), 23 * 60 + 59);
                      const endH = Math.floor(totalMin / 60);
                      const endM = totalMin % 60;
                      const endAt = `${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}`;
                      return { ...f, startAt: start, endAt };
                    }
                    return { ...f, startAt: start };
                  });
                }}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">
                Норм-год <span className="font-normal text-muted-foreground/70">(авто кінець)</span>
              </label>
              <Input
                type="number"
                step="0.5"
                min="0.5"
                value={form.normoHours}
                onChange={e => {
                  const nh = e.target.value;
                  setForm(f => {
                    if (f.startAt && nh && Number(nh) > 0) {
                      const [h, m] = f.startAt.split(':').map(Number);
                      // Clamp end-time within the same calendar day (23:59 max).
                      const totalMin = Math.min(h * 60 + m + Math.round(Number(nh) * 60), 23 * 60 + 59);
                      const endH = Math.floor(totalMin / 60);
                      const endM = totalMin % 60;
                      const endAt = `${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}`;
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
              <Input
                type="time"
                value={form.endAt}
                onChange={e => setForm(f => ({ ...f, endAt: e.target.value }))}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">ID наряду <span className="font-normal opacity-60">(необов'язково)</span></label>
              <Input
                value={form.workOrderId}
                onChange={e => setForm(f => ({ ...f, workOrderId: e.target.value.trim() }))}
                placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">Нотатки</label>
              <Input
                value={form.notes}
                onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
              />
            </div>
          </div>
          <div className="flex gap-2">
            <Button onClick={addSlot} loading={saving} disabled={!form.startAt || !form.endAt}>
              Зберегти
            </Button>
            <Button variant="outline" onClick={() => setShowAdd(false)}>
              Скасувати
            </Button>
          </div>
        </div>
      )}

      {/* Timeline grid */}
      {loading && (
        <div className="flex justify-center py-8">
          <Spinner size="md" />
        </div>
      )}
      {!loading && lifts.length === 0 && (
        <div className="bg-surface border border-border rounded-xl p-8 text-center text-sm text-muted-foreground">
          Немає підйомників. Додайте їх у розділі <a href="/infrastructure" className="text-primary hover:underline">Інфраструктура</a>.
        </div>
      )}
      {!loading && lifts.length > 0 && (
        <DndContext sensors={sensors} onDragEnd={e => { void handleDragEnd(e); }}>
          <div ref={timelineRef} className="bg-surface border border-border rounded-xl overflow-hidden">
            {/* Hour headers */}
            <div className="grid border-b border-border" style={{ gridTemplateColumns: `160px repeat(${HOURS.length}, 1fr)` }}>
              <div className="px-3 py-2 text-xs font-medium text-muted-foreground bg-secondary border-r border-border">Підйомник</div>
              {HOURS.map(h => (
                <div key={h} className="px-1 py-2 text-xs text-center text-muted-foreground bg-secondary border-r border-border last:border-r-0">
                  {pad(h)}:00
                </div>
              ))}
            </div>

            {/* Lift rows */}
            {lifts.map(lift => (
              <div key={lift.id} className="grid border-b border-border last:border-b-0" style={{ gridTemplateColumns: `160px repeat(${HOURS.length}, 1fr)` }}>
                <div className="px-3 py-3 text-sm font-medium text-foreground bg-secondary border-r border-border flex items-center">
                  {lift.name}
                </div>
                <DroppableLiftRow
                  liftId={lift.id}
                  liftSlots={slotsForLift(lift.id)}
                  onRemove={removeSlot}
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
