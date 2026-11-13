'use client';

import { useEffect, useId, useRef, useCallback, useMemo, useState } from 'react';
import type { Dispatch, SetStateAction, RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import dynamic from 'next/dynamic';
import { UserPlus, FilePlus, Trash2 } from 'lucide-react';
import { apiFetch } from '@/lib/api-client';
import { usePendingOpen } from '@/hooks/usePendingOpen';
import { normalizeDecimalInput } from '@sto/shared';
import { woStatusLabel } from '@/i18n/enumLabel';
import { fmtDate, isoToKyivLocalDateTime, kyivDateTimeToISO } from '@/lib/format';
import { EntityPickerField } from '@/components/ui/entity-picker-field';
import {
  CounterpartyEditModal,
  type CounterpartyForModal,
} from '@/components/ui/CounterpartyEditModal';
import { toast } from '@/lib/toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PhoneInput } from '@/components/ui/phone-input';
import { Select } from '@/components/ui/select';
import { VehicleMakeModelFields } from '@/components/ui/VehicleMakeModelFields';
import { Modal } from '@/components/ui/modal';
import { DateTimePickerInput } from '@/components/ui/datetime-picker-input';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { SearchPickerModal, type SearchPickerItem } from '@/components/ui/search-picker-modal';
import { useConfirm } from '@/hooks/useConfirm';
import { useConflictCheck } from '@/hooks/useConflictCheck';
import type {
  CalendarSlot,
  Lift,
  CounterpartyOption,
  WorkOrderOption,
  VehicleOption,
  PendingSlot,
  SavedMechanic,
  SlotForm,
  SlotType,
} from './calendar.types';
import { SLOT_TYPES, isServiceSlotType, slotType } from './calendar-categories';
import {
  UUID_RE,
  decimalHoursToHHMM,
  parseHHMM,
  pad,
  displayCounterparty,
  fmtTime,
  fmtKyivDate,
  toDateString,
} from './calendar.utils';
import { CalendarMechanicField } from './CalendarMechanicField';
import { mechanicDroppedText, type MechanicDropResponse } from './calendar-mechanic-drop';
import {
  isCancelledWorkOrderSlot,
  slotDeleteConfirmOptions,
  slotDeleteLockHint,
} from './calendar-day';
import type { CreatedWorkOrder } from '@/components/ui/CreateWorkOrderModal';
import { calcEndFromHours, type WorkHoursWindow } from '@/components/ui/work-order/planned-dates';
import {
  slotEndFromHours,
  slotHoursBetween,
  slotParts,
  slotRealEnd,
  type LocalSpan,
} from './calendar-slot-span';

/**
 * «Години» без робочих днів: зміну ручного запису сервер не ділить на дні, тож його нормогодини —
 * просто тривалість (`slotHoursBetween` з цими годинами жодного дня не вважає робочим).
 */
const NO_SPLIT: WorkHoursWindow = Object.freeze({ startHour: 0, endHour: 0 });

/** Нормогодини поля форми («1,5» — як «1.5»); не число — NaN. */
const hoursOf = (value: string) => parseFloat(String(value).replace(',', '.'));

/** Частина запису для підказки й тосту: «24.11 09:00–18:00». */
function partLabel(p: LocalSpan): string {
  return `${p.start.slice(8, 10)}.${p.start.slice(5, 7)} ${p.start.slice(11, 16)}–${p.end.slice(11, 16)}`;
}

// ESLint import/first constraint + Next.js static-export build: const між import-statement'ами порушує правила.
// Усі imports згруповані вище; dynamic const залишається тут, відразу після останнього import.
// sto-optimize: CreateWorkOrderModal — 1823 LOC; calendar відкривається без створення WO
// у більшості сесій → lazy-load при першому кліку «Створити наряд» з модалки слота.
const CreateWorkOrderModal = dynamic(
  () => import('@/components/ui/CreateWorkOrderModal').then(m => m.CreateWorkOrderModal),
  { ssr: false },
);

// ─── Props ────────────────────────────────────────────────────────────────────

interface CalendarSlotModalProps {
  open: boolean;
  onClose: () => void;
  /**
   * Запис збережено. `workOrderChanged` — змінено запис наряду: час і підйомник сервер переносить
   * у наряд (BR-WO-024), тож картка й списки нарядів мають перечитати планові дати.
   */
  onSaved: (opts?: { workOrderChanged?: boolean }) => void;
  onDeleted: () => void;
  /**
   * Наряд змінено з його картки, відкритої з форми (статус, план): категорія й колір записів
   * календаря залежать від статусу наряду (BR-CAL-008) — вид треба перечитати.
   */
  onWorkOrderChanged?: () => void;

  date: string;
  lifts: Lift[];
  form: SlotForm;
  setForm: Dispatch<SetStateAction<SlotForm>>;
  /**
   * Зміна форми, яку робить сама форма, а не користувач (кінець за годинами філії підйомника, єдине
   * авто клієнта): та сама зміна — і в знімку форми, тож незбереженою зміною не вважається
   * (BR-CAL-018). Немає — `setForm`.
   */
  adjustForm?: Dispatch<SetStateAction<SlotForm>>;

  editingSlotId: string | null;
  isEditingPast: boolean;
  /**
   * Користувач без права змінювати записи (механік): форма лише для перегляду, як для минулого
   * запису, — інакше «Оновити» і «Видалити» закінчуються 403 (Bug #871).
   */
  readOnly?: boolean;
  /** Механік і підйомник запису, що редагується (BR-CAL-012); `null` — новий запис. */
  savedMechanic?: SavedMechanic | null;
  /**
   * Наряд запису, що редагується (як збережено), або `null`: `number` — у підтвердженні
   * видалення (BR-WO-026 стирає дати наряду), `lockedStatus` — статус наряду, у якому час,
   * підйомник і наряд запису не змінюються (BR-WO-027); примітка й механік — доступні, а запис
   * скасованого наряду ще й видаляється (без зміни його дат).
   */
  editingWorkOrder?: { number: string; lockedStatus: string | null } | null;
  /**
   * Запис — частина багатоденного ланцюжка (BR-CAL-019, BR-WO-024, BR-CAL-020): `days` — скільки
   * частин, `startAt` — початок першої, `endAt` — кінець останньої, `isFirst` / `isLast` — чи це
   * перший і останній день. Ланцюжок НАРЯДУ: внутрішні межі не змінюються (початок не першого дня й
   * кінець не останнього недоступні, нормогодин не перераховує). Ручний ланцюжок: форма з будь-якого
   * дня показує й змінює межі всього ланцюжка. `null` — одноденний запис чи новий.
   */
  editingChain?: {
    days: number;
    startAt?: string;
    endAt: string;
    isFirst: boolean;
    isLast: boolean;
  } | null;
  pendingSlot: PendingSlot | null;
  setPendingSlot: Dispatch<SetStateAction<PendingSlot | null>>;

  /** Controls the height-animated collapse wrapper */
  formMounted: boolean;
  formVisible: boolean;
  formCollapseRef: RefObject<HTMLDivElement | null>;
  formInnerRef: RefObject<HTMLDivElement | null>;

  minHour: number;
  windowStart: number;
  windowEnd: number;
  /**
   * Робочі дні основної філії, ISO (1 = пн … 7 = нд). Години й дні запису — філії ПІДЙОМНИКА
   * (BR-CAL-017); ці — лише доки підйомник не обрано чи його філія невідома.
   */
  windowWorkDays?: readonly number[];
  /**
   * Робочі години й дні філії підйомника, обраного у формі (BR-CAL-017): за ними форма рахує
   * кінець, частини запису, пікери й автокінець наряду. `null` — підйомника не обрано чи його
   * філія невідома: години основної філії (`windowStart` / `windowEnd` / `windowWorkDays`).
   */
  formWorkHours?: WorkHoursWindow | null;
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
  onWorkOrderChanged,
  date,
  lifts,
  form,
  setForm,
  adjustForm = setForm,
  editingSlotId,
  isEditingPast: isPastLocked,
  readOnly = false,
  savedMechanic = null,
  editingWorkOrder = null,
  editingChain = null,
  pendingSlot,
  setPendingSlot,
  formMounted,
  formVisible,
  formCollapseRef,
  formInnerRef,
  minHour,
  windowStart,
  windowEnd,
  windowWorkDays,
  formWorkHours = null,
  nowMs,
  error,
  setError,
  saving,
  setSaving,
  cpDisplay,
  setCpDisplay,
}: CalendarSlotModalProps) {
  const { t } = useTranslation('calendar');
  const { confirm, dialogProps } = useConfirm();
  // Усе, що для минулого запису заблоковано, заблоковано й без права змінювати записи.
  const isEditingPast = isPastLocked || readOnly;
  // BR-WO-027: наряд не в редагованому статусі — час, підйомник, клієнт і наряд запису
  // недоступні (перев'язка теж, BR-WO-028); примітка й механік — як раніше.
  const woLockedStatus = isEditingPast ? null : (editingWorkOrder?.lockedStatus ?? null);
  const fieldsLocked = isEditingPast || woLockedStatus !== null;
  // BR-WO-026: видалити запис такого наряду не можна (сервер відповів би 400) — кнопка з підказкою.
  // Виняток — скасований наряд (рішення власника 2026-10-19): запис видаляється, дати наряду ті самі.
  const deleteLockHint = slotDeleteLockHint(t, woLockedStatus);
  const cancelledWorkOrder = isCancelledWorkOrderSlot(editingWorkOrder?.lockedStatus ?? null);
  // Рішення власника №68 (BR-WO-026): запис скасованого наряду видаляється й у минулому дні —
  // форма, як і перелік «Без підйомника»; решта полів минулого запису лишається для перегляду.
  // Без права змінювати записи (механік) — ні: сервер відповів би 403.
  const canDelete = !!editingSlotId && (!isEditingPast || (!readOnly && cancelledWorkOrder));
  const deleteHintId = useId();
  const {
    conflict: calConflict,
    check: checkConflict,
    clear: clearConflict,
    conflictWoNumbers,
  } = useConflictCheck();
  const mountedRef = useRef(true);
  const liftSelectId = useId();
  const typeSelectId = useId();
  const typeHintId = useId();
  // BR-CAL-003: службовий запис (обслуговування, перерва, нарада) — без клієнта, авто й наряду.
  const serviceType = isServiceSlotType(form.type);
  // Перечитати механіків підйомника після відмови збереження (TECH-DEBT §13 п.9).
  const [mechanicsReloadKey, setMechanicsReloadKey] = useState(0);
  const setMechanic = useCallback(
    (employeeId: string) => setForm(f => ({ ...f, employeeId })),
    [setForm],
  );

  // ── Detail modals ─────────────────────────────────────────────────────────
  const [cpDetailOpen, setCpDetailOpen] = useState(false);
  const [cpDetailData, setCpDetailData] = useState<CounterpartyForModal | null>(null);

  // Картка відкривається після запиту: Escape під час нього скасовує відкриття, а не закриває
  // вікно-власника (Bug #935).
  const openAfterLoad = usePendingOpen(open);

  const openCpDetail = useCallback(async () => {
    if (!form.counterpartyId) return;
    try {
      await openAfterLoad(
        () => apiFetch<CounterpartyForModal>(`/counterparties/${form.counterpartyId}`),
        cp => {
          setCpDetailData(cp);
          setCpDetailOpen(true);
        },
      );
    } catch (e: unknown) {
      // Раніше тут був порожній `catch { /* ignore */ }`: при збої картка клієнта просто
      // не відкривалась, і користувач не розумів, чи клік узагалі зареєструвався.
      toast.error(e instanceof Error ? e.message : t('slot.errCpDetailLoad'));
    }
  }, [form.counterpartyId, t, openAfterLoad]);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // ── Counterparty side-state (phone + vehicles) ────────────────────────────
  // The actual counterparty search is owned by <EntityPickerField onSearch>;
  // we only persist derived UI state here (phone for display, vehicles list).

  const [cpPhone, setCpPhone] = useState<string | null>(null);
  const [cpVehicles, setCpVehicles] = useState<VehicleOption[]>([]);
  const [vehiclesRefetchKey, setVehiclesRefetchKey] = useState(0);

  /**
   * Тип нового запису (BR-CAL-003). Службовий тип знімає клієнта, авто й наряд, які могли бути
   * обрані до нього: сервер їх для службового запису відхилив би (400), а прихованих полів
   * користувач не бачить.
   */
  const changeType = (type: SlotType) => {
    if (!isServiceSlotType(type)) {
      setForm(f => ({ ...f, type }));
      return;
    }
    setCpDisplay('');
    setCpPhone(null);
    setCpVehicles([]);
    setForm(f => ({
      ...f,
      type,
      counterpartyId: '',
      counterpartyDisplay: '',
      vehicleId: '',
      workOrderId: '',
      workOrderDisplay: '',
    }));
  };

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
  // Марка й модель — ідентифікатори довідника (BR-VEH-008), назви пише сервер.
  const [newVehicle, setNewVehicle] = useState({
    makeId: '',
    modelId: '',
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
    setNewVehicle({ makeId: '', modelId: '', year: '', licensePlate: '', vin: '' });
    setCreatedCpId('');
    setCreatedGarageId('');
    setCpWizardError('');
    setNewCpStep(1);
    setNewCpOpen(true);
  };

  const saveWizardStep1 = async () => {
    // Дзеркалить cross-field name-guard беку (counterparties.service.hasCounterpartyName):
    // whitespace-only не рахується як назва — інакше backend поверне 400 із загальним
    // повідомленням, і користувач не побачить inline-помилки.
    if (!newCp.firstName.trim() && !newCp.lastName.trim() && !newCp.companyName.trim()) {
      setCpWizardError(t('wizard.nameRequired'));
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
      setCpWizardError(e instanceof Error ? e.message : t('slot.errGeneric'));
    } finally {
      setSavingCp(false);
    }
  };

  const saveWizardStep2 = async (skip = false) => {
    if (!skip) {
      if (!newVehicle.makeId || !newVehicle.modelId) {
        setCpWizardError(t('wizard.makeModelRequired'));
        return;
      }
      setSavingCp(true);
      setCpWizardError('');
      try {
        await apiFetch('/vehicles', {
          method: 'POST',
          body: JSON.stringify({
            customerGarageId: createdGarageId,
            makeId: newVehicle.makeId,
            modelId: newVehicle.modelId,
            year: newVehicle.year ? Number(newVehicle.year) : undefined,
            licensePlate: newVehicle.licensePlate || undefined,
            vin: newVehicle.vin || undefined,
          }),
        });
      } catch (e: unknown) {
        setCpWizardError(e instanceof Error ? e.message : t('slot.errGeneric'));
        setSavingCp(false);
        return;
      } finally {
        setSavingCp(false);
      }
    }
    const display =
      newCp.companyName ||
      [newCp.lastName, newCp.firstName].filter(Boolean).join(' ') ||
      t('wizard.noName');
    setCpDisplay(display);
    setForm(f => ({ ...f, counterpartyId: createdCpId, counterpartyDisplay: display }));
    setNewCpOpen(false);
  };

  useEffect(() => {
    if (!open) {
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

  // Якщо 1 авто — одразу ставимо vehicleId; якщо >1 — показуємо Select; якщо 0 — ховаємо.
  // form.vehicleId НЕ в deps щоб уникнути циклу: ефект сам пише в form.vehicleId.
  // Замість stale closure — читаємо актуальне значення через formRef.
  const formRef = useRef(form);
  formRef.current = form;
  useEffect(() => {
    if (!open || !form.counterpartyId) {
      setCpVehicles([]);
      return;
    }
    // скидаємо cpVehicles ОДРАЗУ при старті нового fetch, щоб не показувати
    // vehicles попереднього клієнта поки нові завантажуються.
    setCpVehicles([]);
    const ac = new AbortController();
    const fetchedForId = form.counterpartyId;
    // `void`: IIFE має власний try/catch (скидає cpVehicles), effect не має куди чекати.
    void (async () => {
      try {
        // sto-optimize: bulk `/vehicles?counterpartyId=X` (join through customerGarage)
        // замінює waterfall garages → per-garage vehicles fetch (N+1 → 1 RTT).
        const all = await apiFetch<VehicleOption[]>(`/vehicles?counterpartyId=${fetchedForId}`, {
          signal: ac.signal,
        });
        if (ac.signal.aborted || !mountedRef.current) return;
        setCpVehicles(all);
        // defense-in-depth: vehicleId inherited from prior client (via WO picker or edit slot)
        // — if it belongs to none of the new client's vehicles, it leaks to newWo POST → invalid FK.
        // Reset prevents auto-fill for 1-vehicle client from being blocked:
        // і newWo POST отримує invalid FK.
        const currentVid = formRef.current.vehicleId;
        const stillValid = currentVid && all.some(v => v.id === currentVid);
        if (currentVid && !stillValid) {
          adjustForm(f => ({ ...f, vehicleId: '' }));
        }
        if (all.length === 1 && !stillValid) {
          adjustForm(f => ({ ...f, vehicleId: all[0].id }));
        }
      } catch {
        if (!ac.signal.aborted && mountedRef.current) setCpVehicles([]);
      }
    })();
    return () => {
      ac.abort();
    };
  }, [open, form.counterpartyId, adjustForm, vehiclesRefetchKey]);

  // ── Робочі години філії підйомника (BR-CAL-017) ──────────────────────────
  // Сервер ділить запис і перевіряє планові дати за годинами й днями філії ПІДЙОМНИКА запису;
  // форма рахує за ними ж (`formWorkHours`). Сітка дня лишається на основній філії. Підйомник не
  // обрано чи його філія невідома — години основної філії.
  const wh = useMemo<WorkHoursWindow>(
    () =>
      formWorkHours ?? {
        startHour: windowStart,
        endHour: windowEnd,
        ...(windowWorkDays && { workDays: windowWorkDays }),
      },
    [formWorkHours, windowStart, windowEnd, windowWorkDays],
  );

  // Ланцюжок НАРЯДУ: внутрішні межі не змінюються (BR-WO-024 — сервер відповів би 400), нормогодини
  // не перераховуються. Ручний ланцюжок (BR-CAL-020) — як новий запис: «Початок» — початок першого
  // дня, «Кінець» — кінець останнього, нормогодини між ними, частини за годинами філії підйомника;
  // збереження з `chainSpan` перебудовує ланцюжок (видалення — «Видалити всі N днів?», BR-CAL-019).
  const woChain = editingChain !== null && editingWorkOrder !== null ? editingChain : null;
  const manualChain = editingChain !== null && editingWorkOrder === null ? editingChain : null;
  const isChain = woChain !== null;
  // Сервер ділить на дні новий запис, запис наряду й ручний ланцюжок; зміна одноденного ручного
  // запису — один запис.
  const splits = !editingSlotId || !!form.workOrderId || manualChain !== null;
  // День «Початку»: ручний ланцюжок — день першої частини (форму відкрито з будь-якого дня), інакше
  // день сторінки. День «Кінця», поки нормогодини його не дають, — день останньої частини.
  const chainLocal = (iso: string | undefined) =>
    iso ? isoToKyivLocalDateTime(new Date(iso)).slice(0, 10) : '';
  const startDay = (manualChain && chainLocal(manualChain.startAt)) || date;
  const endDay = (manualChain && chainLocal(manualChain.endAt)) || date;
  // Наряд запису відкріплено у формі (×, зміна чи очищення клієнта) — збереження видалить запис.
  const unlinking = !!editingSlotId && editingWorkOrder !== null && !form.workOrderId;

  /**
   * Кінець запису («YYYY-MM-DDTHH:mm») за початком «HH:mm» дня `date` і нормогодинами: новий запис
   * і запис наряду — у робочих годинах філії на скільки завгодно днів (BR-CAL-007, №72); зміна
   * ручного запису — «початок + тривалість» на тому ж дні (сервер його не ділить). '' — немає.
   */
  const endFor = useCallback(
    (startHHmm: string, normoHours: string): string => {
      const nh = hoursOf(normoHours);
      if (!startDay || !startHHmm || !(nh > 0)) return '';
      const start = `${startDay}T${startHHmm}`;
      if (splits) return slotEndFromHours(start, nh, wh);
      const [h, m] = startHHmm.split(':').map(Number);
      const total = Math.min((h ?? 0) * 60 + (m ?? 0) + Math.round(nh * 60), 23 * 60 + 59);
      return `${date}T${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
    },
    [date, startDay, splits, wh],
  );

  /**
   * Кінець попереднього блоку сітки дня (`pendingSlot.endH`) для кінця `end` («YYYY-MM-DDTHH:mm»):
   * на дні запису — його година; запис на кілька днів — закриття дня (перша частина).
   */
  const pendingEndH = useCallback(
    (end: string): number => {
      if (end.slice(0, 10) !== date) return wh.endHour;
      const { h, m } = parseHHMM(end.slice(11, 16));
      return h + m / 60;
    },
    [date, wh.endHour],
  );

  const startLocal = startDay && form.startAt ? `${startDay}T${form.startAt}` : '';
  const plannedEnd = isChain ? '' : endFor(form.startAt, form.normoHours);
  // Кінець, який показує поле й шле форма: за нормогодинами, доки «Кінець» з ними збігається;
  // інакше — час поля на дні запису (ланцюжок, ручний ввід).
  const endLocal =
    plannedEnd && plannedEnd.slice(11, 16) === form.endAt
      ? plannedEnd
      : endDay && form.endAt
        ? `${endDay}T${form.endAt}`
        : '';
  const endDate = endLocal ? endLocal.slice(0, 10) : date;
  // Частини, на які сервер поділить запис (BR-CAL-007, BR-CAL-016) — підказка «Буде розбито».
  const parts = useMemo(
    () => (splits && !isChain && startLocal && endLocal ? slotParts(startLocal, endLocal, wh) : []),
    [splits, isChain, startLocal, endLocal, wh],
  );
  // Найраніша година початку: для нового запису сьогодні — не раніше поточної (`minHour`).
  const startMinHour =
    editingSlotId || minHour === windowStart ? wh.startHour : Math.max(minHour, wh.startHour);

  // BR-CAL-017: години філії підйомника змінились (обрано підйомник іншої філії, години його філії
  // довантажились) чи форму відкрито на новий запис (час із сітки — «початок + тривалість» того ж
  // дня) — кінець нового запису за нормогодинами рахується знову: інакше «Кінець» лишився б часом за
  // годинами попередньої філії (для запису на кілька днів — «раніше початку»).
  const recalcKey = [
    wh.startHour,
    wh.endHour,
    (wh.workDays ?? []).join(','),
    open,
    editingSlotId,
    date,
    form.startAt,
    form.liftId,
  ].join('|');
  const recalcKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (recalcKeyRef.current === recalcKey) return;
    recalcKeyRef.current = recalcKey;
    if (!open || editingSlotId || fieldsLocked) return;
    const { startAt, normoHours, endAt } = formRef.current;
    const end = endFor(startAt, normoHours);
    if (!end || end.slice(11, 16) === endAt) return;
    adjustForm(f => ({ ...f, endAt: end.slice(11, 16) }));
    setPendingSlot(p => (p ? { ...p, endH: pendingEndH(end) } : p));
  }, [
    recalcKey,
    open,
    editingSlotId,
    fieldsLocked,
    endFor,
    pendingEndH,
    adjustForm,
    setPendingSlot,
  ]);

  // BR-CAL-020: ручний ланцюжок — нормогодини між його межами за годинами філії підйомника, щойно
  // форму відкрито, ланцюжок перечитано чи години філії змінились (обрано підйомник іншої філії,
  // години довантажились). Поки межі у формі збережені — лише нормогодини (і знімок форми: це не
  // незбережена зміна); змінені межі — кінець за нормогодинами, як у нового запису.
  const chainHoursKey = manualChain
    ? [
        editingSlotId,
        manualChain.startAt,
        manualChain.endAt,
        wh.startHour,
        wh.endHour,
        (wh.workDays ?? []).join(','),
      ].join('|')
    : null;
  const chainHoursKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const keyChanged = chainHoursKeyRef.current !== chainHoursKey;
    chainHoursKeyRef.current = chainHoursKey;
    if (!open || !manualChain?.startAt) return;
    const savedStart = isoToKyivLocalDateTime(new Date(manualChain.startAt));
    const savedEnd = isoToKyivLocalDateTime(new Date(manualChain.endAt));
    const { startAt, endAt, normoHours } = formRef.current;
    if (startAt === savedStart.slice(11, 16) && endAt === savedEnd.slice(11, 16)) {
      if (!keyChanged && normoHours !== '') return;
      const nh = slotHoursBetween(savedStart, savedEnd, wh);
      if (nh && nh !== normoHours) adjustForm(f => ({ ...f, normoHours: nh }));
      return;
    }
    if (!keyChanged || fieldsLocked) return;
    const end = endFor(startAt, normoHours);
    if (end && end.slice(11, 16) !== endAt) adjustForm(f => ({ ...f, endAt: end.slice(11, 16) }));
  }, [chainHoursKey, open, manualChain, form.normoHours, wh, fieldsLocked, endFor, adjustForm]);

  // Conflict check when liftId / employeeId / times change
  useEffect(() => {
    if (!open) {
      clearConflict();
      return;
    }
    const startIso = form.startAt ? kyivDateTimeToISO(startDay, form.startAt) : null;
    // Кінець — справжній (на дні завершення), як у збереженні: багатоденний запис перевіряється
    // на всіх днях, а не на «кінці» першого дня. Зміну ручного запису сервер не ділить (`splits`)
    // — 17:00–20:00 лишається 17:00–20:00, а не «завтра до 11:00».
    const realEnd =
      startLocal && endLocal ? slotRealEnd(startLocal, endLocal, splits ? wh : NO_SPLIT) : '';
    const endIso = realEnd ? kyivDateTimeToISO(realEnd.slice(0, 10), realEnd.slice(11, 16)) : null;
    if (!startIso || !endIso) {
      clearConflict();
      return;
    }
    checkConflict({
      liftId: form.liftId || undefined,
      employeeId: form.employeeId || undefined,
      startAt: startIso,
      endAt: endIso,
      excludeSlotId: editingSlotId ?? undefined,
    });
  }, [
    open,
    form.liftId,
    form.employeeId,
    form.startAt,
    startLocal,
    endLocal,
    wh,
    splits,
    startDay,
    editingSlotId,
    checkConflict,
    clearConflict,
  ]);

  // ── New work-order modal ──────────────────────────────────────────────────
  const [createWoOpen, setCreateWoOpen] = useState(false);
  /**
   * BR-WO-020 (скарга власника 2026-11-13): наряд із форми НАЯВНОГО запису без наряду забирає сам
   * запис — картка наряду з датами й підйомником запису (разом із незбереженими змінами форми),
   * сервер ставить запис на дати наряду (`calendarSlotId`) і другого не створює. Ланцюжок — від
   * початку першого дня до кінця останнього; з продовження початку першого дня форма не знає —
   * тоді як раніше: наряд без дат, прив'язка кнопкою «Оновити».
   */
  const adoptRange = (() => {
    if (!editingSlotId || editingWorkOrder !== null || serviceType || isEditingPast) return null;
    // Ручний ланцюжок — межі всього ланцюжка з будь-якого дня (BR-CAL-020).
    return startLocal && endLocal
      ? { slotId: editingSlotId, start: startLocal, end: endLocal }
      : null;
  })();
  const [createWoEditId, setCreateWoEditId] = useState<string | undefined>(undefined);

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

  /**
   * BR-WO-028 (рішення власника №67): відв'язка наряду («×», зміна чи очищення клієнта) видаляє
   * весь ланцюжок запису наряду, наряд зберігає дати. Спершу спитати — запис зникне з календаря;
   * далі лише `workOrderId: null`: інші поля сервер не застосовує (запису вже немає), а перевірки
   * форми («Оберіть клієнта» після очищення клієнта) відв'язку не мають блокувати.
   */
  const unlinkSlot = async (slotId: string) => {
    const number = editingWorkOrder?.number ?? '';
    const ok = await confirm({
      title: t('slot.unlinkConfirmTitle'),
      message: t('slot.unlinkConfirmMessage', { number }),
      variant: 'destructive',
    });
    if (!ok) return;
    setSaving(true);
    setError('');
    try {
      const saved = await apiFetch<CalendarSlot>(`/calendar/slots/${slotId}`, {
        method: 'PATCH',
        body: JSON.stringify({ workOrderId: null }),
      });
      toast.success(saved?.removed ? t('slot.toastUnlinked', { number }) : t('slot.toastUpdated'));
      // Наряд утратив запис календаря — кеш нарядів скидає власник форми (запис мав наряд).
      onSaved({ workOrderChanged: true });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : t('slot.errSaveFallback');
      setError(msg);
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  };

  const addSlot = async () => {
    if (unlinking && editingSlotId) {
      await unlinkSlot(editingSlotId);
      return;
    }
    if (!form.startAt || !form.endAt) {
      setError(t('slot.errStartEndRequired'));
      return;
    }
    if (!endLocal || endLocal <= startLocal) {
      setError(t('slot.errEndAfterStart'));
      return;
    }
    if (!serviceType && !form.counterpartyId && !form.workOrderId) {
      setError(t('slot.errSelectClient'));
      return;
    }
    if (!form.liftId) {
      setError(t('slot.errSelectLift'));
      return;
    }
    if (!UUID_RE.test(form.liftId)) {
      setError(t('slot.errInvalidLift'));
      return;
    }
    if (form.employeeId && !UUID_RE.test(form.employeeId)) {
      setError(t('slot.errInvalidEmployee'));
      return;
    }
    if (form.workOrderId && !UUID_RE.test(form.workOrderId)) {
      setError(t('slot.errSelectWorkOrder'));
      return;
    }
    if (!editingSlotId && nowMs) {
      // sto-optimize: toDateString module-level singleton замість per-call
      // .toLocaleDateString({ timeZone: KYIV_TZ }) — той самий sv-SE Kyiv-TZ формат.
      const todayKyiv = toDateString(new Date(nowMs));
      if (date < todayKyiv) {
        setError(t('slot.errPastCreate'));
        return;
      }
      if (date === todayKyiv) {
        const slotHour = parseInt(form.startAt.split(':')[0] ?? '0', 10);
        if (slotHour < minHour) {
          setError(t('slot.errPastCreate'));
          return;
        }
      }
    }
    // DST-aware: kyivDateTimeToISO замість `new Date(...).toISOString()`
    // local-парсингу без TZ (+02 зима, +03 літо).
    const startIso = kyivDateTimeToISO(startDay, form.startAt);
    // Справжній кінець — на дні завершення (№72: скільки завгодно днів, без обрізання до 23:59);
    // сервер ділить запис на ті самі частини, що показує підказка.
    const endIso = kyivDateTimeToISO(endDate, endLocal.slice(11, 16));
    if (!date || !form.startAt || !form.endAt || !startIso || !endIso) {
      setError(t('slot.errInvalidDateTime'));
      return;
    }
    setSaving(true);
    setError('');
    const body = {
      liftId: form.liftId || undefined,
      // «— без механіка —» у зміні запису знімає механіка (`null`); у новому — поля просто немає.
      employeeId: form.employeeId || (editingSlotId ? null : undefined),
      // Наряд відкріплено у зміні запису (очищено поле, змінено клієнта) — `null`, як механік:
      // без нього сервер лишав наряд, а новий час переносив у ВІДКРІПЛЕНИЙ наряд (BR-WO-024).
      workOrderId: form.workOrderId || (editingSlotId ? null : undefined),
      counterpartyId: form.counterpartyId || undefined,
      vehicleId: form.vehicleId || undefined,
      startAt: startIso,
      endAt: endIso,
      // Стерта примітка у зміні запису — `null` (Bug #901): без нього сервер лишав стару.
      notes: form.notes || (editingSlotId ? null : undefined),
      // BR-CAL-020: межі форми — межі всього ручного ланцюжка, а не дня, з якого її відкрито;
      // і з обраним нарядом — перев'язка бере ці межі датами наряду (Bug #1063).
      ...(manualChain && { chainSpan: true }),
    };
    try {
      if (editingSlotId) {
        const saved = await apiFetch<CalendarSlot & MechanicDropResponse>(
          `/calendar/slots/${editingSlotId}`,
          { method: 'PATCH', body: JSON.stringify(body) },
        );
        toast.success(t('slot.toastUpdated'));
        // BR-WO-028 (рішення власника 2026-10-19): перев'язка на наряд з іншим підйомником знімає
        // механіка, не закріпленого за ним, — сказати чому, як при перетягуванні.
        if (saved?.mechanicDropped) {
          const lift = lifts.find(l => l.id === saved.liftId)?.name ?? '';
          toast.warning(
            mechanicDroppedText(
              t,
              saved.mechanicDroppedReason,
              savedMechanic?.employeeName ?? null,
              lift,
            ),
          );
        }
      } else {
        // Тип — лише в новому записі: після створення він не змінюється (PATCH з `type` — 400).
        const res = await apiFetch<{ slots: CalendarSlot[] }>('/calendar/slots', {
          method: 'POST',
          body: JSON.stringify({ ...body, type: form.type }),
        });
        // BR-WO-028 (Bug #905): запис для наряду з датами стає на дати й підйомник наряду, а не
        // на час форми — сказати, чому запис не там, куди його ставили. Тоді ЛИШЕ це пояснення:
        // «Слот створено» поруч читалось як «створено там, куди протягнули» (огляд 2026-10-29).
        const first = res.slots[0];
        const onWoDates =
          !!form.workOrderId &&
          !!first &&
          (new Date(first.startAt).getTime() !== new Date(startIso).getTime() ||
            (first.liftId ?? '') !== form.liftId);
        if (onWoDates) {
          toast.info(t('slot.toastWoSlotOnWoDates'));
        } else if (res.slots.length > 1) {
          // BR-CAL-007 (№72): запис поділено на стільки робочих днів, скільки займає.
          const saved = res.slots.map(x => ({
            start: isoToKyivLocalDateTime(new Date(x.startAt)),
            end: isoToKyivLocalDateTime(new Date(x.endAt)),
          }));
          toast.success(
            t('slot.toastSplitDays', {
              count: saved.length,
              parts: saved.map(partLabel).join(', '),
            }),
          );
        } else {
          toast.success(t('slot.toastCreated'));
        }
      }
      // Запис із нарядом (новий теж — BR-WO-028 дає наряду дати) змінює картку й списки нарядів.
      onSaved({ workOrderChanged: !!form.workOrderId });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : t('slot.errSaveFallback');
      setError(msg);
      toast.error(msg);
      // 400 «Механік не закріплений за цим підйомником» (BR-CAL-012): механіка відкріпили після
      // відкриття форми — перелік підйомника застарів, перечитати (відкріпленого поле скине).
      if (form.employeeId && form.liftId) setMechanicsReloadKey(k => k + 1);
    } finally {
      setSaving(false);
    }
  };

  /**
   * Наряд, створений із цієї форми, уже має запис календаря (BR-WO-020). Механік форми
   * переноситься на запис наряду (PATCH самого запису); відмова сервера (механік зайнятий,
   * багатоденний запис) не скасовує наряду — лише попереджає. Наряд забрав НАЯВНИЙ запис
   * (`adopted`), а механіка в формі прибрали без збереження — запис наряду теж без механіка:
   * сервер лишає збереженого механіка запису.
   */
  const adoptWorkOrderSlot = async (wo: CreatedWorkOrder, adopted: boolean) => {
    const employeeId = form.employeeId;
    const clearsSaved = adopted && !employeeId && !!savedMechanic?.employeeId;
    if (employeeId || clearsSaved) {
      try {
        const linked = await apiFetch<{ calendarSlots: { id: string; startAt: string }[] }>(
          `/work-orders/${wo.id}/linked-documents`,
        );
        // Перша частина запису (найраніша) — та, на якій тримається механік.
        const anchor = [...linked.calendarSlots].sort((x, y) =>
          x.startAt.localeCompare(y.startAt),
        )[0];
        if (anchor) {
          await apiFetch(`/calendar/slots/${anchor.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ employeeId: employeeId || null }),
          });
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : t('slot.errSaveFallback');
        toast.warning(t('slot.toastWoMechanicNotSet', { error: msg }));
      }
    }
    toast.success(t('slot.toastWoCreatedWithSlot', { number: wo.number }));
    // Новий наряд із записом — списки й лічильники нарядів перечитуються.
    onSaved({ workOrderChanged: true });
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
          marginBottom: formVisible ? '0.75rem' : '0px',
          transition: formVisible
            ? 'height 480ms cubic-bezier(0.22,1,0.36,1), margin-bottom 480ms cubic-bezier(0.22,1,0.36,1)'
            : undefined,
        }}
      >
        <div
          ref={formInnerRef}
          className="bg-surface border border-border rounded-xl p-4 space-y-2"
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
                ? t('slot.titleViewPast')
                : t('slot.titleEdit')
              : pendingSlot && startLocal && endLocal
                ? // Кінець на іншому дні — з його датою: запис на N днів (BR-CAL-007, №72), а
                  // не «завтра» з годин блоку сітки.
                  t('slot.titleNewRange', {
                    start: `${fmtKyivDate(`${date}T12:00:00Z`)} ${form.startAt}`,
                    end:
                      endLocal.slice(0, 10) === date
                        ? endLocal.slice(11, 16)
                        : `${fmtKyivDate(`${endLocal.slice(0, 10)}T12:00:00Z`)} ${endLocal.slice(11, 16)}`,
                  })
                : pendingSlot
                  ? (() => {
                      const s = decimalHoursToHHMM(pendingSlot.startH);
                      const e = decimalHoursToHHMM(pendingSlot.endH);
                      const startDmy = fmtKyivDate(`${date}T12:00:00Z`);
                      if (pendingSlot.endH < pendingSlot.startH) {
                        try {
                          const d = new Date(`${date}T12:00:00Z`);
                          d.setUTCDate(d.getUTCDate() + 1);
                          const endDmy = fmtKyivDate(d.toISOString());
                          return t('slot.titleNewRange', {
                            start: `${startDmy} ${s}`,
                            end: `${endDmy} ${e}`,
                          });
                        } catch {
                          return t('slot.titleNewRange', { start: `${startDmy} ${s}`, end: e });
                        }
                      }
                      return t('slot.titleNewRange', { start: `${startDmy} ${s}`, end: e });
                    })()
                  : t('slot.titleNewOn', { date: fmtDate(date) })}
          </h3>
          {error && <p className="text-[13px] text-destructive-text">{error}</p>}

          {isEditingPast && (
            <div className="flex items-center gap-2 text-[13px] text-warning-text bg-warning-subtle border border-warning/20 rounded-lg px-3 py-2">
              <span>🔒</span>
              <span>{readOnly ? t('slot.roleLocked') : t('slot.pastLocked')}</span>
            </div>
          )}
          {woLockedStatus && (
            <div
              className="flex items-center gap-2 text-[13px] text-warning-text bg-warning-subtle border border-warning/20 rounded-lg px-3 py-2"
              data-testid="slot-wo-time-locked"
            >
              <span aria-hidden="true">🔒</span>
              <span>
                {t(cancelledWorkOrder ? 'slot.woTimeLockedCancelled' : 'slot.woTimeLocked', {
                  status: woStatusLabel(woLockedStatus),
                })}
              </span>
            </div>
          )}

          {/* Шість полів у рядок — лише від 2xl: вужчий стовпець обрізав би дату й час (Bug #878) */}
          <div className="grid grid-cols-3 2xl:grid-cols-6 gap-3 items-start">
            <div title={editingSlotId ? t('slot.typeLocked') : undefined}>
              <label
                htmlFor={typeSelectId}
                className="block text-[13px] font-medium text-muted-foreground mb-1"
              >
                {t('slot.fieldType')}
              </label>
              <Select
                id={typeSelectId}
                value={form.type}
                // BR-CAL-003: тип обирають лише в новому записі; після створення — незмінний.
                disabled={!!editingSlotId || isEditingPast}
                aria-describedby={editingSlotId ? typeHintId : undefined}
                onChange={e => changeType(slotType(e.target.value))}
                className="h-8 text-[13px] py-0.5 px-2 pr-7"
              >
                {SLOT_TYPES.map(type => (
                  <option key={type} value={type}>
                    {t(`month.type.${type}`)}
                  </option>
                ))}
              </Select>
              {editingSlotId && (
                <span id={typeHintId} className="sr-only">
                  {t('slot.typeLocked')}
                </span>
              )}
            </div>
            <div>
              <label
                htmlFor={liftSelectId}
                className="block text-[13px] font-medium text-muted-foreground mb-1"
              >
                {t('slot.fieldLift')} <span className="text-destructive">*</span>
              </label>
              <Select
                id={liftSelectId}
                value={form.liftId}
                disabled={fieldsLocked}
                onChange={e => setForm(f => ({ ...f, liftId: e.target.value }))}
                className="h-8 text-[13px] py-0.5 px-2 pr-7"
              >
                <option value="">{t('slot.liftAny')}</option>
                {lifts.map(l => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </Select>
            </div>
            <CalendarMechanicField
              liftId={form.liftId}
              value={form.employeeId}
              onChange={setMechanic}
              saved={savedMechanic}
              disabled={isEditingPast}
              reloadKey={mechanicsReloadKey}
            />
            <div>
              <DateTimePickerInput
                label={t('slot.fieldStart')}
                value={startLocal}
                minHour={startMinHour}
                maxHour={wh.endHour - 1}
                // BR-WO-024: початок продовження — внутрішня межа ланцюжка.
                disabled={fieldsLocked || (woChain !== null && !woChain.isFirst)}
                inputClassName="h-8 text-[13px]"
                onChange={val => {
                  const start = val ? val.slice(11, 16) : '';
                  setForm(f => {
                    let next = { ...f, startAt: start };
                    // Ланцюжок: кінець першого дня — внутрішня межа, не перераховується.
                    const end = isChain ? '' : endFor(start, f.normoHours);
                    if (end) next = { ...next, endAt: end.slice(11, 16) };
                    if (pendingSlot) {
                      const { h: sh, m: sm } = parseHHMM(start);
                      const { h: eh, m: em } = parseHHMM(next.endAt || start);
                      const endH = end ? pendingEndH(end) : eh + em / 60;
                      setPendingSlot(p => (p ? { ...p, startH: sh + sm / 60, endH } : p));
                    }
                    return next;
                  });
                }}
              />
            </div>
            <div>
              <label className="block text-[13px] font-medium text-muted-foreground mb-1">
                {t('slot.fieldNormoHours')}{' '}
                <span className="font-normal text-muted-foreground/70">
                  {t('slot.normoHoursHint')}
                </span>
              </label>
              <Input
                type="number"
                step="0.5"
                min="0.5"
                value={form.normoHours}
                // Ланцюжок: тривалість змінюють межі першого й останнього дня (BR-WO-024).
                disabled={fieldsLocked || isChain}
                className="h-8 text-[13px]"
                onChange={e => {
                  const nh = e.target.value;
                  setForm(f => {
                    const end = endFor(f.startAt, nh);
                    if (!end) return { ...f, normoHours: nh };
                    const endAt = end.slice(11, 16);
                    if (pendingSlot)
                      setPendingSlot(p => (p ? { ...p, endH: pendingEndH(end) } : p));
                    return { ...f, normoHours: nh, endAt };
                  });
                }}
                placeholder={t('slot.normoHoursPlaceholder')}
              />
              {/* Частини запису за робочими днями філії підйомника — так його поділить сервер
                  (BR-CAL-007, BR-CAL-016): усі дні, без обрізання. */}
              {parts.length > 1 && (
                <p
                  className="mt-1 text-[11px] text-amber-600 dark:text-amber-400"
                  data-testid="slot-split-warning"
                >
                  {t('slot.splitWarningDays', {
                    count: parts.length,
                    parts: parts.map(partLabel).join(', '),
                  })}
                </p>
              )}
            </div>
            <div>
              {/* Кінець — на дні завершення: багатоденний запис закінчується через N робочих днів */}
              <DateTimePickerInput
                label={t('slot.fieldEnd')}
                value={endLocal}
                minHour={wh.startHour}
                maxHour={23}
                // BR-WO-024: кінець не останнього дня ланцюжка — внутрішня межа.
                disabled={fieldsLocked || (woChain !== null && !woChain.isLast)}
                inputClassName="h-8 text-[13px]"
                onChange={val => {
                  let endAt = val ? val.slice(11, 16) : '';
                  let endFull = val ? `${endDay}T${endAt}` : '';
                  let normoHours: string | null = null;
                  if (val && startLocal && !isChain && val > startLocal) {
                    // Нормогодини — як їх прочитає сервер (кінець того ж дня понад закриття —
                    // «початок + тривалість» із залишком на наступні робочі дні); кінець — з них.
                    normoHours = slotHoursBetween(startLocal, val, splits ? wh : NO_SPLIT) || null;
                    const end = normoHours ? endFor(form.startAt, normoHours) : '';
                    if (end) {
                      endAt = end.slice(11, 16);
                      endFull = end;
                    }
                  }
                  setForm(f => ({ ...f, endAt, ...(normoHours !== null && { normoHours }) }));
                  if (pendingSlot && endFull)
                    setPendingSlot(p => (p ? { ...p, endH: pendingEndH(endFull) } : p));
                }}
              />
            </div>
          </div>

          {woChain && !fieldsLocked && (
            <p className="text-[12px] text-muted-foreground" data-testid="slot-chain-hint">
              {t('slot.chainEdgeLocked', { count: woChain.days })}
            </p>
          )}

          {/* Клієнт + Автомобіль — в одному рядку; службовому запису їх немає (BR-CAL-003) */}
          {!serviceType && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[13px] font-medium text-muted-foreground mb-1">
                  {t('slot.fieldClient')} <span className="text-destructive-text">*</span>
                </label>
                <div className="flex items-center gap-1">
                  <div className="flex-1 min-w-0">
                    <EntityPickerField<CpItem>
                      className="h-8 text-[13px]"
                      display={form.counterpartyDisplay}
                      placeholder={t('slot.clientPlaceholder')}
                      disabled={fieldsLocked}
                      hidePick={fieldsLocked}
                      onOpenDetail={form.counterpartyId ? () => void openCpDetail() : undefined}
                      onPick={() => setCpPickerOpen(true)}
                      onSearch={!fieldsLocked ? fetchCpItems : undefined}
                      onSearchSelect={item => {
                        void (async () => {
                          if (
                            form.workOrderId &&
                            form.counterpartyId &&
                            item.id !== form.counterpartyId
                          ) {
                            const ok = await confirm({
                              title: t('slot.changeClientConfirmTitle'),
                              message: t('slot.changeClientConfirmMessage', {
                                wo: form.workOrderDisplay,
                              }),
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
                        })();
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
                  {!fieldsLocked && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={openNewCpWizard}
                      title={t('slot.newClientTitle')}
                      className="h-8 w-8 p-0 shrink-0"
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
                <label className="block text-[13px] font-medium text-muted-foreground mb-1">
                  {t('slot.fieldVehicle')} <span className="text-destructive-text">*</span>
                </label>
                <select
                  className="w-full h-8 rounded-md border border-input bg-background px-3 text-[13px] focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
                  value={form.vehicleId}
                  disabled={fieldsLocked || cpVehicles.length === 0}
                  onChange={e => setForm(f => ({ ...f, vehicleId: e.target.value }))}
                >
                  {cpVehicles.length === 0 ? (
                    <option value="">
                      {form.counterpartyId ? t('slot.noVehicles') : t('slot.selectClientFirst')}
                    </option>
                  ) : (
                    <>
                      <option value="">{t('slot.selectVehicle')}</option>
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
          )}

          {/* Наряд; службовому запису його немає (BR-CAL-003) */}
          {!serviceType && (
            <div>
              <label className="block text-[13px] font-medium text-muted-foreground mb-1">
                {t('slot.fieldWorkOrder')}
              </label>
              <div className="flex items-center gap-1">
                <div className="flex-1 min-w-0">
                  <EntityPickerField<WoItem>
                    className="h-8 text-[13px]"
                    display={form.workOrderDisplay}
                    placeholder={t('slot.workOrderPlaceholder')}
                    disabled={fieldsLocked}
                    hidePick={fieldsLocked}
                    onOpenDetail={
                      form.workOrderId
                        ? () => {
                            setCreateWoEditId(form.workOrderId || undefined);
                            setCreateWoOpen(true);
                          }
                        : undefined
                    }
                    onPick={() => setWoPickerOpen(true)}
                    onSearch={!fieldsLocked ? fetchWoItems : undefined}
                    onSearchSelect={item => {
                      void (async () => {
                        const display = item.counterpartyName
                          ? `${item.primary} · ${item.counterpartyName}`
                          : item.primary;

                        if (
                          item.counterpartyId &&
                          form.counterpartyId &&
                          item.counterpartyId !== form.counterpartyId
                        ) {
                          const replace = await confirm({
                            title: t('slot.replaceClientTitle'),
                            message: t('slot.replaceClientMessage', {
                              client: item.counterpartyName ?? item.counterpartyId,
                            }),
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
                            setForm(f => ({
                              ...f,
                              workOrderId: item.id,
                              workOrderDisplay: display,
                            }));
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
                      })();
                    }}
                    onClear={() => setForm(f => ({ ...f, workOrderId: '', workOrderDisplay: '' }))}
                  />
                </div>
                {!fieldsLocked && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setCreateWoEditId(undefined);
                      setCreateWoOpen(true);
                    }}
                    title={t('slot.newWorkOrderTitle')}
                    className="h-8 w-8 p-0 shrink-0"
                  >
                    <FilePlus className="h-4 w-4" />
                  </Button>
                )}
              </div>
            </div>
          )}

          {/* New client wizard modal */}
          <Modal
            open={newCpOpen}
            onClose={() => setNewCpOpen(false)}
            title={newCpStep === 1 ? t('wizard.titleClient') : t('wizard.titleVehicle')}
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
                    {s === 1 ? t('wizard.stepClient') : t('wizard.stepVehicle')}
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
                    label={t('wizard.firstName')}
                    placeholder={t('wizard.firstNamePlaceholder')}
                    value={newCp.firstName}
                    onChange={e => setNewCp(v => ({ ...v, firstName: e.target.value }))}
                  />
                  <Input
                    label={t('wizard.lastName')}
                    placeholder={t('wizard.lastNamePlaceholder')}
                    value={newCp.lastName}
                    onChange={e => setNewCp(v => ({ ...v, lastName: e.target.value }))}
                  />
                </div>
                <Input
                  label={t('wizard.companyName')}
                  placeholder={t('wizard.companyNamePlaceholder')}
                  value={newCp.companyName}
                  onChange={e => setNewCp(v => ({ ...v, companyName: e.target.value }))}
                />
                <div className="grid grid-cols-2 gap-3">
                  <PhoneInput
                    label={t('wizard.phone')}
                    value={newCp.phone}
                    onChange={e => setNewCp(v => ({ ...v, phone: e.target.value }))}
                  />
                  <Input
                    label={t('wizard.email')}
                    type="email"
                    placeholder={t('wizard.emailPlaceholder')}
                    value={newCp.email}
                    onChange={e => setNewCp(v => ({ ...v, email: e.target.value }))}
                  />
                </div>
                <div className="flex gap-2 pt-2">
                  <Button
                    onClick={() => void saveWizardStep1()}
                    loading={savingCp}
                    disabled={!newCp.firstName && !newCp.lastName && !newCp.companyName}
                  >
                    {t('wizard.next')}
                  </Button>
                  <Button variant="outline" onClick={() => setNewCpOpen(false)}>
                    {t('wizard.cancel')}
                  </Button>
                </div>
              </div>
            )}

            {newCpStep === 2 && (
              <div className="space-y-3">
                <VehicleMakeModelFields
                  idPrefix="wizard-vehicle"
                  makeId={newVehicle.makeId}
                  modelId={newVehicle.modelId}
                  onMakeChange={makeId => setNewVehicle(v => ({ ...v, makeId }))}
                  onModelChange={modelId => setNewVehicle(v => ({ ...v, modelId }))}
                />
                <div className="grid grid-cols-2 gap-3">
                  <Input
                    label={t('wizard.year')}
                    placeholder={t('wizard.yearPlaceholder')}
                    value={newVehicle.year}
                    onChange={e => setNewVehicle(v => ({ ...v, year: e.target.value }))}
                  />
                  <Input
                    label={t('wizard.licensePlate')}
                    placeholder={t('wizard.licensePlatePlaceholder')}
                    value={newVehicle.licensePlate}
                    onChange={e => setNewVehicle(v => ({ ...v, licensePlate: e.target.value }))}
                  />
                </div>
                <Input
                  label={t('wizard.vin')}
                  placeholder={t('wizard.vinPlaceholder')}
                  value={newVehicle.vin}
                  onChange={e => setNewVehicle(v => ({ ...v, vin: e.target.value }))}
                />
                <div className="flex gap-2 pt-2">
                  <Button
                    onClick={() => void saveWizardStep2(false)}
                    loading={savingCp}
                    disabled={!newVehicle.makeId || !newVehicle.modelId}
                  >
                    {t('wizard.save')}
                  </Button>
                  <Button variant="outline" onClick={() => void saveWizardStep2(true)}>
                    {t('wizard.skip')}
                  </Button>
                </div>
              </div>
            )}
          </Modal>

          {/* Notes */}
          <div>
            <label className="block text-[13px] font-medium text-muted-foreground mb-1">
              {t('slot.fieldNotes')}
            </label>
            <Input
              value={form.notes}
              disabled={isEditingPast}
              onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
              className="h-8 text-[13px]"
            />
          </div>

          {/* Picker modals */}
          <SearchPickerModal<CpItem>
            open={cpPickerOpen}
            onClose={() => setCpPickerOpen(false)}
            title={t('slot.cpPickerTitle')}
            selectedId={form.counterpartyId}
            fetchItems={fetchCpItems}
            searchPlaceholder={t('slot.cpPickerSearchPlaceholder')}
            emptyText={t('slot.cpPickerEmpty')}
            onSelect={item => {
              void (async () => {
                if (form.workOrderId && form.counterpartyId && item.id !== form.counterpartyId) {
                  const ok = await confirm({
                    title: t('slot.changeClientConfirmTitle'),
                    message: t('slot.changeClientConfirmMessage', { wo: form.workOrderDisplay }),
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
              })();
            }}
          />
          <SearchPickerModal<WoItem>
            open={woPickerOpen}
            onClose={() => setWoPickerOpen(false)}
            title={form.counterpartyId ? t('slot.woPickerTitleForClient') : t('slot.woPickerTitle')}
            selectedId={form.workOrderId}
            fetchItems={fetchWoItems}
            searchPlaceholder={t('slot.woPickerSearchPlaceholder')}
            emptyText={t('slot.woPickerEmpty')}
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
                  <div className="text-xs text-muted-foreground/60 mt-0.5">
                    {t('slot.woNotPlanned')}
                  </div>
                )}
              </div>
            )}
            onSelect={item => {
              void (async () => {
                const display = item.counterpartyName
                  ? `${item.primary} · ${item.counterpartyName}`
                  : item.primary;

                if (
                  item.counterpartyId &&
                  form.counterpartyId &&
                  item.counterpartyId !== form.counterpartyId
                ) {
                  const replace = await confirm({
                    title: t('slot.replaceClientTitle'),
                    message: t('slot.replaceClientMessage', {
                      client: item.counterpartyName ?? item.counterpartyId,
                    }),
                  });
                  if (replace) {
                    const cpDisp = item.counterpartyName ?? '';
                    setCpDisplay(cpDisp);
                    setCpPhone(null);
                    // при заміні клієнта через WO picker скидаємо vehicleId і cpVehicles:
                    // без цього form.vehicleId успадковується з минулого клієнта → leak до newWo POST → 400 FK mismatch.
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
                  // defensive: починаємо з чистого vehicleId/cpVehicles
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
              })();
            }}
          />
          {calConflict?.anyConflict && (
            <div className="rounded-md bg-warning-subtle border border-warning/20 px-3 py-2 text-[12px] text-warning">
              ⚠{calConflict.liftConflict && t('slot.conflictLift')}
              {calConflict.employeeConflict && t('slot.conflictEmployee')}
              {t('slot.conflictOverlap', { count: calConflict.conflictSlots.length })}
              {conflictWoNumbers && t('slot.conflictWoNumbers', { numbers: conflictWoNumbers })}
              {t('slot.conflictRejected')}
            </div>
          )}
          <div className="flex items-center gap-2">
            {!isEditingPast && (
              <Button
                onClick={() => void addSlot()}
                loading={saving}
                disabled={
                  // Відв'язка наряду (BR-WO-028) лише видаляє запис — полів для неї не треба:
                  // очищений клієнт (без авто) кнопку не блокує.
                  !unlinking &&
                  (!form.startAt ||
                    !form.endAt ||
                    // Клієнт (з авто) чи наряд — лише для «Роботи»; службовий запис їх не має.
                    (!serviceType &&
                      ((!form.counterpartyId && !form.workOrderId) ||
                        (!!form.counterpartyId && !form.vehicleId))))
                }
              >
                {editingSlotId ? t('slot.update') : t('slot.save')}
              </Button>
            )}
            <Button variant="outline" onClick={onClose}>
              {isEditingPast ? t('slot.close') : t('slot.cancel')}
            </Button>
            {canDelete && (
              // BR-WO-026 (рішення власника 2026-10-19): запис наряду не в редагованому статусі не
              // видаляється — кнопка недоступна, підказка в `title` обгортки (вимкнена кнопка
              // подій миші не отримує) і для читача екрана.
              <span
                className="ml-auto inline-flex"
                title={deleteLockHint ?? undefined}
                data-testid="slot-delete-wrap"
              >
                {deleteLockHint && (
                  <span id={deleteHintId} className="sr-only">
                    {deleteLockHint}
                  </span>
                )}
                <Button
                  variant="destructive"
                  disabled={deleteLockHint !== null}
                  aria-describedby={deleteLockHint ? deleteHintId : undefined}
                  onClick={() => {
                    if (deleteLockHint) return;
                    void (async () => {
                      // BR-WO-026: видалення запису наряду стирає планові дати наряду — попередити.
                      // BR-CAL-019: частина ручного ланцюжка видаляє всі його дні.
                      const ok = await confirm(
                        slotDeleteConfirmOptions(
                          t,
                          editingWorkOrder ? editingWorkOrder.number : null,
                          editingWorkOrder?.lockedStatus ?? null,
                          { chainDays: editingChain?.days, chainEndAt: editingChain?.endAt },
                        ),
                      );
                      if (!ok) return;
                      setSaving(true);
                      try {
                        await apiFetch(`/calendar/slots/${editingSlotId}`, { method: 'DELETE' });
                        toast.success(t('slot.toastDeleted'));
                        onDeleted();
                      } catch (e: unknown) {
                        const msg = e instanceof Error ? e.message : t('slot.errDeleteFallback');
                        setError(msg);
                        toast.error(msg);
                      } finally {
                        setSaving(false);
                      }
                    })();
                  }}
                >
                  <Trash2 className="h-4 w-4 mr-1.5" />
                  {t('slot.delete')}
                </Button>
              </span>
            )}
          </div>
        </div>
      </div>
      <ConfirmDialog {...dialogProps} />
      <CounterpartyEditModal
        open={cpDetailOpen}
        counterparty={cpDetailData}
        onClose={() => setCpDetailOpen(false)}
        onSaved={updated => {
          setCpDetailData(updated);
          const displayName =
            updated.companyName ??
            [updated.lastName, updated.firstName].filter(Boolean).join(' ') ??
            '';
          setCpDisplay(displayName);
          setForm(f => ({ ...f, counterpartyDisplay: displayName }));
          setVehiclesRefetchKey(k => k + 1);
          setCpDetailOpen(false);
        }}
      />
      <CreateWorkOrderModal
        open={createWoOpen}
        workOrderId={createWoEditId}
        onClose={() => {
          setCreateWoOpen(false);
          setCreateWoEditId(undefined);
        }}
        prefill={(() => {
          // Нормогодини з комою («1,5») — як у картці наряду, а не NaN від `Number`.
          const nh = Number(normalizeDecimalInput(String(form.normoHours)));
          // Філія наряду — філія підйомника запису (BR-CAL-017): сервер ділить запис наряду на дні
          // за годинами й днями філії НАРЯДУ, тож інша філія (перша в переліку, вибір вручну)
          // розтягнула б запис на вихідні й неробочі години підйомника.
          const liftBranchId = lifts.find(l => l.id === form.liftId)?.branchId;
          const branch = liftBranchId ? { branchId: liftBranchId } : {};
          if (adoptRange) {
            return {
              ...branch,
              counterpartyId: form.counterpartyId || undefined,
              counterpartyDisplay: form.counterpartyDisplay || undefined,
              vehicleId: form.vehicleId || undefined,
              liftId: form.liftId || undefined,
              description: form.notes || undefined,
              plannedStartAt: adoptRange.start,
              plannedEndAt: adoptRange.end,
              // Ланцюжок — години між датами рахує картка наряду (`calcPlannedHours`).
              plannedHours: !editingChain && nh > 0 ? String(nh) : undefined,
              employeeId: form.employeeId || undefined,
              calendarSlotId: adoptRange.slotId,
            };
          }
          const plannedStartAt =
            !editingSlotId && form.startAt && date ? `${date}T${form.startAt}` : undefined;
          // Рішення власника №64 (BR-WO-019): кінець наряду — автокінець картки наряду в робочих
          // годинах філії підйомника на скільки завгодно днів (`calcEndFromHours`, BR-CAL-017).
          const endFromHours =
            plannedStartAt && nh > 0 ? calcEndFromHours(plannedStartAt, nh, wh) : '';
          return {
            ...branch,
            counterpartyId: form.counterpartyId || undefined,
            counterpartyDisplay: form.counterpartyDisplay || undefined,
            vehicleId: form.vehicleId || undefined,
            liftId: form.liftId || undefined,
            description: form.notes || undefined,
            // guard against `date = ''` on first render before effect default:
            // without guard we'd build "T17:00" — invalid ISO string.
            // Наряд для запису НАРЯДУ чи продовження ручного ланцюжка — без планових дат: інакше
            // сервер створив би наряду власний запис (BR-WO-020) поверх цього ж («Підйомник
            // зайнятий»); наряд прив'язується до запису кнопкою «Оновити», як і раніше.
            plannedStartAt,
            plannedEndAt:
              endFromHours ||
              (!editingSlotId && form.endAt && endDate ? `${endDate}T${form.endAt}` : undefined),
            plannedHours: nh > 0 ? String(nh) : undefined,
            // BR-WO-030: механік запису — виконавець нових робіт наряду.
            employeeId: form.employeeId || undefined,
          };
        })()}
        onUpdated={onWorkOrderChanged}
        onCreated={wo => {
          // BR-WO-020: наряд із плановими початком і завершенням сервер уже записав у календар —
          // ця форма запису його не дублює (POST /calendar/slots дав би другий запис або
          // «Підйомник зайнятий» на власному часі). Механік, обраний у формі, ставиться на
          // запис наряду; форма закривається, календар перечитує записи.
          // Наявний запис без наряду наряд забрав собі (`calendarSlotId`) — те саме.
          if ((!editingSlotId || adoptRange) && wo.plannedAt && wo.dueDate) {
            void adoptWorkOrderSlot(wo, adoptRange !== null);
            return;
          }
          const display = `${wo.number}${form.counterpartyDisplay ? ` · ${form.counterpartyDisplay}` : ''}`;
          setForm(f => ({ ...f, workOrderId: wo.id, workOrderDisplay: display }));
        }}
      />
    </>
  );
}
