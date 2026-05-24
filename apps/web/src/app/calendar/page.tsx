'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRequireAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api-client';

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

  const [date, setDate] = useState(toDateString(new Date()));
  const [slots, setSlots] = useState<CalendarSlot[]>([]);
  const [loading, setLoading] = useState(true);
  const [lifts, setLifts] = useState<Lift[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ liftId: '', employeeId: '', workOrderId: '', startAt: '', endAt: '', notes: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    apiFetch<Lift[]>('/lifts').then(setLifts).catch((e: unknown) => setError(e instanceof Error ? e.message : 'Помилка завантаження'));
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    apiFetch<CalendarSlot[]>(`/calendar/slots?date=${date}`).then(setSlots).catch((e: unknown) => setError(e instanceof Error ? e.message : 'Помилка завантаження')).finally(() => setLoading(false));
  }, [date]);

  useEffect(() => { load(); }, [load]);

  const prevDay = () => { const d = new Date(date); d.setDate(d.getDate() - 1); setDate(toDateString(d)); };
  const nextDay = () => { const d = new Date(date); d.setDate(d.getDate() + 1); setDate(toDateString(d)); };

  const addSlot = async () => {
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
    const d = new Date(ds);
    return d.toLocaleDateString('uk-UA', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
  };

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Календар</h1>
        <button onClick={() => setShowAdd(v => !v)} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700">
          + Слот
        </button>
      </div>

      {error && !showAdd && <p className="mb-4 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-2">{error}</p>}

      {/* Date nav */}
      <div className="flex items-center gap-4 mb-6">
        <button onClick={prevDay} className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm text-gray-600 hover:bg-gray-50">← Попередній</button>
        <div className="flex items-center gap-2">
          <input type="date" value={date} onChange={e => setDate(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          <span className="text-sm text-gray-500 capitalize">{formatDate(date)}</span>
        </div>
        <button onClick={nextDay} className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm text-gray-600 hover:bg-gray-50">Наступний →</button>
        <button onClick={() => setDate(toDateString(new Date()))} className="px-3 py-1.5 text-sm text-blue-600 hover:underline">Сьогодні</button>
      </div>

      {/* Add slot form */}
      {showAdd && (
        <div className="bg-white border rounded-xl p-5 mb-6 space-y-3">
          <h3 className="font-semibold text-gray-900 text-sm">Новий слот на {date}</h3>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Підйомник</label>
              <select value={form.liftId} onChange={e => setForm(f => ({ ...f, liftId: e.target.value }))}
                className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm">
                <option value="">— будь-який —</option>
                {lifts.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Початок</label>
              <input type="time" value={form.startAt} onChange={e => setForm(f => ({ ...f, startAt: e.target.value }))}
                className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Кінець</label>
              <input type="time" value={form.endAt} onChange={e => setForm(f => ({ ...f, endAt: e.target.value }))}
                className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Номер наряду (ID)</label>
              <input value={form.workOrderId} onChange={e => setForm(f => ({ ...f, workOrderId: e.target.value }))}
                placeholder="UUID наряду (необов'язково)"
                className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Нотатки</label>
              <input value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm" />
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={addSlot} disabled={saving || !form.startAt || !form.endAt}
              className="px-4 py-1.5 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-60">
              {saving ? '...' : 'Зберегти'}
            </button>
            <button onClick={() => setShowAdd(false)} className="px-4 py-1.5 text-gray-500 text-sm">Скасувати</button>
          </div>
        </div>
      )}

      {/* Timeline grid */}
      {loading && <p className="text-sm text-gray-400 text-center py-8">Завантаження...</p>}
      {!loading && lifts.length === 0 && (
        <div className="bg-white border rounded-xl p-8 text-center text-sm text-gray-400">
          Немає підйомників. Додайте їх у розділі <a href="/infrastructure" className="text-blue-600 hover:underline">Інфраструктура</a>.
        </div>
      )}
      {!loading && lifts.length > 0 && (
        <div className="bg-white border rounded-xl overflow-hidden">
          {/* Hour headers */}
          <div className="grid border-b" style={{ gridTemplateColumns: `160px repeat(${HOURS.length}, 1fr)` }}>
            <div className="px-3 py-2 text-xs font-medium text-gray-500 bg-gray-50 border-r">Підйомник</div>
            {HOURS.map(h => (
              <div key={h} className="px-1 py-2 text-xs text-center text-gray-400 bg-gray-50 border-r last:border-r-0">
                {pad(h)}:00
              </div>
            ))}
          </div>

          {/* Lift rows */}
          {lifts.map(lift => {
            const liftSlots = slotsForLift(lift.id);
            return (
              <div key={lift.id} className="grid border-b last:border-b-0" style={{ gridTemplateColumns: `160px repeat(${HOURS.length}, 1fr)` }}>
                <div className="px-3 py-3 text-sm font-medium text-gray-700 bg-gray-50 border-r flex items-center">
                  {lift.name}
                </div>
                <div className="col-span-12 relative min-h-[48px]" style={{ gridColumn: `2 / span ${HOURS.length}` }}>
                  <div className="flex h-full">
                    {HOURS.map(h => (
                      <div key={h} className="flex-1 border-r last:border-r-0 border-gray-100 min-h-[48px]" />
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
                        className="absolute top-1 bottom-1 bg-blue-500 rounded text-white text-xs flex items-center px-1.5 overflow-hidden cursor-pointer hover:bg-blue-600 group"
                        style={{ left: `${left}%`, width: `${width}%` }}
                        title={s.workOrderNumber ? `Наряд ${s.workOrderNumber}` : s.notes ?? ''}
                      >
                        <span className="truncate">{fmtTime(s.startAt)}–{fmtTime(s.endAt)}{s.workOrderNumber ? ` · ${s.workOrderNumber}` : ''}</span>
                        <button onClick={() => removeSlot(s.id)}
                          className="ml-auto opacity-0 group-hover:opacity-100 text-white/80 hover:text-white px-0.5">×</button>
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
        <div className="mt-6 bg-white border rounded-xl p-5">
          <h3 className="font-semibold text-gray-900 mb-3 text-sm">Без підйомника</h3>
          <div className="space-y-2">
            {unassignedSlots.map(s => (
              <div key={s.id} className="flex items-center justify-between px-3 py-2 bg-gray-50 rounded-lg">
                <div>
                  <span className="text-sm text-gray-900">{fmtTime(s.startAt)} – {fmtTime(s.endAt)}</span>
                  {s.workOrderNumber && <span className="ml-2 text-xs text-blue-600">Наряд {s.workOrderNumber}</span>}
                  {s.notes && <span className="ml-2 text-xs text-gray-400">{s.notes}</span>}
                </div>
                <button onClick={() => removeSlot(s.id)} className="text-xs text-red-400 hover:text-red-600 px-2">×</button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
