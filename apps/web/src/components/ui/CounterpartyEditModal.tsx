'use client';

import { useState, useRef, useEffect, useCallback, useId } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '@/i18n/config';
import { useForm } from 'react-hook-form';
import { i18nZodResolver } from '@/lib/i18nZodResolver';
import {
  counterpartyFormSchema,
  vehicleFormSchema,
  type CounterpartyFormInput,
  type CounterpartyFormValues,
  type VehicleFormInput,
  type VehicleFormValues,
} from '@sto/shared';
import { VehicleForm } from '@/components/ui/VehicleForm';
import { Plus, Trash2, Pencil, RotateCcw } from 'lucide-react';
import { apiFetch } from '@/lib/api-client';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { fmtMoney, fmtDate, kyivToday } from '@/lib/format';
import { Modal, AnimatedBody } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { useConfirm } from '@/hooks/useConfirm';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useDirtyForm } from '@/hooks/useDirtyForm';
import { DirtyConfirmDialog } from '@/components/ui/dirty-confirm-dialog';
import { WO_STATUS_BADGE } from '@sto/shared';
import { woStatusLabel, contractTypeLabel } from '@/i18n/enumLabel';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import { StatusManager } from '@/components/ui/CounterpartyStatusManager';

// ─── Types ────────────────────────────────────────────────────────────────────

import type { CpType } from '@/hooks/api/useCounterparties';
import {
  CounterpartyForm,
  emptyCounterpartyForm,
  counterpartyToForm,
} from '@/components/ui/CounterpartyForm';

export type { CpType };

export interface CounterpartyForModal {
  id: string;
  type: CpType;
  firstName?: string | null;
  lastName?: string | null;
  companyName?: string | null;
  phone?: string | null;
  email?: string | null;
  edrpou?: string | null;
  vatPayer: boolean;
  notes?: string | null;
  contactPerson?: string | null;
}

type Vehicle = {
  id: string;
  makeId: string;
  modelId: string;
  make: string;
  model: string;
  year: number | null;
  licensePlate: string;
  vin?: string | null;
  deletedAt?: string | null;
};

type ModalWorkOrder = {
  id: string;
  number: string;
  status: string;
  totalAmount: number;
  createdAt: string;
  vehicleSummary?: string | null;
};

type ModalContract = {
  id: string;
  number: string;
  contractType: 'PURCHASE' | 'SALE';
  startDate: string;
  endDate: string | null;
  isPrimary: boolean;
  creditLimit: number | null;
  currencyCode: string;
  paymentDeferDays: number | null;
  deletedAt?: string | null;
};

// Доступні види договору за типом контрагента: SUPPLIER → лише Купівля,
// CLIENT → лише Продаж, BOTH → обидва. Поле «Вид договору» завжди редаговане
// (select), лише список пунктів фільтрується — жодного disabled-стану.
function contractTypesForCounterparty(cpType: string): Array<'PURCHASE' | 'SALE'> {
  if (cpType === 'SUPPLIER') return ['PURCHASE'];
  if (cpType === 'CLIENT') return ['SALE'];
  return ['PURCHASE', 'SALE']; // BOTH (та будь-який інший) — обидва
}

// Дефолтний вид при відкритті форми: єдиний доступний для SUPPLIER/CLIENT,
// порожній для BOTH (обов'язковий явний вибір).
function defaultContractType(cpType: string): string {
  const types = contractTypesForCounterparty(cpType);
  return types.length === 1 ? types[0] : '';
}

// «Назва» контрагента: TYPE-AWARE guard винесено у CounterpartyForm (єдине джерело правди,
// Bug #739) — SUPPLIER вимагає companyName (Ім'я/Прізвище приховані), CLIENT/BOTH — компанія
// АБО ім'я. Дзеркалить cross-field guard на беку (counterparties.service).

// ─── Props ────────────────────────────────────────────────────────────────────

interface CounterpartyEditModalProps {
  open: boolean;
  /** null = create new */
  counterparty: CounterpartyForModal | null;
  onClose: () => void;
  /**
   * Викликається після збереження. `isNew=true` — контрагента щойно СТВОРЕНО:
   * батько має лишити модалку відкритою і передати `cp` назад як `counterparty`
   * (модалка перемкнеться в edit-режим із вкладками Авто/Договори), а не закривати.
   */
  onSaved: (cp: CounterpartyForModal, isNew: boolean) => void;
}

// Дефолти vehicle-форми (усі поля рядки — web-стан; схема коерсить). customerGarageId
// заповнюється при збереженні (garage auto-create), у формі не редагується.
function emptyVehicleForm(): VehicleFormInput {
  return {
    customerGarageId: '',
    makeId: '',
    modelId: '',
    vin: '',
    licensePlate: '',
    year: '',
    engineVolume: '',
    fuelType: '',
    currentMileage: '',
    color: '',
    transmissionType: '',
    driveType: '',
    bodyType: '',
    engineCode: '',
    insuranceExpiry: '',
    inspectionExpiry: '',
    notes: '',
  };
}

// ─── Component ────────────────────────────────────────────────────────────────

export function CounterpartyEditModal({
  open,
  counterparty,
  onClose,
  onSaved,
}: CounterpartyEditModalProps) {
  const { t } = useTranslation('counterparties');
  const router = useRouter();
  const { confirm, dialogProps: confirmDialogProps } = useConfirm();
  const dirty = useDirtyForm();
  const { employee } = useAuth();
  // Призначати/знімати статуси — OWNER/ADMIN/RECEPTIONIST (паритет з assign-endpoint @Roles).
  const canManageStatuses = ['OWNER', 'ADMIN', 'RECEPTIONIST'].includes(employee?.role ?? '');

  const isEdit = !!counterparty;
  const statusesLabelId = useId();

  // ── Form ─────────────────────────────────────────────────────────────────────
  const [editTab, setEditTab] = useState<'main' | 'vehicles' | 'contracts' | 'work-orders'>('main');
  const [saving, setSaving] = useState(false);
  // WEB-H3 (Bug #632, клас Bug #630): синхронний guard проти concurrent double-submit.
  // `<Button loading={saving}>` вимикається лише ПІСЛЯ re-render React між кліками;
  // два кліки в одному tick інакше обидва входять до create()/update() → 2 POST
  // /counterparties (дублікат контрагента). Ref фліпається синхронно ДО state-flush.
  const savingRef = useRef(false);
  const setSavingBoth = (v: boolean) => {
    savingRef.current = v;
    setSaving(v);
  };
  const [error, setError] = useState('');
  // Спільна форма контрагента (react-hook-form + zod-схема) — єдине джерело валідації web↔api.
  const {
    register,
    handleSubmit,
    reset,
    control,
    watch,
    formState: { errors, isDirty: rhfDirty },
  } = useForm<CounterpartyFormInput, unknown, CounterpartyFormValues>({
    resolver: i18nZodResolver(counterpartyFormSchema),
    defaultValues: emptyCounterpartyForm('CLIENT'),
    mode: 'onBlur',
  });

  // Sync form when counterparty changes (open edit)
  useEffect(() => {
    if (open) {
      setEditTab('main');
      setError('');
      dirty.resetDirty();
      reset(counterparty ? counterpartyToForm(counterparty) : emptyCounterpartyForm('CLIENT'));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, counterparty?.id]);

  // Міст RHF isDirty → useDirtyForm (DirtyConfirmDialog + beforeunload збережено).
  useEffect(() => {
    if (rhfDirty) dirty.markDirty();
    else dirty.resetDirty();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rhfDirty]);

  // ── Vehicles ─────────────────────────────────────────────────────────────────
  const [modalVehicles, setModalVehicles] = useState<Vehicle[]>([]);
  const [modalVehiclesLoading, setModalVehiclesLoading] = useState(false);
  const [modalGarageId, setModalGarageId] = useState<string | null>(null);
  const [vehiclesError, setVehiclesError] = useState('');
  const [showAddVehicle, setShowAddVehicle] = useState(false);
  const [addingVehicle, setAddingVehicle] = useState(false);
  const [deletingVehicleId, setDeletingVehicleId] = useState<string | null>(null);
  // Редагування наявного авто: id → форма prefill; null → режим створення.
  const [editingVehicleId, setEditingVehicleId] = useState<string | null>(null);
  // Галки «Показувати видалені» (soft-deleted авто/договори) у формі контрагента.
  const [showDeletedVehicles, setShowDeletedVehicles] = useState(false);
  // Окрема RHF-форма для вкладки авто (compact VehicleForm) — незалежна від counterparty-форми.
  const vehicleForm = useForm<VehicleFormInput, unknown, VehicleFormValues>({
    resolver: i18nZodResolver(vehicleFormSchema),
    defaultValues: emptyVehicleForm(),
    mode: 'onBlur',
  });
  const modalVehiclesReqRef = useRef(0);
  // Live counterparty id — звіряється у handler-fetch async після await, щоб не
  // setState у списки чужого CP при швидкому перемиканні (§8.2 tenant-guard).
  const currentCpIdRef = useRef<string | null>(null);
  // explicit deps `[counterparty?.id]` — ref оновлюється ТІЛЬКИ при
  // зміні CP-id, а не на кожен render (form-keystrokes). ESLint-clean.
  useEffect(() => {
    currentCpIdRef.current = counterparty?.id ?? null;
  }, [counterparty?.id]);

  // ── Work Orders ──────────────────────────────────────────────────────────────
  const [modalWorkOrders, setModalWorkOrders] = useState<ModalWorkOrder[]>([]);
  const [modalWorkOrdersLoading, setModalWorkOrdersLoading] = useState(false);
  const [woError, setWoError] = useState('');
  const modalWoReqRef = useRef(0);

  // ── Contracts ────────────────────────────────────────────────────────────────
  const [modalContracts, setModalContracts] = useState<ModalContract[]>([]);
  const [modalContractsLoading, setModalContractsLoading] = useState(false);
  const [contractsError, setContractsError] = useState('');
  const [showAddContract, setShowAddContract] = useState(false);
  const [addingContract, setAddingContract] = useState(false);
  // Редагування наявного договору: id → форма prefill; null → режим створення.
  const [editingContractId, setEditingContractId] = useState<string | null>(null);
  const [deletingContractId, setDeletingContractId] = useState<string | null>(null);
  const [showDeletedContracts, setShowDeletedContracts] = useState(false);
  const [orgCurrency, setOrgCurrency] = useState('UAH');
  const [currencies, setCurrencies] = useState<{ code: string; name: string }[]>([]);
  const [addContractForm, setAddContractForm] = useState({
    contractType: '',
    startDate: kyivToday(),
    endDate: '',
    creditLimit: '',
    currencyCode: '',
    paymentDeferDays: '',
    isPrimary: false,
  });
  const modalContractsReqRef = useRef(0);

  // Skip-first-run refs для toggle-useEffect (див. коментарі нижче). Оголошені тут
  // (не поруч зі своїми useEffect), бо головний useEffect їх скидає при зміні CP —
  // ES const має TDZ у порядку виконання, тому декларація має передувати використанню.
  const vehiclesLoadedRef = useRef(false);
  const contractsLoadedRef = useRef(false);

  // Load related data when modal opens for an existing counterparty
  useEffect(() => {
    if (!open || !counterparty) return;

    const vReqId = ++modalVehiclesReqRef.current;
    const woReqId = ++modalWoReqRef.current;
    const cReqId = ++modalContractsReqRef.current;

    setModalVehicles([]);
    setModalWorkOrders([]);
    setModalContracts([]);
    setModalGarageId(null); // reset stale id before fetch — інакше addVehicle для нового CP
    //                       міг би запостити vehicle у гараж попереднього контрагента.
    setVehiclesError('');
    setWoError('');
    setContractsError('');
    setShowAddVehicle(false);
    setShowAddContract(false);
    // Галки видалених скидаються при відкритті модалки для (іншого) контрагента.
    setShowDeletedVehicles(false);
    setShowDeletedContracts(false);

    setModalVehiclesLoading(true);
    // sto-optimize: parallel garages (для defaultGarageId) + bulk vehicles
    // через ?counterpartyId=. Раніше waterfall: garages → N per-garage fetches.
    Promise.all([
      apiFetch<{ id: string }[]>(`/counterparties/${counterparty.id}/garages`),
      apiFetch<Vehicle[]>(`/vehicles?counterpartyId=${counterparty.id}`),
    ])
      .then(([garages, vehicles]) => {
        if (modalVehiclesReqRef.current !== vReqId) return;
        const defaultGarage = garages[0];
        if (defaultGarage) setModalGarageId(defaultGarage.id);
        setModalVehicles(vehicles);
      })
      .catch(err => {
        if (modalVehiclesReqRef.current === vReqId)
          setVehiclesError(
            err instanceof Error
              ? err.message
              : i18n.t('counterparties:editModal.loadVehiclesFailed'),
          );
      })
      .finally(() => {
        if (modalVehiclesReqRef.current === vReqId) setModalVehiclesLoading(false);
      });

    setModalWorkOrdersLoading(true);
    apiFetch<{ items: ModalWorkOrder[] }>(`/work-orders?counterpartyId=${counterparty.id}&limit=50`)
      .then(data => {
        if (modalWoReqRef.current === woReqId) setModalWorkOrders(data.items);
      })
      .catch(err => {
        if (modalWoReqRef.current === woReqId)
          setWoError(
            err instanceof Error
              ? err.message
              : i18n.t('counterparties:editModal.loadWorkOrdersFailed'),
          );
      })
      .finally(() => {
        if (modalWoReqRef.current === woReqId) setModalWorkOrdersLoading(false);
      });

    setModalContractsLoading(true);
    apiFetch<ModalContract[]>(`/counterparties/${counterparty.id}/contracts`)
      .then(items => {
        if (modalContractsReqRef.current === cReqId) setModalContracts(items ?? []);
      })
      .catch(err => {
        if (modalContractsReqRef.current === cReqId)
          setContractsError(
            err instanceof Error
              ? err.message
              : i18n.t('counterparties:editModal.loadContractsFailed'),
          );
      })
      .finally(() => {
        if (modalContractsReqRef.current === cReqId) setModalContractsLoading(false);
      });
    // Reset skip-first-run refs — головний useEffect уже завантажив дані для нового CP,
    // toggle-useEffect має пропустити свій перший прогін (уникнення дубля-запиту).
    vehiclesLoadedRef.current = false;
    contractsLoadedRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, counterparty?.id]);

  // Перезавантаження авто при перемиканні галки «Показувати видалені» (both directions —
  // toggle-on показує deleted, toggle-off ховає їх назад). Skip перший прогін після
  // open/CP-switch (головний useEffect уже завантажив дані з дефолтом false); при зміні
  // CP головний useEffect скидає `vehiclesLoadedRef.current = false` — уникнення дубля.
  useEffect(() => {
    if (!open || !counterparty) {
      vehiclesLoadedRef.current = false;
      return;
    }
    // Skip перший прогін після open (дефолт false вже завантажений головним useEffect).
    if (!vehiclesLoadedRef.current) {
      vehiclesLoadedRef.current = true;
      return;
    }
    const vReqId = ++modalVehiclesReqRef.current;
    setModalVehiclesLoading(true);
    const qs = showDeletedVehicles ? '&showDeleted=true' : '';
    apiFetch<Vehicle[]>(`/vehicles?counterpartyId=${counterparty.id}${qs}`)
      .then(vehicles => {
        if (modalVehiclesReqRef.current === vReqId) setModalVehicles(vehicles);
      })
      .catch(err => {
        if (modalVehiclesReqRef.current === vReqId)
          setVehiclesError(
            err instanceof Error
              ? err.message
              : i18n.t('counterparties:editModal.loadVehiclesFailed'),
          );
      })
      .finally(() => {
        if (modalVehiclesReqRef.current === vReqId) setModalVehiclesLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showDeletedVehicles, open, counterparty?.id]);

  // Перезавантаження договорів при перемиканні галки (both directions).
  // Skip-first-run ref обнуляється у головному useEffect при зміні CP (див. вище).
  useEffect(() => {
    if (!open || !counterparty) {
      contractsLoadedRef.current = false;
      return;
    }
    if (!contractsLoadedRef.current) {
      contractsLoadedRef.current = true;
      return;
    }
    const cReqId = ++modalContractsReqRef.current;
    setModalContractsLoading(true);
    const qs = showDeletedContracts ? '?showDeleted=true' : '';
    apiFetch<ModalContract[]>(`/counterparties/${counterparty.id}/contracts${qs}`)
      .then(items => {
        if (modalContractsReqRef.current === cReqId) setModalContracts(items ?? []);
      })
      .catch(err => {
        if (modalContractsReqRef.current === cReqId)
          setContractsError(
            err instanceof Error
              ? err.message
              : i18n.t('counterparties:editModal.loadContractsFailed'),
          );
      })
      .finally(() => {
        if (modalContractsReqRef.current === cReqId) setModalContractsLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showDeletedContracts, open, counterparty?.id]);

  useEffect(() => {
    if (!open) return;
    void Promise.allSettled([
      apiFetch<{ currency: string }>('/settings/organisation'),
      apiFetch<{ items: { code: string; name: string }[]; total: number }>('/currencies'),
    ]).then(([settingsRes, currRes]) => {
      if (settingsRes.status === 'fulfilled') setOrgCurrency(settingsRes.value.currency);
      if (currRes.status === 'fulfilled') setCurrencies(currRes.value.items ?? []);
    });
  }, [open]);

  // ── Actions ──────────────────────────────────────────────────────────────────

  const handleClose = useCallback(async () => {
    if (!(await dirty.confirmClose())) return;
    onClose();
  }, [dirty, onClose]);

  // Валідація — zodResolver (per-field inline, включно з name-by-type superRefine на companyName).
  const create = handleSubmit(async (values: CounterpartyFormValues) => {
    if (savingRef.current) return;
    setSavingBoth(true);
    setError('');
    try {
      const created = await apiFetch<CounterpartyForModal>('/counterparties', {
        method: 'POST',
        body: JSON.stringify(values),
      });
      dirty.resetDirty();
      // Батько передасть created як counterparty → модалка перемкнеться в edit-режим
      // (з'являться вкладки Авто/Договори/Історія). Модалка НЕ закривається.
      onSaved(created, true);
      toast.success(t('toast.created'));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('common.error'));
    } finally {
      setSavingBoth(false);
    }
  });

  const update = handleSubmit(async (values: CounterpartyFormValues) => {
    if (savingRef.current) return;
    if (!counterparty) return;
    setSavingBoth(true);
    setError('');
    try {
      const updated = await apiFetch<CounterpartyForModal>(`/counterparties/${counterparty.id}`, {
        method: 'PATCH',
        body: JSON.stringify(values),
      });
      dirty.resetDirty();
      onSaved(updated, false);
      toast.success(t('toast.saved'));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('common.error'));
    } finally {
      setSavingBoth(false);
    }
  });

  // Скидання форми авто у дефолтний стан (вихід з create/edit-режиму).
  const resetVehicleForm = () => {
    vehicleForm.reset(emptyVehicleForm());
    setEditingVehicleId(null);
    setShowAddVehicle(false);
  };

  // Відкрити форму на РЕДАГУВАННЯ наявного авто — prefill з рядка.
  const startEditVehicle = (v: Vehicle) => {
    vehicleForm.reset({
      ...emptyVehicleForm(),
      makeId: v.makeId,
      modelId: v.modelId,
      year: v.year != null ? String(v.year) : '',
      licensePlate: v.licensePlate || '',
      vin: v.vin || '',
    });
    setEditingVehicleId(v.id);
    setShowAddVehicle(true);
  };

  const saveVehicle = vehicleForm.handleSubmit(async (values: VehicleFormValues) => {
    if (!counterparty) return;
    // Tenant-guard: handler-fetch ↔ зміна counterparty (§8.2). Якщо під час запиту
    // користувач перемкнувся на іншого CP — викидаємо setState у чужу таблицю.
    // Звіряємо проти currentCpIdRef (живий id з ref), а не з captured closure.
    const cpIdAtStart = counterparty.id;
    const editId = editingVehicleId;
    setAddingVehicle(true);
    try {
      // customerGarageId зі схеми ігноруємо (гараж резолвиться нижче: наявний або auto-create).
      const { customerGarageId: _drop, ...payload } = values;
      let saved: Vehicle;
      if (editId) {
        // PATCH наявного авто — гараж уже існує, customerGarageId не потрібен.
        saved = await apiFetch<Vehicle>(`/vehicles/${editId}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
      } else {
        // Якщо гаража ще немає — створюємо автоматично (новий контрагент без гаражу).
        // Назва "Основний" + isDefault:true дзеркалить backend (counterparties.service.ts
        // auto-create на create() для CLIENT/BOTH) — консистентний UX.
        let garageId = modalGarageId;
        if (!garageId) {
          const garage = await apiFetch<{ id: string }>(`/counterparties/${cpIdAtStart}/garages`, {
            method: 'POST',
            body: JSON.stringify({ name: 'Основний', isDefault: true }),
          });
          garageId = garage.id;
          if (currentCpIdRef.current === cpIdAtStart) setModalGarageId(garage.id);
        }
        saved = await apiFetch<Vehicle>('/vehicles', {
          method: 'POST',
          body: JSON.stringify({ customerGarageId: garageId, ...payload }),
        });
      }
      if (currentCpIdRef.current !== cpIdAtStart) return; // CP змінився — викидаємо setState
      setModalVehicles(v => {
        const idx = v.findIndex(x => x.id === saved.id);
        if (idx < 0) return [...v, saved];
        const next = [...v];
        next[idx] = saved;
        return next;
      });
      resetVehicleForm();
      toast.success(t(editId ? 'toast.vehicleUpdated' : 'toast.vehicleAdded'));
    } catch (e: unknown) {
      if (currentCpIdRef.current === cpIdAtStart)
        toast.error(e instanceof Error ? e.message : t('common.error'));
    } finally {
      setAddingVehicle(false);
    }
  });

  const deleteVehicle = async (id: string) => {
    if (!(await confirm({ title: t('editModal.confirmDeleteVehicle'), variant: 'destructive' })))
      return;
    const cpIdAtStart = counterparty?.id ?? null;
    setDeletingVehicleId(id);
    try {
      await apiFetch(`/vehicles/${id}`, { method: 'DELETE' });
      if (currentCpIdRef.current !== cpIdAtStart) return;
      // З галкою «показувати видалені» — лишаємо рядок, позначаємо deletedAt (покаже бейдж
      // + кнопку «Відновити»). Без галки — прибираємо зі списку.
      setModalVehicles(v =>
        showDeletedVehicles
          ? v.map(x => (x.id === id ? { ...x, deletedAt: new Date().toISOString() } : x))
          : v.filter(x => x.id !== id),
      );
      // Якщо редагували саме це авто — закриваємо форму.
      if (editingVehicleId === id) resetVehicleForm();
      toast.success(t('toast.vehicleDeleted'));
    } catch (e: unknown) {
      // 404 = вже видалено (stale UI) — просто прибираємо з локального списку.
      const msg = e instanceof Error ? e.message : t('common.error');
      if (currentCpIdRef.current !== cpIdAtStart) return;
      if (/не знайдено|not found/i.test(msg)) {
        setModalVehicles(v => v.filter(x => x.id !== id));
      } else {
        toast.error(msg);
      }
    } finally {
      setDeletingVehicleId(null);
    }
  };

  const restoreVehicle = async (v: Vehicle) => {
    const cpIdAtStart = counterparty?.id ?? null;
    setDeletingVehicleId(v.id);
    try {
      const restored = await apiFetch<Vehicle>(`/vehicles/${v.id}/restore`, { method: 'POST' });
      if (currentCpIdRef.current !== cpIdAtStart) return;
      setModalVehicles(list => list.map(x => (x.id === restored.id ? restored : x)));
      toast.success(t('toast.vehicleRestored'));
    } catch (e: unknown) {
      if (currentCpIdRef.current === cpIdAtStart)
        toast.error(e instanceof Error ? e.message : t('common.error'));
    } finally {
      setDeletingVehicleId(null);
    }
  };

  // Скидання форми договору у дефолтний стан.
  const resetContractForm = () => {
    setAddContractForm({
      contractType: '',
      startDate: '',
      endDate: '',
      creditLimit: '',
      currencyCode: '',
      paymentDeferDays: '',
      isPrimary: false,
    });
    setEditingContractId(null);
    setShowAddContract(false);
  };

  // Відкрити форму на РЕДАГУВАННЯ наявного договору — prefill з рядка.
  const startEditContract = (c: ModalContract) => {
    setAddContractForm({
      contractType: c.contractType,
      startDate: c.startDate ? c.startDate.slice(0, 10) : '',
      endDate: c.endDate ? c.endDate.slice(0, 10) : '',
      creditLimit: c.creditLimit != null ? String(c.creditLimit) : '',
      currencyCode: c.currencyCode || '',
      paymentDeferDays: c.paymentDeferDays != null ? String(c.paymentDeferDays) : '',
      isPrimary: c.isPrimary,
    });
    setEditingContractId(c.id);
    setContractsError('');
    setShowAddContract(true);
  };

  const saveContract = async () => {
    if (!counterparty) return;
    // Tenant-guard (Bug #370): handler-fetch ↔ зміна counterparty. Якщо під час
    // запиту користувач закрив/перевідкрив modal для іншого CP — викидаємо setState
    // у чужу таблицю contracts. Дзеркалить захист у addVehicle/deleteVehicle.
    const cpIdAtStart = counterparty.id;
    const cpTypeAtStart = counterparty.type;
    const editId = editingContractId;
    setAddingContract(true);
    setContractsError('');
    try {
      // Вибір користувача (select уже фільтрований за типом контрагента + має дефолт).
      // Fallback на дефолт-тип якщо поле чомусь порожнє (для BOTH guard на кнопці не пустить).
      const resolvedType = addContractForm.contractType || defaultContractType(cpTypeAtStart);
      const body = JSON.stringify({
        contractType: resolvedType,
        startDate: addContractForm.startDate,
        endDate: addContractForm.endDate || undefined,
        creditLimit: addContractForm.creditLimit ? Number(addContractForm.creditLimit) : undefined,
        currencyCode: addContractForm.currencyCode || orgCurrency,
        paymentDeferDays: addContractForm.paymentDeferDays
          ? Number(addContractForm.paymentDeferDays)
          : undefined,
        isPrimary: addContractForm.isPrimary || undefined,
      });
      const saved = await apiFetch<ModalContract>(
        editId
          ? `/counterparties/${cpIdAtStart}/contracts/${editId}`
          : `/counterparties/${cpIdAtStart}/contracts`,
        { method: editId ? 'PATCH' : 'POST', body },
      );
      if (currentCpIdRef.current !== cpIdAtStart) return; // CP змінився — drop
      setModalContracts(prev => {
        // isPrimary ексклюзивний У МЕЖАХ contractType (дзеркалить бек swapType-scope):
        // якщо saved став головним — скидаємо прапорець з інших того ж типу.
        const next = saved.isPrimary
          ? prev.map(c => (c.contractType === saved.contractType ? { ...c, isPrimary: false } : c))
          : [...prev];
        const idx = next.findIndex(c => c.id === saved.id);
        if (idx >= 0) next[idx] = saved;
        else next.push(saved);
        return next;
      });
      resetContractForm();
      toast.success(t(editId ? 'toast.contractUpdated' : 'toast.contractAdded'));
    } catch (e: unknown) {
      if (currentCpIdRef.current === cpIdAtStart)
        setContractsError(e instanceof Error ? e.message : t('common.error'));
    } finally {
      setAddingContract(false);
    }
  };

  const deleteContract = async (c: ModalContract) => {
    if (!counterparty) return;
    if (
      !(await confirm({
        title: t('editModal.confirmDeleteContractTitle'),
        message: t('editModal.confirmDeleteContractMessage', { number: c.number }),
        variant: 'destructive',
      }))
    )
      return;
    const cpIdAtStart = counterparty.id;
    setDeletingContractId(c.id);
    setContractsError('');
    try {
      await apiFetch(`/counterparties/${cpIdAtStart}/contracts/${c.id}`, { method: 'DELETE' });
      if (currentCpIdRef.current !== cpIdAtStart) return; // CP змінився — drop
      setModalContracts(prev => {
        // З галкою «показувати видалені» — лишаємо рядок, позначаємо deletedAt + isPrimary=false
        // (видалений не може бути головним). Без галки — прибираємо зі списку.
        let next = showDeletedContracts
          ? prev.map(x =>
              x.id === c.id ? { ...x, deletedAt: new Date().toISOString(), isPrimary: false } : x,
            )
          : prev.filter(x => x.id !== c.id);
        // Бек промоутить наступний головний того ж типу (найстаріший) у тому ж $transaction.
        // Дзеркалимо optimistic: якщо видалили головний — робимо головним перший АКТИВНИЙ
        // ТОГО Ж contractType. Бек сортує `[isPrimary desc, createdAt asc]`, але після
        // видалення primary у решти same-type isPrimary=false → тайбрейк за createdAt asc
        // → findIndex дає найстаріший, що збігається з беком. Істина — при перевідкритті.
        if (c.isPrimary) {
          const idx = next.findIndex(x => x.contractType === c.contractType && !x.deletedAt);
          if (idx >= 0) next = next.map((x, i) => (i === idx ? { ...x, isPrimary: true } : x));
        }
        return next;
      });
      // Якщо редагували саме цей договір — закриваємо форму.
      if (editingContractId === c.id) resetContractForm();
      toast.success(t('toast.contractDeleted'));
    } catch (e: unknown) {
      if (currentCpIdRef.current === cpIdAtStart)
        setContractsError(e instanceof Error ? e.message : t('common.error'));
    } finally {
      setDeletingContractId(null);
    }
  };

  const restoreContract = async (c: ModalContract) => {
    if (!counterparty) return;
    const cpIdAtStart = counterparty.id;
    setDeletingContractId(c.id);
    setContractsError('');
    try {
      // Бек restore ставить isPrimary=false (уникнення дубля-головного) — приймаємо as-is.
      const restored = await apiFetch<ModalContract>(
        `/counterparties/${cpIdAtStart}/contracts/${c.id}/restore`,
        { method: 'POST' },
      );
      if (currentCpIdRef.current !== cpIdAtStart) return;
      setModalContracts(prev => prev.map(x => (x.id === restored.id ? restored : x)));
      toast.success(t('toast.contractRestored'));
    } catch (e: unknown) {
      if (currentCpIdRef.current === cpIdAtStart)
        setContractsError(e instanceof Error ? e.message : t('common.error'));
    } finally {
      setDeletingContractId(null);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <>
      {/* (А) Усі обробники нижче вже показують відмову самі: create/update/saveVehicle/
          deleteVehicle/restoreVehicle — через toast.error, saveContract/deleteContract/
          restoreContract — через setContractsError; handleClose лише очікує
          confirmClose() (ніколи не реджектиться). Проміси нікому не потрібні → `void`. */}
      <Modal
        open={open}
        onClose={() => void handleClose()}
        title={isEdit ? t('editModal.titleEdit') : t('editModal.titleCreate')}
        size={isEdit ? 'wide' : 'md'}
        // Картка з вкладками тримає сталий розмір: вкладки різної довжини не «смикають» вікно.
        fixedHeight={isEdit}
        footer={
          editTab === 'main' ? (
            <Button onClick={() => void (isEdit ? update() : create())} loading={saving}>
              {isEdit ? t('editModal.update') : t('common:save')}
            </Button>
          ) : null
        }
      >
        {/* Tabs — only in edit mode. Sticky: the strip stays at the top of the scrolling body, so the
            tabs are always reachable while the form scrolls underneath (owner decision 2026-10-12).
            -mt-5 pulls it over the body's top padding; bg-surface hides the content passing under it. */}
        {isEdit && (
          <div
            data-testid="counterparty-tabs"
            className="sticky top-0 z-10 -mx-6 -mt-5 mb-5 flex gap-0 overflow-x-auto border-b border-border bg-surface px-6 pt-1"
          >
            {(
              [
                { key: 'main', label: t('detail.info') },
                { key: 'vehicles', label: t('detail.vehicles'), count: modalVehicles.length },
                { key: 'contracts', label: t('card.tabs.contracts'), count: modalContracts.length },
                {
                  key: 'work-orders',
                  label: t('editModal.tabHistory'),
                  count: modalWorkOrders.length,
                },
              ] as { key: typeof editTab; label: string; count?: number }[]
            ).map(tab => (
              <button
                key={tab.key}
                type="button"
                onClick={() => setEditTab(tab.key)}
                className={cn(
                  'flex items-center gap-1.5 px-4 py-2.5 text-[13px] font-medium whitespace-nowrap border-b-2 transition-colors shrink-0',
                  editTab === tab.key
                    ? 'text-primary border-primary'
                    : 'text-muted-foreground border-transparent hover:text-foreground',
                )}
              >
                {tab.label}
                {tab.count !== undefined && tab.count > 0 && (
                  <span className="inline-flex items-center justify-center min-w-4.5 h-4.5 px-1 rounded-full text-[11px] font-semibold bg-secondary text-muted-foreground">
                    {tab.count}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}

        {/* ── Tab: Main ─────────────────────────────────────────────────────────── */}
        {(!isEdit || editTab === 'main') && (
          <div key="tab-main" data-animate data-state="open" data-variant="content">
            {error && (
              <div className="mb-4 text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-3 py-2">
                {error}
              </div>
            )}
            {/* Статуси-мітки стоять у рядку з «Типом» (рішення власника 2026-10-12); лише при
                редагуванні наявного контрагента — у нового ще немає id, до якого їх призначати. */}
            <CounterpartyForm
              register={register}
              errors={errors}
              control={control}
              watch={watch}
              typeAside={
                isEdit && counterparty ? (
                  // Same label metrics as <Select label>: the two captions sit on one baseline.
                  // Група, а не <label>: у StatusManager немає одного поля, до якого його прив'язати.
                  <div
                    role="group"
                    aria-labelledby={statusesLabelId}
                    className="flex flex-col gap-1"
                  >
                    <span
                      id={statusesLabelId}
                      className="text-[13px] font-medium leading-none text-foreground"
                    >
                      {t('columns.statuses')}
                    </span>
                    <div className="flex min-h-9 items-center">
                      <StatusManager
                        counterpartyId={counterparty.id}
                        canManage={canManageStatuses}
                      />
                    </div>
                  </div>
                ) : undefined
              }
            />
          </div>
        )}

        {/* ── Tab: Vehicles ────────────────────────────────────────────────────── */}
        {isEdit && editTab === 'vehicles' && (
          <div
            key="tab-vehicles"
            data-animate
            data-state="open"
            data-variant="content"
            className="space-y-3 min-h-64"
          >
            {modalVehiclesLoading && (
              <div className="py-8 text-center text-sm text-muted-foreground">
                {t('common:loadingDots')}
              </div>
            )}
            {!modalVehiclesLoading && vehiclesError && (
              <div className="rounded-lg border border-destructive/30 bg-destructive-subtle px-3 py-2 text-sm text-destructive-text">
                {vehiclesError}
              </div>
            )}
            {!modalVehiclesLoading && !vehiclesError && (
              <>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className="text-[13px] text-muted-foreground">
                      {t('editModal.vehiclesCount', { count: modalVehicles.length })}
                    </span>
                    <label className="flex items-center gap-1.5 text-[12px] text-muted-foreground cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={showDeletedVehicles}
                        onChange={e => setShowDeletedVehicles(e.target.checked)}
                        className="h-3.5 w-3.5 rounded border-border accent-primary"
                      />
                      {t('editModal.showDeleted')}
                    </label>
                  </div>
                  {!showAddVehicle && (
                    <Button
                      size="sm"
                      variant="outline"
                      leftIcon={<Plus className="h-3.5 w-3.5" />}
                      onClick={() => {
                        // Режим СТВОРЕННЯ — скидаємо edit-стан і форму.
                        setEditingVehicleId(null);
                        vehicleForm.reset(emptyVehicleForm());
                        setShowAddVehicle(true);
                      }}
                    >
                      {t('editModal.addVehicle')}
                    </Button>
                  )}
                </div>
                {showAddVehicle && (
                  <AnimatedBody className="rounded-lg border border-border bg-secondary/40 p-3 space-y-3">
                    <VehicleForm
                      register={vehicleForm.register}
                      errors={vehicleForm.formState.errors}
                      control={vehicleForm.control}
                      compact
                      currentNames={modalVehicles.find(v => v.id === editingVehicleId)}
                    />
                    <div className="flex gap-2 justify-end">
                      <Button size="sm" variant="outline" onClick={resetVehicleForm}>
                        {t('common:cancel')}
                      </Button>
                      <Button size="sm" onClick={() => void saveVehicle()} loading={addingVehicle}>
                        {editingVehicleId ? t('editModal.update') : t('common:save')}
                      </Button>
                    </div>
                  </AnimatedBody>
                )}
                {modalVehicles.length > 0 && (
                  <div className="rounded-xl border border-border overflow-hidden">
                    <table className="w-full text-[13px]">
                      <thead className="bg-secondary border-b border-border">
                        <tr>
                          <th className="text-left px-3 py-2 text-muted-foreground font-medium">
                            {t('editModal.colMakeModel')}
                          </th>
                          <th className="text-left px-3 py-2 text-muted-foreground font-medium">
                            {t('editModal.colLicensePlate')}
                          </th>
                          <th className="text-left px-3 py-2 text-muted-foreground font-medium">
                            {t('editModal.colYear')}
                          </th>
                          <th className="w-20">
                            <span className="sr-only">{t('common:actions')}</span>
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {modalVehicles.map(v => (
                          <tr
                            key={v.id}
                            className={cn(
                              'group bg-surface hover:bg-secondary/50 transition-colors',
                              v.deletedAt && 'opacity-60',
                            )}
                          >
                            <td className="px-3 py-2 font-medium text-foreground">
                              <span className="flex items-center gap-1.5">
                                {v.make} {v.model}
                                {v.deletedAt && (
                                  <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-destructive-subtle text-destructive">
                                    {t('editModal.deleted')}
                                  </span>
                                )}
                              </span>
                            </td>
                            <td className="px-3 py-2 text-muted-foreground">
                              {v.licensePlate || '—'}
                            </td>
                            <td className="px-3 py-2 text-muted-foreground">{v.year ?? '—'}</td>
                            <td className="px-3 py-2 text-right">
                              <div className="flex items-center justify-end gap-1">
                                {v.deletedAt ? (
                                  <button
                                    type="button"
                                    title={t('statusesTab.restore')}
                                    onClick={() => void restoreVehicle(v)}
                                    disabled={deletingVehicleId === v.id}
                                    className="p-1.5 rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground transition disabled:opacity-50"
                                  >
                                    <RotateCcw className="h-3.5 w-3.5" />
                                  </button>
                                ) : (
                                  <>
                                    <button
                                      type="button"
                                      title={t('common:edit')}
                                      onClick={() => startEditVehicle(v)}
                                      className="p-1.5 rounded-md text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:bg-secondary hover:text-foreground transition"
                                    >
                                      <Pencil className="h-3.5 w-3.5" />
                                    </button>
                                    <button
                                      type="button"
                                      title={t('common:delete')}
                                      onClick={() => void deleteVehicle(v.id)}
                                      disabled={deletingVehicleId === v.id}
                                      className="p-1.5 rounded-md text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:bg-destructive-subtle hover:text-destructive transition disabled:opacity-50"
                                    >
                                      <Trash2 className="h-3.5 w-3.5" />
                                    </button>
                                  </>
                                )}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {modalVehicles.length === 0 && !showAddVehicle && (
                  <p className="text-[13px] text-muted-foreground text-center py-8">
                    {t('detail.noVehicles')}
                  </p>
                )}
              </>
            )}
          </div>
        )}

        {/* ── Tab: Contracts ───────────────────────────────────────────────────── */}
        {isEdit && editTab === 'contracts' && (
          <div
            key="tab-contracts"
            data-animate
            data-state="open"
            data-variant="content"
            className="space-y-3 min-h-64"
          >
            {contractsError && (
              <div className="rounded-lg border border-destructive/30 bg-destructive-subtle px-3 py-2 text-sm text-destructive-text">
                {contractsError}
              </div>
            )}
            {modalContractsLoading && (
              <div className="py-8 text-center text-sm text-muted-foreground">
                {t('common:loadingDots')}
              </div>
            )}
            {!modalContractsLoading && !contractsError && (
              <>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className="text-[13px] text-muted-foreground">
                      {modalContracts.length === 1
                        ? t('editModal.contractsCountOne', { count: modalContracts.length })
                        : t('editModal.contractsCountMany', { count: modalContracts.length })}
                    </span>
                    <label className="flex items-center gap-1.5 text-[12px] text-muted-foreground cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={showDeletedContracts}
                        onChange={e => setShowDeletedContracts(e.target.checked)}
                        className="h-3.5 w-3.5 rounded border-border accent-primary"
                      />
                      {t('editModal.showDeleted')}
                    </label>
                  </div>
                  {!showAddContract && (
                    <Button
                      size="sm"
                      variant="outline"
                      leftIcon={<Plus className="h-3.5 w-3.5" />}
                      onClick={() => {
                        // Режим СТВОРЕННЯ (не edit): дефолт-вид за типом контрагента
                        // (Купівля для постачальника, Продаж для клієнта, порожньо для BOTH).
                        setEditingContractId(null);
                        setAddContractForm({
                          contractType: defaultContractType(counterparty?.type ?? ''),
                          startDate: kyivToday(),
                          endDate: '',
                          creditLimit: '',
                          currencyCode: '',
                          paymentDeferDays: '',
                          isPrimary: false,
                        });
                        setShowAddContract(true);
                      }}
                    >
                      {t('card.contracts.add')}
                    </Button>
                  )}
                </div>
                {showAddContract && counterparty && (
                  <AnimatedBody className="rounded-lg border border-border bg-secondary/40 p-3 space-y-3">
                    <div className="flex items-end gap-3">
                      <div className="flex-1">
                        <label className="text-xs text-muted-foreground mb-1 block">
                          {t('card.contracts.contractType')}
                          {counterparty.type === 'BOTH' && (
                            <span className="text-destructive"> *</span>
                          )}
                        </label>
                        {/* Поле завжди редаговане (не блокуємо) — лише список пунктів
                            фільтрується за типом контрагента. */}
                        <Select
                          value={addContractForm.contractType}
                          onChange={e =>
                            setAddContractForm(f => ({ ...f, contractType: e.target.value }))
                          }
                        >
                          {counterparty.type === 'BOTH' && (
                            <option value="">{t('card.contracts.chooseType')}</option>
                          )}
                          {contractTypesForCounterparty(counterparty.type).map(t => (
                            <option key={t} value={t}>
                              {contractTypeLabel(t)}
                            </option>
                          ))}
                        </Select>
                      </div>
                      <label className="flex items-center gap-2 cursor-pointer select-none pb-2">
                        <input
                          type="checkbox"
                          checked={addContractForm.isPrimary}
                          onChange={e =>
                            setAddContractForm(f => ({ ...f, isPrimary: e.target.checked }))
                          }
                          className="h-4 w-4 rounded border-border accent-primary"
                        />
                        <span className="text-[13px] text-foreground whitespace-nowrap">
                          {t('card.contracts.primary')}
                        </span>
                      </label>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="text-xs text-muted-foreground mb-1 block">
                          {t('card.contracts.startDate')}{' '}
                          <span className="text-destructive">*</span>
                        </label>
                        <Input
                          type="date"
                          value={addContractForm.startDate}
                          onChange={e =>
                            setAddContractForm(f => ({ ...f, startDate: e.target.value }))
                          }
                        />
                      </div>
                      <div>
                        <label className="text-xs text-muted-foreground mb-1 block">
                          {t('card.contracts.endDate')}
                        </label>
                        <Input
                          type="date"
                          value={addContractForm.endDate}
                          onChange={e =>
                            setAddContractForm(f => ({ ...f, endDate: e.target.value }))
                          }
                        />
                      </div>
                    </div>
                    <div>
                      <label className="text-xs text-muted-foreground mb-1 block">
                        {t('card.contracts.currency')}
                      </label>
                      {currencies.length > 0 ? (
                        <Select
                          value={addContractForm.currencyCode || orgCurrency}
                          onChange={e =>
                            setAddContractForm(f => ({ ...f, currencyCode: e.target.value }))
                          }
                          className="w-auto"
                        >
                          {currencies.map(c => (
                            <option key={c.code} value={c.code}>
                              {c.code} — {c.name}
                            </option>
                          ))}
                        </Select>
                      ) : (
                        <input
                          type="text"
                          value={addContractForm.currencyCode || orgCurrency}
                          onChange={e =>
                            setAddContractForm(f => ({
                              ...f,
                              currencyCode: e.target.value.toUpperCase().slice(0, 10),
                            }))
                          }
                          placeholder="UAH"
                          maxLength={10}
                          className="h-9 w-24 rounded-md border border-border bg-surface px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                        />
                      )}
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="text-xs text-muted-foreground mb-1 block">
                          {t('card.contracts.creditLimit')}
                        </label>
                        <Input
                          type="number"
                          min="0"
                          step="0.01"
                          placeholder="0"
                          value={addContractForm.creditLimit}
                          onChange={e =>
                            setAddContractForm(f => ({ ...f, creditLimit: e.target.value }))
                          }
                        />
                      </div>
                      <div>
                        <label className="text-xs text-muted-foreground mb-1 block">
                          {t('card.contracts.deferDays')}
                        </label>
                        <Input
                          type="number"
                          min="0"
                          step="1"
                          placeholder="0"
                          value={addContractForm.paymentDeferDays}
                          onChange={e =>
                            setAddContractForm(f => ({
                              ...f,
                              paymentDeferDays: String(Math.floor(Number(e.target.value))),
                            }))
                          }
                        />
                      </div>
                    </div>
                    <div className="flex gap-2 justify-end">
                      <Button size="sm" variant="outline" onClick={resetContractForm}>
                        {t('common:cancel')}
                      </Button>
                      <Button
                        size="sm"
                        loading={addingContract}
                        disabled={
                          !addContractForm.startDate ||
                          (counterparty.type === 'BOTH' && !addContractForm.contractType)
                        }
                        onClick={() => void saveContract()}
                      >
                        {editingContractId ? t('editModal.update') : t('common:save')}
                      </Button>
                    </div>
                  </AnimatedBody>
                )}
                {modalContracts.length > 0 && (
                  <div className="rounded-xl border border-border overflow-hidden">
                    <table className="w-full text-[13px]">
                      <thead className="bg-secondary border-b border-border">
                        <tr>
                          <th className="text-left px-3 py-2 text-muted-foreground font-medium">
                            {t('card.contracts.colNumber')}
                          </th>
                          <th className="text-left px-3 py-2 text-muted-foreground font-medium">
                            {t('card.contracts.colType')}
                          </th>
                          <th className="text-left px-3 py-2 text-muted-foreground font-medium">
                            {t('card.contracts.colStart')}
                          </th>
                          <th className="text-left px-3 py-2 text-muted-foreground font-medium">
                            {t('card.contracts.colEnd')}
                          </th>
                          <th className="px-3 py-2 w-20">
                            <span className="sr-only">{t('common:actions')}</span>
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {modalContracts.map(c => (
                          <tr
                            key={c.id}
                            className={cn(
                              'group bg-surface hover:bg-secondary/50 transition-colors',
                              c.deletedAt && 'opacity-60',
                            )}
                          >
                            <td className="px-3 py-2 font-medium text-foreground">
                              <span className="flex items-center gap-1.5">
                                {c.number}
                                {c.isPrimary && !c.deletedAt && (
                                  <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-primary/10 text-primary">
                                    {t('card.contracts.primary')}
                                  </span>
                                )}
                                {c.deletedAt && (
                                  <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-destructive-subtle text-destructive">
                                    {t('editModal.deleted')}
                                  </span>
                                )}
                              </span>
                            </td>
                            <td className="px-3 py-2 text-muted-foreground">
                              {contractTypeLabel(c.contractType)}
                            </td>
                            <td className="px-3 py-2 text-muted-foreground">
                              {fmtDate(c.startDate)}
                            </td>
                            <td className="px-3 py-2 text-muted-foreground">
                              {c.endDate ? fmtDate(c.endDate) : '—'}
                            </td>
                            <td className="px-3 py-2 text-right">
                              <div className="flex items-center justify-end gap-1">
                                {c.deletedAt ? (
                                  <button
                                    type="button"
                                    title={t('statusesTab.restore')}
                                    disabled={deletingContractId === c.id}
                                    onClick={() => void restoreContract(c)}
                                    className="p-1.5 rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground transition disabled:opacity-50"
                                  >
                                    <RotateCcw className="h-3.5 w-3.5" />
                                  </button>
                                ) : (
                                  <>
                                    <button
                                      type="button"
                                      title={t('common:edit')}
                                      onClick={() => startEditContract(c)}
                                      className="p-1.5 rounded-md text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:bg-secondary hover:text-foreground transition"
                                    >
                                      <Pencil className="h-3.5 w-3.5" />
                                    </button>
                                    <button
                                      type="button"
                                      title={t('common:delete')}
                                      disabled={deletingContractId === c.id}
                                      onClick={() => void deleteContract(c)}
                                      className="p-1.5 rounded-md text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:bg-destructive-subtle hover:text-destructive transition disabled:opacity-50"
                                    >
                                      <Trash2 className="h-3.5 w-3.5" />
                                    </button>
                                  </>
                                )}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {modalContracts.length === 0 && !showAddContract && (
                  <p className="text-[13px] text-muted-foreground text-center py-8">
                    {t('editModal.noContracts')}
                  </p>
                )}
              </>
            )}
          </div>
        )}

        {/* ── Tab: Work Orders ─────────────────────────────────────────────────── */}
        {isEdit && editTab === 'work-orders' && (
          <div
            key="tab-work-orders"
            data-animate
            data-state="open"
            data-variant="content"
            className="space-y-3 min-h-64"
          >
            {modalWorkOrdersLoading && (
              <div className="py-8 text-center text-sm text-muted-foreground">
                {t('common:loadingDots')}
              </div>
            )}
            {!modalWorkOrdersLoading && woError && (
              <div className="rounded-lg border border-destructive/30 bg-destructive-subtle px-3 py-2 text-sm text-destructive-text">
                {woError}
              </div>
            )}
            {!modalWorkOrdersLoading && !woError && modalWorkOrders.length === 0 && (
              <p className="text-[13px] text-muted-foreground text-center py-8">
                {t('editModal.noWorkOrders')}
              </p>
            )}
            {!modalWorkOrdersLoading && !woError && modalWorkOrders.length > 0 && (
              <div className="rounded-xl border border-border overflow-hidden">
                <table className="w-full text-[13px]">
                  <thead className="bg-secondary border-b border-border">
                    <tr>
                      <th className="text-left px-3 py-2 text-muted-foreground font-medium">
                        {t('editModal.colWoNumber')}
                      </th>
                      <th className="text-left px-3 py-2 text-muted-foreground font-medium">
                        {t('editModal.colWoVehicle')}
                      </th>
                      <th className="text-left px-3 py-2 text-muted-foreground font-medium">
                        {t('common:status')}
                      </th>
                      <th className="text-right px-3 py-2 text-muted-foreground font-medium">
                        {t('editModal.colWoSum')}
                      </th>
                      <th className="text-left px-3 py-2 text-muted-foreground font-medium">
                        {t('editModal.colWoDate')}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {modalWorkOrders.map(wo => (
                      <tr
                        key={wo.id}
                        className="bg-surface hover:bg-secondary/50 transition-colors cursor-pointer"
                        onClick={() => router.push(`/work-orders/${wo.id}`)}
                      >
                        <td className="px-3 py-2 font-mono font-medium text-foreground">
                          {wo.number}
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">
                          {wo.vehicleSummary || '—'}
                        </td>
                        <td className="px-3 py-2">
                          <Badge variant={WO_STATUS_BADGE[wo.status] ?? 'secondary'} dot>
                            {woStatusLabel(wo.status)}
                          </Badge>
                        </td>
                        <td className="px-3 py-2 text-right text-foreground tabular-nums">
                          {fmtMoney(wo.totalAmount)} ₴
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">{fmtDate(wo.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </Modal>

      <DirtyConfirmDialog {...dirty.dialogProps} />
      <ConfirmDialog {...confirmDialogProps} />
    </>
  );
}
