'use client';

import { useEffect, useRef, useCallback, useState } from 'react';
import { UserPlus, FilePlus, Trash2, ExternalLink } from 'lucide-react';
import { apiFetch } from '@/lib/api-client';
import { WO_STATUS_LABELS, WO_STATUS_BADGE } from '@sto/shared';
import { fmtMoney, fmtDate, kyivDateTimeToISO } from '@/lib/format';
import { EntityPickerField } from '@/components/ui/entity-picker-field';
import {
  CounterpartyEditModal,
  type CounterpartyForModal,
} from '@/components/ui/CounterpartyEditModal';
import { toast } from '@/lib/toast';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PhoneInput } from '@/components/ui/phone-input';
import { CreateWorkOrderModal } from '@/components/ui/CreateWorkOrderModal';
import { Select } from '@/components/ui/select';
import { Modal } from '@/components/ui/modal';
import { DateTimePickerInput } from '@/components/ui/datetime-picker-input';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { SearchPickerModal, type SearchPickerItem } from '@/components/ui/search-picker-modal';
import { useConfirm } from '@/hooks/useConfirm';
import type {
  CalendarSlot,
  Lift,
  CounterpartyOption,
  WorkOrderOption,
  VehicleOption,
  PendingSlot,
  SlotForm,
} from './calendar.types';
import {
  HOURS,
  PICK_MINUTES,
  UUID_RE,
  KYIV_TZ,
  WINDOW_START,
  WINDOW_END,
  decimalHoursToHHMM,
  parseHHMM,
  buildHHMM,
  pad,
  displayCounterparty,
  fmtTime,
  fmtKyivDate,
} from './calendar.utils';

// ─── WorkOrderPreviewModal ────────────────────────────────────────────────────

interface WOPreview {
  id: string;
  number: string;
  status: string;
  counterpartyName?: string;
  vehicleSummary?: string;
  description?: string | null;
  totalAmount: number;
  totalLabor: number;
  totalParts: number;
  plannedAt?: string | null;
  documentDate?: string | null;
}

function WorkOrderPreviewModal({ id, onClose }: { id: string; onClose: () => void }) {
  const [wo, setWo] = useState<WOPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    apiFetch<WOPreview>(`/work-orders/${id}`)
      .then(data => {
        if (!cancelled) setWo(data);
      })
      .catch(e => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Помилка завантаження');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const statusLabel = wo ? (WO_STATUS_LABELS[wo.status] ?? wo.status) : '';
  const statusVariant = wo ? (WO_STATUS_BADGE[wo.status] ?? 'secondary') : 'secondary';

  return (
    <Modal open onClose={onClose} title="Наряд" size="md">
      {loading ? (
        <div className="flex justify-center py-8">
          <span className="text-muted-foreground text-sm">Завантаження…</span>
        </div>
      ) : error ? (
        <p className="text-sm text-destructive-text">{error}</p>
      ) : wo ? (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-lg font-semibold text-foreground">{wo.number}</span>
            <Badge variant={statusVariant} dot>
              {statusLabel}
            </Badge>
          </div>

          <div className="grid grid-cols-2 gap-3 text-[13px]">
            {wo.counterpartyName && (
              <div>
                <div className="text-muted-foreground mb-0.5">Клієнт</div>
                <div className="text-foreground font-medium">{wo.counterpartyName}</div>
              </div>
            )}
            {wo.vehicleSummary && (
              <div>
                <div className="text-muted-foreground mb-0.5">Автомобіль</div>
                <div className="text-foreground font-medium">{wo.vehicleSummary}</div>
              </div>
            )}
            {wo.documentDate && (
              <div>
                <div className="text-muted-foreground mb-0.5">Дата документа</div>
                <div className="text-foreground">{fmtDate(wo.documentDate)}</div>
              </div>
            )}
            {wo.plannedAt && (
              <div>
                <div className="text-muted-foreground mb-0.5">Заплановано</div>
                <div className="text-foreground">{fmtDate(wo.plannedAt)}</div>
              </div>
            )}
          </div>

          {wo.description && (
            <div className="text-[13px]">
              <div className="text-muted-foreground mb-0.5">Опис</div>
              <div className="text-foreground">{wo.description}</div>
            </div>
          )}

          <div className="grid grid-cols-3 gap-2 bg-secondary rounded-lg p-3 text-[13px]">
            <div>
              <div className="text-muted-foreground mb-0.5">Роботи</div>
              <div className="font-semibold text-foreground">{fmtMoney(wo.totalLabor)} ₴</div>
            </div>
            <div>
              <div className="text-muted-foreground mb-0.5">Запчастини</div>
              <div className="font-semibold text-foreground">{fmtMoney(wo.totalParts)} ₴</div>
            </div>
            <div>
              <div className="text-muted-foreground mb-0.5">Разом</div>
              <div className="font-semibold text-primary">{fmtMoney(wo.totalAmount)} ₴</div>
            </div>
          </div>

          <div className="flex justify-between items-center pt-1">
            <Button variant="outline" onClick={onClose}>
              Закрити
            </Button>
            <Button variant="ghost" onClick={() => window.open(`/work-orders/${wo.id}`, '_blank')}>
              <ExternalLink className="h-4 w-4 mr-1.5" />
              Відкрити повністю
            </Button>
          </div>
        </div>
      ) : null}
    </Modal>
  );
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface CalendarSlotModalProps {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  onDeleted: () => void;

  date: string;
  lifts: Lift[];
  form: SlotForm;
  setForm: React.Dispatch<React.SetStateAction<SlotForm>>;

  editingSlotId: string | null;
  isEditingPast: boolean;
  pendingSlot: PendingSlot | null;
  setPendingSlot: React.Dispatch<React.SetStateAction<PendingSlot | null>>;

  /** Controls the height-animated collapse wrapper */
  formMounted: boolean;
  formVisible: boolean;
  formCollapseRef: React.RefObject<HTMLDivElement | null>;
  formInnerRef: React.RefObject<HTMLDivElement | null>;

  minHour: number;
  nowMs: number;

  error: string;
  setError: (e: string) => void;
  saving: boolean;
  setSaving: (s: boolean) => void;

  cpDisplay: string;
  setCpDisplay: (v: string) => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function CalendarSlotModal({
  open,
  onClose,
  onSaved,
  onDeleted,
  date,
  lifts,
  form,
  setForm,
  editingSlotId,
  isEditingPast,
  pendingSlot,
  setPendingSlot,
  formMounted,
  formVisible,
  formCollapseRef,
  formInnerRef,
  minHour,
  nowMs,
  error,
  setError,
  saving,
  setSaving,
  cpDisplay,
  setCpDisplay,
}: CalendarSlotModalProps) {
  const { confirm, dialogProps } = useConfirm();
  const mountedRef = useRef(true);
  const [woPreviewId, setWoPreviewId] = useState<string | null>(null);

  // ── Detail modals ─────────────────────────────────────────────────────────
  const [cpDetailOpen, setCpDetailOpen] = useState(false);
  const [cpDetailData, setCpDetailData] = useState<CounterpartyForModal | null>(null);

  const openCpDetail = useCallback(async () => {
    if (!form.counterpartyId) return;
    try {
      const cp = await apiFetch<CounterpartyForModal>(`/counterparties/${form.counterpartyId}`);
      setCpDetailData(cp);
      setCpDetailOpen(true);
    } catch {
      /* ignore */
    }
  }, [form.counterpartyId]);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // ── Counterparty search state ─────────────────────────────────────────────

  const [cpPhone, setCpPhone] = useState<string | null>(null);
  const [cpVehicles, setCpVehicles] = useState<VehicleOption[]>([]);
  const [cpOptions, setCpOptions] = useState<CounterpartyOption[]>([]);
  const [cpLoading, setCpLoading] = useState(false);
  const [showCpDropdown, setShowCpDropdown] = useState(false);
  const cpTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // New counterparty wizard modal
  const [newCpOpen, setNewCpOpen] = useState(false);
  const [newCpStep, setNewCpStep] = useState<1 | 2>(1);
  const [newCp, setNewCp] = useState({
    firstName: '',
    lastName: '',
    phone: '',
    companyName: '',
    email: '',
  });
  const [newVehicle, setNewVehicle] = useState({
    make: '',
    model: '',
    year: '',
    licensePlate: '',
    vin: '',
  });
  const [savingCp, setSavingCp] = useState(false);
  const [cpWizardError, setCpWizardError] = useState('');
  const [createdCpId, setCreatedCpId] = useState('');
  const [createdGarageId, setCreatedGarageId] = useState('');

  const openNewCpWizard = () => {
    setNewCp({ firstName: '', lastName: '', phone: '', companyName: '', email: '' });
    setNewVehicle({ make: '', model: '', year: '', licensePlate: '', vin: '' });
    setCreatedCpId('');
    setCreatedGarageId('');
    setCpWizardError('');
    setNewCpStep(1);
    setNewCpOpen(true);
  };

  const saveWizardStep1 = async () => {
    if (!newCp.firstName && !newCp.lastName && !newCp.companyName) {
      setCpWizardError("Вкажіть ім'я або назву компанії");
      return;
    }
    setSavingCp(true);
    setCpWizardError('');
    try {
      const created = await apiFetch<CounterpartyOption>('/counterparties', {
        method: 'POST',
        body: JSON.stringify({
          type: 'CLIENT',
          firstName: newCp.firstName || undefined,
          lastName: newCp.lastName || undefined,
          phone: newCp.phone || undefined,
          companyName: newCp.companyName || undefined,
          email: newCp.email || undefined,
        }),
      });
      setCreatedCpId(created.id);
      const garages = await apiFetch<{ id: string; isDefault: boolean }[]>(
        `/counterparties/${created.id}/garages`,
      ).catch(() => [] as { id: string; isDefault: boolean }[]);
      const defaultGarage = garages.find(g => g.isDefault) ?? garages[0];
      if (defaultGarage) setCreatedGarageId(defaultGarage.id);
      setNewCpStep(2);
    } catch (e: unknown) {
      setCpWizardError(e instanceof Error ? e.message : 'Помилка');
    } finally {
      setSavingCp(false);
    }
  };

  const saveWizardStep2 = async (skip = false) => {
    if (!skip) {
      if (!newVehicle.make.trim() || !newVehicle.model.trim()) {
        setCpWizardError('Вкажіть марку та модель авто');
        return;
      }
      setSavingCp(true);
      setCpWizardError('');
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
      } catch (e: unknown) {
        setCpWizardError(e instanceof Error ? e.message : 'Помилка');
        setSavingCp(false);
        return;
      } finally {
        setSavingCp(false);
      }
    }
    const display =
      newCp.companyName ||
      [newCp.lastName, newCp.firstName].filter(Boolean).join(' ') ||
      '(без імені)';
    setCpDisplay(display);
    setForm(f => ({ ...f, counterpartyId: createdCpId, counterpartyDisplay: display }));
    setNewCpOpen(false);
  };

  useEffect(() => {
    if (!open) {
      setCpOptions([]);
      setCpDisplay('');
      setCpPhone(null);
      setCpVehicles([]);
      setNewCpOpen(false);
    }
  }, [open, setCpDisplay]);

  // Підтягуємо телефон при відкритті форми з уже обраним контрагентом
  // (редагування існуючого слота — picker не викликався, тому cpPhone = null)
  useEffect(() => {
    if (!open || !form.counterpartyId || cpPhone !== null) return;
    let cancelled = false;
    const fetchedForId = form.counterpartyId;
    apiFetch<{ phone?: string | null }>(`/counterparties/${fetchedForId}`)
      .then(cp => {
        // Guard: відкинути результат якщо counterparty переключили під час fetch
        // або компонент розмонтовано
        if (!cancelled && mountedRef.current && fetchedForId === form.counterpartyId) {
          setCpPhone(cp.phone ?? null);
        }
      })
      .catch(() => {
        /* ignore */
      });
    return () => {
      cancelled = true;
    };
  }, [open, form.counterpartyId, cpPhone]);

  // Завантажуємо авто клієнта при зміні counterpartyId.
  // Якщо 1 авто — одразу ставимо vehicleId; якщо >1 — показуємо Select; якщо 0 — ховаємо.
  // form.vehicleId та setForm НЕ в deps щоб уникнути циклу: ефект сам пише в form.vehicleId.
  // Замість stale closure — читаємо актуальне значення через formRef.
  const formRef = useRef(form);
  formRef.current = form;
  useEffect(() => {
    if (!open || !form.counterpartyId) {
      setCpVehicles([]);
      return;
    }
    // Bug #366: скидаємо cpVehicles ОДРАЗУ при старті нового fetch, щоб не показувати
    // vehicles попереднього клієнта поки нові завантажуються.
    setCpVehicles([]);
    const ac = new AbortController();
    const fetchedForId = form.counterpartyId;
    (async () => {
      try {
        // sto-optimize: bulk `/vehicles?counterpartyId=X` (join through customerGarage)
        // замінює waterfall garages → per-garage vehicles fetch (N+1 → 1 RTT).
        const all = await apiFetch<VehicleOption[]>(`/vehicles?counterpartyId=${fetchedForId}`, {
          signal: ac.signal,
        });
        if (ac.signal.aborted || !mountedRef.current) return;
        setCpVehicles(all);
        // Bug #367: defense-in-depth — якщо поточний form.vehicleId не належить
        // жодному vehicle нового клієнта (успадкований з минулого через WO picker
        // або edit slot) — скидаємо, інакше auto-fill для 1-vehicle клієнта блокується
        // і newWo POST отримує invalid FK.
        const currentVid = formRef.current.vehicleId;
        const stillValid = currentVid && all.some(v => v.id === currentVid);
        if (currentVid && !stillValid) {
          setForm(f => ({ ...f, vehicleId: '' }));
        }
        if (all.length === 1 && !stillValid) {
          setForm(f => ({ ...f, vehicleId: all[0]!.id }));
        }
      } catch {
        if (!ac.signal.aborted && mountedRef.current) setCpVehicles([]);
      }
    })();
    return () => {
      ac.abort();
    };
  }, [open, form.counterpartyId, setForm]);

  const searchCounterparties = useCallback((q: string) => {
    if (cpTimeoutRef.current) clearTimeout(cpTimeoutRef.current);
    if (!q.trim()) {
      setCpOptions([]);
      setShowCpDropdown(false);
      return;
    }
    cpTimeoutRef.current = setTimeout(async () => {
      setCpLoading(true);
      try {
        const data = await apiFetch<{ items: CounterpartyOption[] }>(
          `/counterparties?q=${encodeURIComponent(q)}&limit=10&types=CLIENT&types=BOTH`,
        );
        if (mountedRef.current) {
          setCpOptions(data.items);
          setShowCpDropdown(true);
        }
      } catch {
        /* ignore */
      } finally {
        if (mountedRef.current) setCpLoading(false);
      }
    }, 300);
  }, []);

  useEffect(() => {
    return () => {
      if (cpTimeoutRef.current) clearTimeout(cpTimeoutRef.current);
    };
  }, []);

  // ── New work-order modal ──────────────────────────────────────────────────
  const [createWoOpen, setCreateWoOpen] = useState(false);

  // ── Picker modals ─────────────────────────────────────────────────────────

  const [cpPickerOpen, setCpPickerOpen] = useState(false);
  const [woPickerOpen, setWoPickerOpen] = useState(false);

  type CpItem = SearchPickerItem & { phone?: string | null };
  type WoItem = SearchPickerItem & {
    counterpartyId?: string | null;
    counterpartyName?: string;
    slotStartAt?: string | null;
    slotEndAt?: string | null;
    slotLiftName?: string | null;
  };

  const fetchCpItems = useCallback(async (q: string): Promise<CpItem[]> => {
    let url = '/counterparties?limit=50&types=CLIENT&types=BOTH';
    if (q.trim()) url += `&q=${encodeURIComponent(q.trim())}`;
    const data = await apiFetch<{ items: CounterpartyOption[] }>(url);
    return data.items
      .filter(cp => cp.firstName || cp.lastName || cp.companyName)
      .map(cp => ({
        id: cp.id,
        primary: displayCounterparty(cp),
        secondary: cp.phone ?? undefined,
        phone: cp.phone,
      }));
  }, []);

  const fetchWoItems = useCallback(
    async (q: string): Promise<WoItem[]> => {
      const cpParam = form.counterpartyId ? `&counterpartyId=${form.counterpartyId}` : '';
      const url = q.trim()
        ? `/work-orders?q=${encodeURIComponent(q)}&limit=30${cpParam}`
        : `/work-orders?limit=30${cpParam}`;
      const data = await apiFetch<{ items: WorkOrderOption[] }>(url);
      return data.items.map(wo => ({
        id: wo.id,
        primary: wo.number,
        secondary: wo.counterpartyName ?? undefined,
        counterpartyId: wo.counterpartyId,
        counterpartyName: wo.counterpartyName,
        slotStartAt: wo.slotStartAt ?? null,
        slotEndAt: wo.slotEndAt ?? null,
        slotLiftName: wo.slotLiftName ?? null,
      }));
    },
    [form.counterpartyId],
  );

  // ── Add / update slot ─────────────────────────────────────────────────────

  const addSlot = async () => {
    if (!form.startAt || !form.endAt) {
      setError('Вкажіть час початку та завершення');
      return;
    }
    if (form.endAt <= form.startAt) {
      setError('Час завершення повинен бути після часу початку');
      return;
    }
    if (!form.counterpartyId && !form.workOrderId) {
      setError('Оберіть клієнта');
      return;
    }
    if (form.liftId && !UUID_RE.test(form.liftId)) {
      setError('Некоректний підйомник — оберіть зі списку');
      return;
    }
    if (form.employeeId && !UUID_RE.test(form.employeeId)) {
      setError('Некоректний співробітник — оберіть зі списку');
      return;
    }
    if (form.workOrderId && !UUID_RE.test(form.workOrderId)) {
      setError('Оберіть наряд зі списку');
      return;
    }
    if (!editingSlotId && nowMs) {
      const todayKyiv = new Date(nowMs).toLocaleDateString('sv-SE', { timeZone: KYIV_TZ });
      if (date < todayKyiv) {
        setError('Не можна створити запис у минулому');
        return;
      }
      if (date === todayKyiv) {
        const slotHour = parseInt(form.startAt.split(':')[0] ?? '0', 10);
        if (slotHour < minHour) {
          setError('Не можна створити запис у минулому');
          return;
        }
      }
    }
    // Bug #354: kyivDateTimeToISO замість `new Date(...).toISOString()`
    // local-парсингу без TZ. DST-aware (+02 зима, +03 літо).
    const startIso = kyivDateTimeToISO(date, form.startAt);
    const endIso = kyivDateTimeToISO(date, form.endAt);
    if (!date || !form.startAt || !form.endAt || !startIso || !endIso) {
      setError('Вкажіть коректні дату та час');
      return;
    }
    setSaving(true);
    setError('');
    const body = {
      liftId: form.liftId || undefined,
      employeeId: form.employeeId || undefined,
      workOrderId: form.workOrderId || undefined,
      counterpartyId: form.counterpartyId || undefined,
      vehicleId: form.vehicleId || undefined,
      startAt: startIso,
      endAt: endIso,
      notes: form.notes || undefined,
    };
    try {
      if (editingSlotId) {
        await apiFetch(`/calendar/slots/${editingSlotId}`, {
          method: 'PATCH',
          body: JSON.stringify(body),
        });
        toast.success('Слот оновлено');
      } else {
        await apiFetch<CalendarSlot>('/calendar/slots', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        toast.success('Слот створено');
      }
      onSaved();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Помилка збереження';
      setError(msg);
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────

  if (!formMounted) return null;

  return (
    <>
      <div
        ref={formCollapseRef}
        className="overflow-hidden"
        style={{
          height: formVisible ? undefined : '0px',
          marginBottom: formVisible ? '1.5rem' : '0px',
          transition: formVisible
            ? 'height 480ms cubic-bezier(0.22,1,0.36,1), margin-bottom 480ms cubic-bezier(0.22,1,0.36,1)'
            : undefined,
        }}
      >
        <div
          ref={formInnerRef}
          className="bg-surface border border-border rounded-xl p-5 space-y-3"
          style={{
            opacity: formVisible ? 1 : 0,
            transform: formVisible ? 'translateY(0)' : 'translateY(-8px)',
            transition: formVisible
              ? 'opacity 350ms 60ms cubic-bezier(0.22,1,0.36,1), transform 350ms 60ms cubic-bezier(0.22,1,0.36,1)'
              : 'opacity 200ms cubic-bezier(0.4,0,1,1), transform 200ms cubic-bezier(0.4,0,1,1)',
          }}
        >
          <h3 className="font-semibold text-foreground text-sm">
            {editingSlotId
              ? isEditingPast
                ? 'Перегляд слоту'
                : 'Редагування слоту'
              : pendingSlot
                ? `Новий слот ${decimalHoursToHHMM(pendingSlot.startH)}–${decimalHoursToHHMM(pendingSlot.endH)} на ${date}`
                : `Новий слот на ${date}`}
          </h3>
          {error && <p className="text-[13px] text-destructive-text">{error}</p>}

          {isEditingPast && (
            <div className="flex items-center gap-2 text-[13px] text-warning-text bg-warning-subtle border border-warning/20 rounded-lg px-3 py-2">
              <span>🔒</span>
              <span>Слот у закритому періоді — редагування недоступне</span>
            </div>
          )}

          <div className="grid grid-cols-4 gap-3">
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">
                Підйомник
              </label>
              <Select
                value={form.liftId}
                disabled={isEditingPast}
                onChange={e => setForm(f => ({ ...f, liftId: e.target.value }))}
              >
                <option value="">— будь-який —</option>
                {lifts.map(l => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <DateTimePickerInput
                label="Початок"
                timeOnly
                value={form.startAt}
                minHour={editingSlotId ? WINDOW_START : minHour}
                maxHour={WINDOW_END - 1}
                disabled={isEditingPast}
                onChange={start => {
                  setForm(f => {
                    let next = { ...f, startAt: start };
                    if (start && f.normoHours && Number(f.normoHours) > 0) {
                      const [h, m] = start.split(':').map(Number);
                      const totalMin = Math.min(
                        (h ?? 0) * 60 + (m ?? 0) + Math.round(Number(f.normoHours) * 60),
                        23 * 60 + 59,
                      );
                      const em = Math.round((totalMin % 60) / 15) * 15;
                      next = {
                        ...next,
                        endAt: `${pad(Math.floor(totalMin / 60))}:${pad(em >= 60 ? 0 : em)}`,
                      };
                    }
                    if (pendingSlot) {
                      const { h: sh, m: sm } = parseHHMM(start);
                      const { h: eh, m: em } = parseHHMM(next.endAt || start);
                      setPendingSlot(p =>
                        p ? { ...p, startH: sh + sm / 60, endH: eh + em / 60 } : p,
                      );
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
                type="number"
                step="0.5"
                min="0.5"
                value={form.normoHours}
                disabled={isEditingPast}
                onChange={e => {
                  const nh = e.target.value;
                  setForm(f => {
                    if (f.startAt && nh && Number(nh) > 0) {
                      const [h, m] = f.startAt.split(':').map(Number);
                      const totalMin = Math.min(
                        (h ?? 0) * 60 + (m ?? 0) + Math.round(Number(nh) * 60),
                        23 * 60 + 59,
                      );
                      const em = Math.round((totalMin % 60) / 15) * 15;
                      const endAt = `${pad(Math.floor(totalMin / 60))}:${pad(em >= 60 ? 0 : em)}`;
                      if (pendingSlot) {
                        const { h: eh, m: em2 } = parseHHMM(endAt);
                        setPendingSlot(p => (p ? { ...p, endH: eh + em2 / 60 } : p));
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
              <DateTimePickerInput
                label="Кінець"
                timeOnly
                value={form.endAt}
                minHour={WINDOW_START}
                maxHour={WINDOW_END}
                disabled={isEditingPast}
                onChange={endAt => {
                  setForm(f => ({ ...f, endAt }));
                  if (pendingSlot) {
                    const { h, m } = parseHHMM(endAt);
                    setPendingSlot(p => (p ? { ...p, endH: h + m / 60 } : p));
                  }
                }}
              />
            </div>
          </div>

          {/* Клієнт + Автомобіль — в одному рядку */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">
                Клієнт <span className="text-destructive-text">*</span>
              </label>
              <div className="flex items-center gap-1">
                <div className="flex-1 min-w-0">
                  <EntityPickerField<CpItem>
                    display={form.counterpartyDisplay}
                    placeholder="Пошук клієнта…"
                    disabled={isEditingPast}
                    hidePick={isEditingPast}
                    onOpenDetail={form.counterpartyId ? openCpDetail : undefined}
                    onPick={() => setCpPickerOpen(true)}
                    onSearch={!isEditingPast ? fetchCpItems : undefined}
                    onSearchSelect={async item => {
                      if (
                        form.workOrderId &&
                        form.counterpartyId &&
                        item.id !== form.counterpartyId
                      ) {
                        const ok = await confirm({
                          title: "Зміна клієнта очистить прив'язаний наряд?",
                          message: `Прив'язаний наряд «${form.workOrderDisplay}» буде відкріплено.`,
                          variant: 'destructive',
                        });
                        if (!ok) return;
                        setCpDisplay(item.primary);
                        setCpPhone(item.phone ?? null);
                        setCpVehicles([]);
                        setForm(f => ({
                          ...f,
                          counterpartyId: item.id,
                          counterpartyDisplay: item.primary,
                          vehicleId: '',
                          workOrderId: '',
                          workOrderDisplay: '',
                        }));
                        return;
                      }
                      setCpDisplay(item.primary);
                      setCpPhone(item.phone ?? null);
                      setCpVehicles([]);
                      setForm(f => ({
                        ...f,
                        counterpartyId: item.id,
                        counterpartyDisplay: item.primary,
                        vehicleId: '',
                      }));
                    }}
                    onClear={() => {
                      setCpDisplay('');
                      setCpPhone(null);
                      setCpVehicles([]);
                      setForm(f => ({
                        ...f,
                        counterpartyId: '',
                        counterpartyDisplay: '',
                        vehicleId: '',
                        workOrderId: '',
                        workOrderDisplay: '',
                      }));
                    }}
                  />
                </div>
                {!isEditingPast && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={openNewCpWizard}
                    title="Новий клієнт"
                    className="h-9 w-9 p-0 shrink-0"
                  >
                    <UserPlus className="h-4 w-4" />
                  </Button>
                )}
              </div>
              {cpPhone && (
                <p className="text-xs text-muted-foreground mt-1">
                  📞{' '}
                  <a href={`tel:${cpPhone}`} className="hover:text-foreground transition-colors">
                    {cpPhone}
                  </a>
                </p>
              )}
            </div>

            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">
                Автомобіль <span className="text-destructive-text">*</span>
              </label>
              <select
                className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
                value={form.vehicleId}
                disabled={isEditingPast || cpVehicles.length === 0}
                onChange={e => setForm(f => ({ ...f, vehicleId: e.target.value }))}
              >
                {cpVehicles.length === 0 ? (
                  <option value="">
                    {form.counterpartyId ? 'Немає авто' : '— оберіть клієнта —'}
                  </option>
                ) : (
                  <>
                    <option value="">— оберіть авто —</option>
                    {cpVehicles.map(v => (
                      <option key={v.id} value={v.id}>
                        {[v.make, v.model, v.licensePlate].filter(Boolean).join(' ')}
                      </option>
                    ))}
                  </>
                )}
              </select>
            </div>
          </div>

          {/* Наряд */}
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">Наряд</label>
            <div className="flex items-center gap-1">
              <div className="flex-1 min-w-0">
                <EntityPickerField<WoItem>
                  display={form.workOrderDisplay}
                  placeholder="Пошук наряду…"
                  disabled={isEditingPast}
                  hidePick={isEditingPast}
                  onOpenDetail={
                    form.workOrderId ? () => setWoPreviewId(form.workOrderId) : undefined
                  }
                  onPick={() => setWoPickerOpen(true)}
                  onSearch={!isEditingPast ? fetchWoItems : undefined}
                  onSearchSelect={async item => {
                    const display = item.counterpartyName
                      ? `${item.primary} · ${item.counterpartyName}`
                      : item.primary;

                    if (
                      item.counterpartyId &&
                      form.counterpartyId &&
                      item.counterpartyId !== form.counterpartyId
                    ) {
                      const replace = await confirm({
                        title: 'Замінити поточного клієнта?',
                        message: `Наряд належить іншому клієнту (${item.counterpartyName ?? item.counterpartyId}).`,
                      });
                      if (replace) {
                        const cpDisp = item.counterpartyName ?? '';
                        setCpDisplay(cpDisp);
                        setCpPhone(null);
                        setCpVehicles([]);
                        setForm(f => ({
                          ...f,
                          workOrderId: item.id,
                          workOrderDisplay: display,
                          counterpartyId: item.counterpartyId!,
                          counterpartyDisplay: cpDisp,
                          vehicleId: '',
                        }));
                      } else {
                        setForm(f => ({ ...f, workOrderId: item.id, workOrderDisplay: display }));
                      }
                      return;
                    }

                    if (item.counterpartyId && !form.counterpartyId) {
                      const cpDisp = item.counterpartyName ?? '';
                      setCpDisplay(cpDisp);
                      setCpPhone(null);
                      setCpVehicles([]);
                      setForm(f => ({
                        ...f,
                        workOrderId: item.id,
                        workOrderDisplay: display,
                        counterpartyId: item.counterpartyId!,
                        counterpartyDisplay: cpDisp,
                        vehicleId: '',
                      }));
                      return;
                    }

                    setForm(f => ({ ...f, workOrderId: item.id, workOrderDisplay: display }));
                  }}
                  onClear={() => setForm(f => ({ ...f, workOrderId: '', workOrderDisplay: '' }))}
                />
              </div>
              {!isEditingPast && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCreateWoOpen(true)}
                  title="Новий наряд"
                  className="h-9 w-9 p-0 shrink-0"
                >
                  <FilePlus className="h-4 w-4" />
                </Button>
              )}
            </div>
          </div>

          {/* New client wizard modal */}
          <Modal
            open={newCpOpen}
            onClose={() => setNewCpOpen(false)}
            title={newCpStep === 1 ? 'Новий клієнт' : 'Автомобіль клієнта'}
            size="md"
          >
            <div className="flex items-center gap-2 mb-5">
              {([1, 2] as const).map(s => (
                <div key={s} className="flex items-center gap-2">
                  <div
                    className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-semibold ${s === newCpStep ? 'bg-primary text-primary-foreground' : s < newCpStep ? 'bg-success-text text-white' : 'bg-secondary text-muted-foreground border border-border'}`}
                  >
                    {s < newCpStep ? '✓' : s}
                  </div>
                  <span
                    className={`text-xs ${s === newCpStep ? 'text-foreground font-medium' : 'text-muted-foreground'}`}
                  >
                    {s === 1 ? 'Клієнт' : 'Авто'}
                  </span>
                  {s < 2 && <div className="w-8 h-px bg-border mx-1" />}
                </div>
              ))}
            </div>

            {cpWizardError && (
              <p className="text-sm text-destructive-text bg-destructive-subtle border border-destructive/20 rounded-lg px-3 py-2 mb-4">
                {cpWizardError}
              </p>
            )}

            {newCpStep === 1 && (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <Input
                    label="Ім'я"
                    placeholder="Іван"
                    value={newCp.firstName}
                    onChange={e => setNewCp(v => ({ ...v, firstName: e.target.value }))}
                  />
                  <Input
                    label="Прізвище"
                    placeholder="Коваль"
                    value={newCp.lastName}
                    onChange={e => setNewCp(v => ({ ...v, lastName: e.target.value }))}
                  />
                </div>
                <Input
                  label="Назва компанії"
                  placeholder="ТОВ «Авто»"
                  value={newCp.companyName}
                  onChange={e => setNewCp(v => ({ ...v, companyName: e.target.value }))}
                />
                <div className="grid grid-cols-2 gap-3">
                  <PhoneInput
                    label="Телефон"
                    value={newCp.phone}
                    onChange={e => setNewCp(v => ({ ...v, phone: e.target.value }))}
                  />
                  <Input
                    label="Email"
                    type="email"
                    placeholder="ivan@example.com"
                    value={newCp.email}
                    onChange={e => setNewCp(v => ({ ...v, email: e.target.value }))}
                  />
                </div>
                <div className="flex gap-2 pt-2">
                  <Button
                    onClick={saveWizardStep1}
                    loading={savingCp}
                    disabled={!newCp.firstName && !newCp.lastName && !newCp.companyName}
                  >
                    Далі →
                  </Button>
                  <Button variant="outline" onClick={() => setNewCpOpen(false)}>
                    Скасувати
                  </Button>
                </div>
              </div>
            )}

            {newCpStep === 2 && (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <Input
                    label="Марка"
                    placeholder="Toyota"
                    value={newVehicle.make}
                    onChange={e => setNewVehicle(v => ({ ...v, make: e.target.value }))}
                  />
                  <Input
                    label="Модель"
                    placeholder="Camry"
                    value={newVehicle.model}
                    onChange={e => setNewVehicle(v => ({ ...v, model: e.target.value }))}
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <Input
                    label="Рік"
                    placeholder="2021"
                    value={newVehicle.year}
                    onChange={e => setNewVehicle(v => ({ ...v, year: e.target.value }))}
                  />
                  <Input
                    label="Держ. номер"
                    placeholder="АА 1234 ВВ"
                    value={newVehicle.licensePlate}
                    onChange={e => setNewVehicle(v => ({ ...v, licensePlate: e.target.value }))}
                  />
                </div>
                <Input
                  label="VIN (необов'язково)"
                  placeholder="1HGBH41JXMN109186"
                  value={newVehicle.vin}
                  onChange={e => setNewVehicle(v => ({ ...v, vin: e.target.value }))}
                />
                <div className="flex gap-2 pt-2">
                  <Button
                    onClick={() => saveWizardStep2(false)}
                    loading={savingCp}
                    disabled={!newVehicle.make.trim() || !newVehicle.model.trim()}
                  >
                    Зберегти
                  </Button>
                  <Button variant="outline" onClick={() => saveWizardStep2(true)}>
                    Пропустити
                  </Button>
                </div>
              </div>
            )}
          </Modal>

          {/* Notes */}
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">Нотатки</label>
            <Input
              value={form.notes}
              disabled={isEditingPast}
              onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
            />
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
            onSelect={async item => {
              if (form.workOrderId && form.counterpartyId && item.id !== form.counterpartyId) {
                const ok = await confirm({
                  title: "Зміна клієнта очистить прив'язаний наряд?",
                  message: `Прив'язаний наряд «${form.workOrderDisplay}» буде відкріплено.`,
                  variant: 'destructive',
                });
                if (!ok) return;
                setCpDisplay(item.primary);
                setCpPhone(item.phone ?? null);
                setCpVehicles([]);
                setForm(f => ({
                  ...f,
                  counterpartyId: item.id,
                  counterpartyDisplay: item.primary,
                  vehicleId: '',
                  workOrderId: '',
                  workOrderDisplay: '',
                }));
                return;
              }
              setCpDisplay(item.primary);
              setCpPhone(item.phone ?? null);
              setCpVehicles([]);
              setForm(f => ({
                ...f,
                counterpartyId: item.id,
                counterpartyDisplay: item.primary,
                vehicleId: '',
              }));
            }}
          />
          <SearchPickerModal<WoItem>
            open={woPickerOpen}
            onClose={() => setWoPickerOpen(false)}
            title={form.counterpartyId ? 'Наряди клієнта' : 'Оберіть наряд'}
            selectedId={form.workOrderId}
            fetchItems={fetchWoItems}
            searchPlaceholder="Номер наряду..."
            emptyText="Нарядів не знайдено"
            renderItem={(item, selected) => (
              <div>
                <div
                  className={`text-sm font-medium ${selected ? 'text-primary' : 'text-foreground'}`}
                >
                  {item.primary}
                </div>
                {item.secondary && (
                  <div className="text-xs text-muted-foreground mt-0.5">{item.secondary}</div>
                )}
                {item.slotStartAt ? (
                  <div className="flex items-center gap-1.5 text-xs text-primary mt-0.5">
                    <span>📅</span>
                    <span>
                      {fmtKyivDate(item.slotStartAt)} {fmtTime(item.slotStartAt)}–
                      {item.slotEndAt ? fmtTime(item.slotEndAt) : ''}
                      {item.slotLiftName ? ` · ${item.slotLiftName}` : ''}
                    </span>
                  </div>
                ) : (
                  <div className="text-xs text-muted-foreground/60 mt-0.5">не заплановано</div>
                )}
              </div>
            )}
            onSelect={async item => {
              const display = item.counterpartyName
                ? `${item.primary} · ${item.counterpartyName}`
                : item.primary;

              if (
                item.counterpartyId &&
                form.counterpartyId &&
                item.counterpartyId !== form.counterpartyId
              ) {
                const replace = await confirm({
                  title: 'Замінити поточного клієнта?',
                  message: `Наряд належить іншому клієнту (${item.counterpartyName ?? item.counterpartyId}).`,
                });
                if (replace) {
                  const cpDisp = item.counterpartyName ?? '';
                  setCpDisplay(cpDisp);
                  setCpPhone(null);
                  // Bug #365: при заміні клієнта через WO picker скидаємо vehicleId
                  // і cpVehicles. Без цього form.vehicleId успадковується з минулого
                  // клієнта → leak до newWo POST → 400 FK mismatch.
                  setCpVehicles([]);
                  setForm(f => ({
                    ...f,
                    workOrderId: item.id,
                    workOrderDisplay: display,
                    counterpartyId: item.counterpartyId!,
                    counterpartyDisplay: cpDisp,
                    vehicleId: '',
                  }));
                } else {
                  setForm(f => ({ ...f, workOrderId: item.id, workOrderDisplay: display }));
                }
                return;
              }

              if (item.counterpartyId && !form.counterpartyId) {
                const cpDisp = item.counterpartyName ?? '';
                setCpDisplay(cpDisp);
                setCpPhone(null);
                // Bug #365: defensive — починаємо з чистого vehicleId/cpVehicles
                setCpVehicles([]);
                setForm(f => ({
                  ...f,
                  workOrderId: item.id,
                  workOrderDisplay: display,
                  counterpartyId: item.counterpartyId!,
                  counterpartyDisplay: cpDisp,
                  vehicleId: '',
                }));
                return;
              }

              setForm(f => ({ ...f, workOrderId: item.id, workOrderDisplay: display }));
            }}
          />
          <div className="flex items-center gap-2">
            {!isEditingPast && (
              <Button
                onClick={addSlot}
                loading={saving}
                disabled={
                  !form.startAt ||
                  !form.endAt ||
                  (!form.counterpartyId && !form.workOrderId) ||
                  (!!form.counterpartyId && !form.vehicleId)
                }
              >
                {editingSlotId ? 'Оновити' : 'Зберегти'}
              </Button>
            )}
            <Button variant="outline" onClick={onClose}>
              {isEditingPast ? 'Закрити' : 'Скасувати'}
            </Button>
            {editingSlotId && !isEditingPast && (
              <Button
                variant="destructive"
                className="ml-auto"
                onClick={async () => {
                  const ok = await confirm({
                    title: 'Видалити слот?',
                    message: 'Цю дію не можна скасувати.',
                    variant: 'destructive',
                  });
                  if (!ok) return;
                  setSaving(true);
                  try {
                    await apiFetch(`/calendar/slots/${editingSlotId}`, { method: 'DELETE' });
                    toast.success('Слот видалено');
                    onDeleted();
                  } catch (e: unknown) {
                    const msg = e instanceof Error ? e.message : 'Помилка видалення';
                    setError(msg);
                    toast.error(msg);
                  } finally {
                    setSaving(false);
                  }
                }}
              >
                <Trash2 className="h-4 w-4 mr-1.5" />
                Видалити
              </Button>
            )}
          </div>
        </div>
      </div>
      <ConfirmDialog {...dialogProps} />
      {woPreviewId && (
        <WorkOrderPreviewModal id={woPreviewId} onClose={() => setWoPreviewId(null)} />
      )}
      <CounterpartyEditModal
        open={cpDetailOpen}
        counterparty={cpDetailData}
        onClose={() => setCpDetailOpen(false)}
        onSaved={updated => {
          setCpDetailData(updated);
          setCpDisplay(
            updated.companyName ??
              [updated.lastName, updated.firstName].filter(Boolean).join(' ') ??
              '',
          );
          setForm(f => ({
            ...f,
            counterpartyDisplay:
              updated.companyName ??
              [updated.lastName, updated.firstName].filter(Boolean).join(' ') ??
              '',
          }));
          setCpDetailOpen(false);
        }}
      />
      <CreateWorkOrderModal
        open={createWoOpen}
        onClose={() => setCreateWoOpen(false)}
        prefill={{
          counterpartyId: form.counterpartyId || undefined,
          counterpartyDisplay: form.counterpartyDisplay || undefined,
          vehicleId: form.vehicleId || undefined,
          description: form.notes || undefined,
          plannedStartAt: form.startAt ? `${date}T${form.startAt}` : undefined,
          plannedEndAt: form.endAt ? `${date}T${form.endAt}` : undefined,
        }}
        onCreated={wo => {
          const display = `${wo.number}${form.counterpartyDisplay ? ` · ${form.counterpartyDisplay}` : ''}`;
          setForm(f => ({ ...f, workOrderId: wo.id, workOrderDisplay: display }));
        }}
      />
    </>
  );
}
