'use client';

import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PhoneInput } from '@/components/ui/phone-input';
import { Spinner } from '@/components/ui/spinner';
import { DatePickerInput } from '@/components/ui/date-picker-input';

interface Branch {
  id: string;
  name: string;
  address?: string | null;
}
interface AvailabilitySlot {
  startAt: string;
  endAt: string;
  liftId: string;
  liftName: string;
  available: boolean;
}

// Bug #111: public booking widget must NOT use `apiFetch` — that helper redirects
// to /login on any 401, which would happen the moment we try to hit auth-guarded
// endpoints. Use raw `fetch` against the dedicated public `/api/booking/*` routes.
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';

// Module-level Intl singleton — slots render у grid з .map(), без хостингу
// форматер ініціалізувався б за кожен slot × кожен ререндер (O(slots × renders)
// конструкцій locale-data, найдорожча частина Intl).
const SLOT_TIME_FMT = new Intl.DateTimeFormat('uk-UA', {
  hour: '2-digit',
  minute: '2-digit',
});

async function publicFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}/api${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    // Bug #137: NestJS class-validator повертає `message: string[]` при 400 — join з '; '.
    const body = (await res.json().catch(() => ({ message: res.statusText }))) as {
      message?: string | string[];
    };
    const msg = Array.isArray(body.message)
      ? body.message.join('; ')
      : (body.message ?? `HTTP ${res.status}`);
    throw new Error(msg);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export default function BookingPage() {
  const { data: branches = [] } = useQuery<Branch[]>({
    queryKey: ['booking', 'branches'],
    queryFn: () => publicFetch<Branch[]>('/booking/branches'),
    staleTime: 5 * 60_000, // публічні філії майже не міняються
    gcTime: 10 * 60_000,
  });
  const [selectedBranch, setSelectedBranch] = useState<Branch | null>(null);
  const [date, setDate] = useState('');
  // Bug (cycle-2): `new Date()` in render is a hydration mismatch (server vs
  // client TZ may straddle midnight). Compute today's local date in an effect
  // so SSR sees an empty string.
  const [minDate, setMinDate] = useState('');
  const [slots, setSlots] = useState<AvailabilitySlot[]>([]);
  const [selectedSlot, setSelectedSlot] = useState<AvailabilitySlot | null>(null);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [form, setForm] = useState({ clientName: '', clientPhone: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  useEffect(() => {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    setMinDate(`${yyyy}-${mm}-${dd}`);
  }, []);

  useEffect(() => {
    if (!date || !selectedBranch) return;
    let cancelled = false;
    setSlotsLoading(true);
    setSelectedSlot(null);
    publicFetch<AvailabilitySlot[]>(
      `/booking/availability?branchId=${selectedBranch.id}&date=${date}`,
    )
      .then(d => {
        if (!cancelled) setSlots(Array.isArray(d) ? d.filter(s => s.available) : []);
      })
      .catch(() => {
        if (!cancelled) setSlots([]);
      })
      .finally(() => {
        if (!cancelled) setSlotsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [date, selectedBranch]);

  const handleSubmit = async () => {
    if (!selectedBranch || !selectedSlot) return;
    setSaving(true);
    setError('');
    // PhoneInput formats as "+38 (096) 566-59-33" but API validates /^\+380\d{9}$/.
    // Strip all non-digit/non-plus characters before sending.
    const normalizedPhone = form.clientPhone.replace(/[^\d+]/g, '');
    try {
      await publicFetch('/booking/request', {
        method: 'POST',
        body: JSON.stringify({
          branchId: selectedBranch.id,
          clientName: form.clientName,
          clientPhone: normalizedPhone,
          requestedDate: selectedSlot.startAt,
        }),
      });
      setDone(true);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка запису');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-lg space-y-6">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-foreground">Онлайн-запис</h1>
          <p className="text-muted-foreground text-sm mt-1">Запишіться на обслуговування авто</p>
        </div>

        {error && (
          <div className="text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-4 py-2.5">
            {error}
          </div>
        )}

        {done ? (
          <div className="bg-surface rounded-xl border border-border p-8 text-center space-y-3">
            <div className="text-4xl text-green-500">✓</div>
            <h2 className="font-semibold text-foreground text-lg">Заявку прийнято!</h2>
            <p className="text-muted-foreground text-sm">
              Ми зв'яжемося з вами за номером {form.clientPhone} для підтвердження.
            </p>
          </div>
        ) : (
          <div className="bg-surface rounded-xl border border-border p-6 space-y-5">
            {/* Крок 1 — Вибір філії */}
            <div>
              <label className="block text-[13px] font-medium text-foreground mb-2">Філія</label>
              <div className="space-y-2">
                {branches.length === 0 && (
                  <p className="text-[13px] text-muted-foreground">Завантаження...</p>
                )}
                {branches.map(b => (
                  <button
                    key={b.id}
                    type="button"
                    onClick={() => {
                      setSelectedBranch(b);
                      setSelectedSlot(null);
                    }}
                    className={`w-full text-left px-4 py-3 rounded-lg border text-sm transition-colors ${
                      selectedBranch?.id === b.id
                        ? 'border-primary bg-primary/10 text-foreground'
                        : 'border-border bg-input text-foreground hover:bg-secondary'
                    }`}
                  >
                    <div className="font-medium">{b.name}</div>
                    {b.address && (
                      <div className="text-[12px] text-muted-foreground">{b.address}</div>
                    )}
                  </button>
                ))}
              </div>
            </div>

            {/* Крок 2 — Дата */}
            {selectedBranch && (
              <DatePickerInput
                label="Бажана дата"
                value={date}
                onChange={setDate}
                min={minDate || undefined}
              />
            )}

            {/* Слоти */}
            {date && selectedBranch && (
              <div>
                <label className="block text-[13px] font-medium text-foreground mb-2">
                  Вільний час
                </label>
                {slotsLoading ? (
                  <div className="flex justify-center py-4">
                    <Spinner />
                  </div>
                ) : slots.length === 0 ? (
                  <div className="text-center text-muted-foreground text-sm py-4">
                    На обрану дату немає вільних слотів
                  </div>
                ) : (
                  <div className="grid grid-cols-3 gap-2">
                    {slots.map(s => {
                      // Stable per-slot key (liftId + startAt) — using array
                      // index causes React to retain focus/style on the wrong
                      // button when slots re-render after a filter change.
                      const slotKey = `${s.liftId}-${s.startAt}`;
                      const isSelected =
                        !!selectedSlot &&
                        selectedSlot.liftId === s.liftId &&
                        selectedSlot.startAt === s.startAt;
                      return (
                        <button
                          key={slotKey}
                          type="button"
                          onClick={() => setSelectedSlot(s)}
                          className={`px-3 py-2 rounded-lg border text-sm transition-colors ${
                            isSelected
                              ? 'border-primary bg-primary/10 text-foreground font-medium'
                              : 'border-border bg-input text-foreground hover:bg-secondary'
                          }`}
                        >
                          {SLOT_TIME_FMT.format(new Date(s.startAt))}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* Крок 3 — Контакти */}
            {selectedSlot && (
              <div className="space-y-4">
                <Input
                  label="Ваше ім'я"
                  required
                  value={form.clientName}
                  onChange={e => setForm(f => ({ ...f, clientName: e.target.value }))}
                  placeholder="Іван Іванченко"
                  className="h-8 text-[13px]"
                />
                <PhoneInput
                  label="Телефон"
                  required
                  value={form.clientPhone}
                  onChange={e => setForm(f => ({ ...f, clientPhone: e.target.value }))}
                />
                <Button
                  onClick={handleSubmit}
                  loading={saving}
                  disabled={!form.clientName || !form.clientPhone}
                  className="w-full"
                >
                  Записатись
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
