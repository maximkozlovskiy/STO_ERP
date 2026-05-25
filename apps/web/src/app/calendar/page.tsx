'use client';

import { useEffect, useState, useCallback } from 'react';
import { Plus, ChevronLeft, ChevronRight, Trash2 } from 'lucide-react';
import { useRequireAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';

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

export default function CalendarPage() {
  useRequireAuth(['OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC']);

  const [date, setDate] = useState('');
  const [slots, setSlots] = useState<CalendarSlot[]>([]);
  const [loading, setLoading] = useState(true);
  const [lifts, setLifts] = useState<Lift[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ liftId: '', employeeId: '', workOrderId: '', startAt: '', endAt: '', notes: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { setDate(toDateString(new Date())); }, []);

  useEffect(() => {
    apiFetch<Lift[]>('/lifts').then(setLifts).catch((e: unknown) => setError(e instanceof Error ? e.message : 'Помилка завантаження'));
  }, []);

  const load = useCallback(() => {
    if (!date) return;
    setLoading(true);
    apiFetch<CalendarSlot[]>(`/calendar/slots?date=${date}`).then(setSlots).catch((e: unknown) => setError(e instanceof Error ? e.message : 'Помилка завантаження')).finally(() => setLoading(false));
  }, [date]);

  useEffect(() => { load(); }, [load]);

  const prevDay = () => { const d = new Date(date); d.setDate(d.getDate() - 1); setDate(toDateString(d)); };
  const nextDay = () => { const d = new Date(date); d.setDate(d.getDate() + 1); setDate(toDateString(d)); };

  const addSlot = async () => {
    if (form.startAt && form.endAt && form.endAt <= form.startAt) {
      setError('Час завершення повинен бути після часу початку'); return;
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
      setForm({ liftId: '', employeeId: '', workOrderId: '', startAt: '', endAt: '', notes: '' });
      load();
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка'); }
    finally { setSaving(false); }
  };

  const removeSlot = async (id: string) => {
    if (!confirm('Видалити слот?')) return;
    setSaving(true); setError('');
    try { await apiFetch<void>(`/calendar/slots/${id}`, { method: 'DELETE' }); load(); }
    catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка видалення'); }
    finally { setSaving(false); }
  };

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
          <Input
            type="date"
            value={date}
            onChange={e => setDate(e.target.value)}
            className="w-auto"
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
          <div className="grid grid-cols-3 gap-3">
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
                onChange={e => setForm(f => ({ ...f, startAt: e.target.value }))}
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
              <label className="block text-xs font-medium text-muted-foreground mb-1">Номер наряду (ID)</label>
              <Input
                value={form.workOrderId}
                onChange={e => setForm(f => ({ ...f, workOrderId: e.target.value }))}
                placeholder="UUID наряду (необов'язково)"
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
        <div className="bg-surface border border-border rounded-xl overflow-hidden">
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
          {lifts.map(lift => {
            const liftSlots = slotsForLift(lift.id);
            return (
              <div key={lift.id} className="grid border-b border-border last:border-b-0" style={{ gridTemplateColumns: `160px repeat(${HOURS.length}, 1fr)` }}>
                <div className="px-3 py-3 text-sm font-medium text-foreground bg-secondary border-r border-border flex items-center">
                  {lift.name}
                </div>
                <div className="col-span-12 relative min-h-12" style={{ gridColumn: `2 / span ${HOURS.length}` }}>
                  <div className="flex h-full">
                    {HOURS.map(h => (
                      <div key={h} className="flex-1 border-r last:border-r-0 border-border min-h-12" />
                    ))}
                  </div>
                  {liftSlots.map(s => {
                    const startH = kyivHours(s.startAt);
                    const endH = kyivHours(s.endAt);
                    const left = ((startH - HOURS[0]) / HOURS.length) * 100;
                    const width = ((endH - startH) / HOURS.length) * 100;
                    return (
                      <div
                        key={s.id}
                        className="absolute top-1 bottom-1 bg-primary rounded text-white text-xs flex items-center px-1.5 overflow-hidden cursor-pointer hover:opacity-90 group"
                        style={{ left: `${left}%`, width: `${width}%` }}
                        title={s.workOrderNumber ? `Наряд ${s.workOrderNumber}` : s.notes ?? ''}
                      >
                        <span className="truncate">{fmtTime(s.startAt)}–{fmtTime(s.endAt)}{s.workOrderNumber ? ` · ${s.workOrderNumber}` : ''}</span>
                        <button onClick={() => removeSlot(s.id)}
                          className="ml-auto opacity-0 group-hover:opacity-100 text-white/80 hover:text-white px-0.5">
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
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
