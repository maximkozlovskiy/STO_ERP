'use client';

import { useCallback, useEffect, useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useForm } from 'react-hook-form';
import { i18nZodResolver } from '@/lib/i18nZodResolver';
import {
  vehicleFormSchema,
  optionLabel,
  TRANSMISSION_OPTIONS,
  DRIVE_OPTIONS,
  BODY_OPTIONS,
  FUEL_TYPE_OPTIONS,
  type VehicleFormInput,
  type VehicleFormValues,
} from '@sto/shared';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, Pencil, Plus, Trash2 } from 'lucide-react';
import { useRequireAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { DatePickerInput } from '@/components/ui/date-picker-input';
import { VehicleForm } from '@/components/ui/VehicleForm';
import { Spinner } from '@/components/ui/spinner';
import { Modal, AnimatedBody } from '@/components/ui/modal';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useConfirm } from '@/hooks/useConfirm';
import { ExpiryBadge } from '@/components/ui/expiry-badge';
import { fmtInt, fmtDate } from '@/lib/format';

interface Vehicle {
  id: string;
  customerGarageId: string;
  make: string;
  model: string;
  vin: string | null;
  licensePlate: string | null;
  year: number | null;
  engineVolume: number | null;
  fuelType: string | null;
  currentMileage: number | null;
  color: string | null;
  notes: string | null;
  transmissionType: string | null;
  driveType: string | null;
  bodyType: string | null;
  engineCode: string | null;
  insuranceExpiry: string | null;
  inspectionExpiry: string | null;
}
interface VehicleNode {
  id: string;
  category: string;
  name: string;
  mileageAtInstall: number | null;
  notes: string | null;
}
interface MaintenanceSchedule {
  id: string;
  maintenanceType: string;
  intervalDays: number | null;
  intervalMileage: number | null;
  lastMaintenanceDate: string | null;
  lastMaintenanceMileage: number | null;
  nextMaintenanceDate: string | null;
  nextMaintenanceMileage: number | null;
  isActive: boolean;
  notes: string | null;
}

// Порожня форма регламенту ТО — one source of truth для init + reset (create success / cancel).
const EMPTY_SCHEDULE_FORM = {
  maintenanceType: 'ТО',
  intervalDays: '',
  intervalMileage: '',
  lastMaintenanceDate: '',
  lastMaintenanceMileage: '',
  notes: '',
};
// Vehicle fuel/transmission/drive/body опції — тепер зі спільної @sto/shared (VehicleForm).
// Ключі категорій вузлів у фіксованому порядку — мітки беруться з i18n (vehicles:nodeCategory.*).
const NODE_CATEGORY_KEYS = ['engine', 'gearbox', 'suspension', 'electrical', 'AC', 'body'];

export default function VehicleCardPage() {
  useRequireAuth(['OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC']);
  const { t } = useTranslation('vehicles');
  const { confirm, dialogProps } = useConfirm();
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [vehicle, setVehicle] = useState<Vehicle | null>(null);
  const [nodes, setNodes] = useState<VehicleNode[]>([]);
  const [schedules, setSchedules] = useState<MaintenanceSchedule[]>([]);
  const [showAddNode, setShowAddNode] = useState(false);
  const [nodeForm, setNodeForm] = useState({
    category: 'engine',
    name: '',
    mileageAtInstall: '',
    notes: '',
  });
  const [showAddSchedule, setShowAddSchedule] = useState(false);
  const [editingScheduleId, setEditingScheduleId] = useState<string | null>(null);
  const [scheduleForm, setScheduleForm] = useState({ ...EMPTY_SCHEDULE_FORM });
  const [savingSchedule, setSavingSchedule] = useState(false);
  const [deletingScheduleId, setDeletingScheduleId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState('');
  // SSR-safe: today stays null on server + initial client paint (ExpiryBadge hidden
  // via nowMs=0 → daysUntil returns null), then set after mount. Avoids hydration
  // mismatch from a build-time `new Date()` baked into the static export shell.
  const [today, setToday] = useState<Date | null>(null);

  useEffect(() => {
    setToday(new Date());
  }, []);

  const [showEdit, setShowEdit] = useState(false);
  const {
    register: editRegister,
    handleSubmit: editHandleSubmit,
    reset: editReset,
    control: editControl,
    formState: { errors: editErrors },
  } = useForm<VehicleFormInput, unknown, VehicleFormValues>({
    resolver: i18nZodResolver(vehicleFormSchema),
    mode: 'onBlur',
  });
  const [editError, setEditError] = useState('');
  const [editSaving, setEditSaving] = useState(false);

  // Race guard: перемикання авто A→B (або паралельний load після мутації) не має
  // дати повільнішій відповіді A перезаписати картку B. Фіксуємо requestId і
  // застосовуємо setState лише поки він актуальний.
  const loadReqRef = useRef(0);
  const load = () => {
    const reqId = ++loadReqRef.current;
    const ok = () => reqId === loadReqRef.current;
    Promise.all([
      apiFetch<Vehicle>(`/vehicles/${id}`).then(v => {
        if (ok()) setVehicle(v);
      }),
      apiFetch<VehicleNode[]>(`/vehicles/${id}/nodes`).then(n => {
        if (ok()) setNodes(n);
      }),
      apiFetch<MaintenanceSchedule[]>(`/maintenance-schedules?vehicleId=${id}`)
        .then(s => {
          if (ok()) setSchedules(s);
        })
        .catch((e: unknown) =>
          console.warn(
            '[Vehicle] maintenance-schedules load failed:',
            e instanceof Error ? e.message : e,
          ),
        ),
    ]).catch((e: unknown) => {
      if (ok()) setLoadError(e instanceof Error ? e.message : t('card.loadError'));
    });
  };
  useEffect(() => {
    load();
    // `load` recreated each render but only depends on stable `id` for its
    // network calls. Including `load` would cause infinite re-fetch loop;
    // omitting it satisfies the actual data-dependency (the vehicle id).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const openEdit = () => {
    if (!vehicle) return;
    editReset({
      customerGarageId: vehicle.customerGarageId,
      make: vehicle.make,
      model: vehicle.model,
      vin: vehicle.vin ?? '',
      licensePlate: vehicle.licensePlate ?? '',
      year: vehicle.year ? String(vehicle.year) : '',
      engineVolume: vehicle.engineVolume ? String(vehicle.engineVolume) : '',
      fuelType: vehicle.fuelType ?? '',
      currentMileage: vehicle.currentMileage != null ? String(vehicle.currentMileage) : '',
      color: vehicle.color ?? '',
      transmissionType: vehicle.transmissionType ?? '',
      driveType: vehicle.driveType ?? '',
      bodyType: vehicle.bodyType ?? '',
      engineCode: vehicle.engineCode ?? '',
      insuranceExpiry: vehicle.insuranceExpiry ? vehicle.insuranceExpiry.slice(0, 10) : '',
      inspectionExpiry: vehicle.inspectionExpiry ? vehicle.inspectionExpiry.slice(0, 10) : '',
      notes: vehicle.notes ?? '',
    });
    setEditError('');
    setShowEdit(true);
  };

  // PATCH /vehicles/:id — customerGarageId у update-схемі відсутній (перенос гаража неможливий);
  // notes завжди present (null для очищення), решта — parsed values зі схеми.
  // `void` перед `saveEdit()`, `addNode()`, `removeNode()`, `addSchedule()`,
  // `removeSchedule()` у JSX: кожен має власний try/catch, що пише текст відмови
  // користувачу — `saveEdit` у `editError` (баннер у модалці), решта у `loadError`
  // (баннер над карткою авто) — плюс `finally`, який знімає saving/deleting-стан.
  // `confirm()` у remove-обробниках ніколи не реджектиться. Відмова вже на екрані,
  // тож чекати проміс обробника нікому не потрібно.
  const saveEdit = editHandleSubmit(async (values: VehicleFormValues) => {
    setEditSaving(true);
    setEditError('');
    try {
      const { customerGarageId: _drop, notes, ...rest } = values;
      const updated = await apiFetch<Vehicle>(`/vehicles/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ ...rest, notes: notes ?? null }),
      });
      setVehicle(updated);
      setShowEdit(false);
    } catch (e: unknown) {
      setEditError(e instanceof Error ? e.message : t('card.saveError'));
    } finally {
      setEditSaving(false);
    }
  });

  // Стабільний onClose — інакше Modal.useEffect([open, handleKey]) переприв'язує
  // keydown-listener і переписує body.style.overflow на КОЖЕН символ у формі (2.16).
  const closeEdit = useCallback(() => setShowEdit(false), []);

  const addNode = async () => {
    setSaving(true);
    try {
      await apiFetch<VehicleNode>(`/vehicles/${id}/nodes`, {
        method: 'POST',
        body: JSON.stringify({
          category: nodeForm.category,
          name: nodeForm.name,
          mileageAtInstall: nodeForm.mileageAtInstall
            ? Number(nodeForm.mileageAtInstall)
            : undefined,
          notes: nodeForm.notes || undefined,
        }),
      });
      setNodeForm({ category: 'engine', name: '', mileageAtInstall: '', notes: '' });
      setShowAddNode(false);
      load();
    } catch (e: unknown) {
      setLoadError(e instanceof Error ? e.message : t('card.saveError'));
    } finally {
      setSaving(false);
    }
  };

  const removeNode = async (nodeId: string) => {
    if (!(await confirm({ title: t('card.nodes.deleteConfirmTitle'), variant: 'destructive' })))
      return;
    setSaving(true);
    try {
      await apiFetch<void>(`/vehicles/${id}/nodes/${nodeId}`, { method: 'DELETE' });
      load();
    } catch (e: unknown) {
      setLoadError(e instanceof Error ? e.message : t('card.deleteError'));
    } finally {
      setSaving(false);
    }
  };

  const addSchedule = async () => {
    if (!scheduleForm.maintenanceType.trim()) return;
    setSavingSchedule(true);
    try {
      // На create порожнє поле = undefined (не шлемо → бек ставить дефолт/null).
      // На edit (PATCH) порожнє поле = null: undefined у JSON.stringify зникає, тож без null
      // очищення раніше заповненого поля не долетіло б до бекенду (значення лишалось би старим).
      const empty = editingScheduleId ? null : undefined;
      const body = {
        maintenanceType: scheduleForm.maintenanceType,
        intervalDays: scheduleForm.intervalDays ? Number(scheduleForm.intervalDays) : empty,
        intervalMileage: scheduleForm.intervalMileage
          ? Number(scheduleForm.intervalMileage)
          : empty,
        lastMaintenanceDate: scheduleForm.lastMaintenanceDate || empty,
        lastMaintenanceMileage: scheduleForm.lastMaintenanceMileage
          ? Number(scheduleForm.lastMaintenanceMileage)
          : empty,
        notes: scheduleForm.notes || empty,
      };
      if (editingScheduleId) {
        await apiFetch<MaintenanceSchedule>(`/maintenance-schedules/${editingScheduleId}`, {
          method: 'PATCH',
          body: JSON.stringify(body),
        });
      } else {
        await apiFetch<MaintenanceSchedule>('/maintenance-schedules', {
          method: 'POST',
          body: JSON.stringify({ ...body, vehicleId: id }),
        });
      }
      setScheduleForm({ ...EMPTY_SCHEDULE_FORM });
      setEditingScheduleId(null);
      setShowAddSchedule(false);
      apiFetch<MaintenanceSchedule[]>(`/maintenance-schedules?vehicleId=${id}`)
        .then(setSchedules)
        .catch((e: unknown) =>
          console.warn(
            '[Vehicle] maintenance-schedules refresh failed:',
            e instanceof Error ? e.message : e,
          ),
        );
    } catch (e: unknown) {
      setLoadError(e instanceof Error ? e.message : t('card.schedules.saveError'));
    } finally {
      setSavingSchedule(false);
    }
  };

  const openEditSchedule = (sc: MaintenanceSchedule) => {
    setEditingScheduleId(sc.id);
    setScheduleForm({
      maintenanceType: sc.maintenanceType,
      intervalDays: sc.intervalDays != null ? String(sc.intervalDays) : '',
      intervalMileage: sc.intervalMileage != null ? String(sc.intervalMileage) : '',
      lastMaintenanceDate: sc.lastMaintenanceDate ? sc.lastMaintenanceDate.slice(0, 10) : '',
      lastMaintenanceMileage:
        sc.lastMaintenanceMileage != null ? String(sc.lastMaintenanceMileage) : '',
      notes: sc.notes ?? '',
    });
    setShowAddSchedule(true);
  };

  const cancelScheduleForm = () => {
    setShowAddSchedule(false);
    setEditingScheduleId(null);
    setScheduleForm({ ...EMPTY_SCHEDULE_FORM });
  };

  const removeSchedule = async (scheduleId: string) => {
    if (
      !(await confirm({
        title: t('card.schedules.deleteConfirmTitle'),
        variant: 'destructive',
      }))
    )
      return;
    setDeletingScheduleId(scheduleId);
    try {
      await apiFetch<void>(`/maintenance-schedules/${scheduleId}`, { method: 'DELETE' });
      setSchedules(s => s.filter(sc => sc.id !== scheduleId));
    } catch (e: unknown) {
      setLoadError(e instanceof Error ? e.message : t('card.deleteError'));
    } finally {
      setDeletingScheduleId(null);
    }
  };

  if (!vehicle)
    return (
      <div className="flex items-center justify-center min-h-screen flex-col gap-4">
        {loadError ? (
          <p className="text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-4 py-2">
            {loadError}
          </p>
        ) : (
          <Spinner size="lg" />
        )}
      </div>
    );

  const grouped = nodes.reduce<Record<string, VehicleNode[]>>((acc, n) => {
    (acc[n.category] ??= []).push(n);
    return acc;
  }, {});

  return (
    <div className="page-container max-w-3xl space-y-6">
      {loadError && (
        <div className="text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-4 py-2">
          {loadError}
        </div>
      )}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => router.back()}>
          <ArrowLeft className="h-4 w-4" />
          {t('card.back')}
        </Button>
        <h1 className="text-2xl font-bold text-foreground flex-1">
          {vehicle.make} {vehicle.model}
        </h1>
        <Button variant="outline" size="sm" onClick={openEdit}>
          <Pencil className="h-4 w-4" />
          {t('card.edit')}
        </Button>
      </div>

      {/* Vehicle info */}
      <div className="bg-surface rounded-xl border border-border p-5 grid grid-cols-2 gap-3 text-sm">
        {vehicle.licensePlate && (
          <Info label={t('card.info.licensePlate')} value={vehicle.licensePlate} />
        )}
        {vehicle.vin && <Info label={t('card.info.vin')} value={vehicle.vin} mono />}
        {vehicle.year && <Info label={t('card.info.year')} value={String(vehicle.year)} />}
        {vehicle.engineVolume && (
          <Info label={t('card.info.engineVolume')} value={String(vehicle.engineVolume)} />
        )}
        {vehicle.fuelType && (
          <Info
            label={t('card.info.fuelType')}
            value={optionLabel(FUEL_TYPE_OPTIONS, vehicle.fuelType)}
          />
        )}
        {vehicle.currentMileage != null && (
          <Info label={t('card.info.currentMileage')} value={fmtInt(vehicle.currentMileage)} />
        )}
        {vehicle.color && <Info label={t('card.info.color')} value={vehicle.color} />}
        {vehicle.transmissionType && (
          <Info
            label={t('card.info.transmissionType')}
            value={optionLabel(TRANSMISSION_OPTIONS, vehicle.transmissionType)}
          />
        )}
        {vehicle.driveType && (
          <Info
            label={t('card.info.driveType')}
            value={optionLabel(DRIVE_OPTIONS, vehicle.driveType)}
          />
        )}
        {vehicle.bodyType && (
          <Info
            label={t('card.info.bodyType')}
            value={optionLabel(BODY_OPTIONS, vehicle.bodyType)}
          />
        )}
        {vehicle.engineCode && (
          <Info label={t('card.info.engineCode')} value={vehicle.engineCode} mono />
        )}
        {vehicle.insuranceExpiry && (
          <div>
            <p className="text-xs text-muted-foreground">{t('card.info.insuranceExpiry')}</p>
            <div className="flex items-center gap-1.5 flex-wrap">
              <p className="text-foreground">{fmtDate(vehicle.insuranceExpiry)}</p>
              <ExpiryBadge
                date={vehicle.insuranceExpiry}
                nowMs={today?.getTime() ?? 0}
                expiredLabel={t('card.info.insuranceExpired')}
              />
            </div>
          </div>
        )}
        {vehicle.inspectionExpiry && (
          <div>
            <p className="text-xs text-muted-foreground">{t('card.info.inspectionExpiry')}</p>
            <div className="flex items-center gap-1.5 flex-wrap">
              <p className="text-foreground">{fmtDate(vehicle.inspectionExpiry)}</p>
              <ExpiryBadge
                date={vehicle.inspectionExpiry}
                nowMs={today?.getTime() ?? 0}
                expiredLabel={t('card.info.inspectionExpired')}
              />
            </div>
          </div>
        )}
        {vehicle.notes && (
          <div className="col-span-2">
            <Info label={t('card.info.notes')} value={vehicle.notes} />
          </div>
        )}
      </div>

      {/* Nodes */}
      <div className="bg-surface rounded-xl border border-border p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold text-foreground">{t('card.nodes.title')}</h2>
          <Button variant="ghost" size="sm" onClick={() => setShowAddNode(v => !v)}>
            <Plus className="h-4 w-4" />
            {t('card.nodes.addButton')}
          </Button>
        </div>

        {showAddNode && (
          <AnimatedBody className="mb-4 p-3 bg-secondary rounded-lg space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-[13px] font-medium text-muted-foreground mb-1">
                  {t('card.nodes.categoryLabel')}
                </label>
                <Select
                  value={nodeForm.category}
                  onChange={e => setNodeForm(f => ({ ...f, category: e.target.value }))}
                  className="h-8 text-[13px] py-0.5 px-2 pr-7"
                >
                  {NODE_CATEGORY_KEYS.map(k => (
                    <option key={k} value={k}>
                      {t(`nodeCategory.${k}`)}
                    </option>
                  ))}
                  <option value="other">{t('card.nodes.categoryOther')}</option>
                </Select>
              </div>
              <div>
                <label className="block text-[13px] font-medium text-muted-foreground mb-1">
                  {t('card.nodes.nameLabel')} <span className="text-destructive">*</span>
                </label>
                <Input
                  value={nodeForm.name}
                  onChange={e => setNodeForm(f => ({ ...f, name: e.target.value }))}
                  placeholder={t('card.nodes.namePlaceholder')}
                  className="h-8 text-[13px]"
                />
              </div>
            </div>
            <Input
              value={nodeForm.mileageAtInstall}
              onChange={e => setNodeForm(f => ({ ...f, mileageAtInstall: e.target.value }))}
              placeholder={t('card.nodes.mileagePlaceholder')}
              type="number"
              className="h-8 text-[13px]"
            />
            <Input
              value={nodeForm.notes}
              onChange={e => setNodeForm(f => ({ ...f, notes: e.target.value }))}
              placeholder={t('card.nodes.notesPlaceholder')}
              className="h-8 text-[13px]"
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={() => void addNode()}
                loading={saving}
                disabled={!nodeForm.name}
              >
                {t('card.nodes.save')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setShowAddNode(false)}>
                {t('card.nodes.cancel')}
              </Button>
            </div>
          </AnimatedBody>
        )}

        {Object.keys(grouped).length === 0 && !showAddNode && (
          <p className="text-sm text-muted-foreground">{t('card.nodes.empty')}</p>
        )}

        {Object.entries(grouped).map(([cat, catNodes]) => (
          <div key={cat} className="mb-3">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">
              {t(`nodeCategory.${cat}`, cat)}
            </p>
            <div className="divide-y divide-border border border-border rounded-lg overflow-hidden">
              {catNodes.map(n => (
                <div key={n.id} className="flex items-center justify-between px-3 py-2.5">
                  <div>
                    <p className="text-sm text-foreground">{n.name}</p>
                    {n.mileageAtInstall != null && (
                      <p className="text-xs text-muted-foreground">
                        {t('card.nodes.installedAt', { mileage: fmtInt(n.mileageAtInstall) })}
                      </p>
                    )}
                    {n.notes && <p className="text-xs text-muted-foreground">{n.notes}</p>}
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void removeNode(n.id)}
                    className="text-destructive/70 hover:text-destructive hover:bg-destructive/10"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Maintenance Schedules */}
      <div className="bg-surface rounded-xl border border-border p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold text-foreground">{t('card.schedules.title')}</h2>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => (showAddSchedule ? cancelScheduleForm() : setShowAddSchedule(true))}
          >
            <Plus className="h-4 w-4" />
            {t('card.schedules.addButton')}
          </Button>
        </div>

        {showAddSchedule && (
          <AnimatedBody className="mb-4 p-3 bg-secondary rounded-lg space-y-2">
            <p className="text-[13px] font-medium text-foreground">
              {editingScheduleId
                ? t('card.schedules.formTitleEdit')
                : t('card.schedules.formTitleCreate')}
            </p>
            <div className="grid grid-cols-2 gap-2">
              <Input
                label={t('card.schedules.typeLabel')}
                value={scheduleForm.maintenanceType}
                onChange={e => setScheduleForm(f => ({ ...f, maintenanceType: e.target.value }))}
                placeholder={t('card.schedules.typePlaceholder')}
                className="h-8 text-[13px]"
              />
              <Input
                label={t('card.schedules.notesLabel')}
                value={scheduleForm.notes}
                onChange={e => setScheduleForm(f => ({ ...f, notes: e.target.value }))}
                placeholder={t('card.schedules.notesPlaceholder')}
                className="h-8 text-[13px]"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Input
                label={t('card.schedules.intervalDaysLabel')}
                type="number"
                min="1"
                value={scheduleForm.intervalDays}
                onChange={e => setScheduleForm(f => ({ ...f, intervalDays: e.target.value }))}
                placeholder={t('card.schedules.intervalDaysPlaceholder')}
                className="h-8 text-[13px]"
              />
              <Input
                label={t('card.schedules.intervalMileageLabel')}
                type="number"
                min="1"
                value={scheduleForm.intervalMileage}
                onChange={e => setScheduleForm(f => ({ ...f, intervalMileage: e.target.value }))}
                placeholder={t('card.schedules.intervalMileagePlaceholder')}
                className="h-8 text-[13px]"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <DatePickerInput
                label={t('card.schedules.lastDateLabel')}
                value={scheduleForm.lastMaintenanceDate}
                onChange={v => setScheduleForm(f => ({ ...f, lastMaintenanceDate: v }))}
              />
              <Input
                label={t('card.schedules.lastMileageLabel')}
                type="number"
                min="0"
                value={scheduleForm.lastMaintenanceMileage}
                onChange={e =>
                  setScheduleForm(f => ({ ...f, lastMaintenanceMileage: e.target.value }))
                }
                placeholder={t('card.schedules.lastMileagePlaceholder')}
                className="h-8 text-[13px]"
              />
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={() => void addSchedule()}
                loading={savingSchedule}
                disabled={!scheduleForm.maintenanceType.trim()}
              >
                {t('card.schedules.save')}
              </Button>
              <Button size="sm" variant="outline" onClick={cancelScheduleForm}>
                {t('card.schedules.cancel')}
              </Button>
            </div>
          </AnimatedBody>
        )}

        {schedules.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('card.schedules.empty')}</p>
        ) : (
          <div className="divide-y divide-border border border-border rounded-lg overflow-hidden">
            {schedules.map(sc => (
              <div key={sc.id} className="flex items-start justify-between px-3 py-2.5">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-foreground">{sc.maintenanceType}</p>
                    {!sc.isActive && (
                      <span className="text-[11px] px-1.5 py-0.5 bg-secondary text-muted-foreground rounded">
                        {t('card.schedules.inactive')}
                      </span>
                    )}
                    {sc.nextMaintenanceDate && (
                      <ExpiryBadge
                        date={sc.nextMaintenanceDate}
                        nowMs={today?.getTime() ?? 0}
                        expiredLabel={t('card.schedules.expired')}
                        soonLabel={t('card.schedules.soon')}
                        soonDays={14}
                      />
                    )}
                  </div>
                  <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-0.5">
                    {sc.intervalDays && (
                      <p className="text-xs text-muted-foreground">
                        {t('card.schedules.everyDays', { days: sc.intervalDays })}
                      </p>
                    )}
                    {sc.intervalMileage && (
                      <p className="text-xs text-muted-foreground">
                        {t('card.schedules.everyMileage', { mileage: fmtInt(sc.intervalMileage) })}
                      </p>
                    )}
                    {sc.nextMaintenanceDate && (
                      <p className="text-xs text-muted-foreground">
                        {t('card.schedules.next', { date: fmtDate(sc.nextMaintenanceDate) })}
                      </p>
                    )}
                    {sc.nextMaintenanceMileage && (
                      <p className="text-xs text-muted-foreground">
                        {t('card.schedules.atMileage', {
                          mileage: fmtInt(sc.nextMaintenanceMileage),
                        })}
                      </p>
                    )}
                    {sc.notes && <p className="text-xs text-muted-foreground">{sc.notes}</p>}
                  </div>
                </div>
                <div className="flex items-center gap-0.5 shrink-0">
                  <Button variant="ghost" size="sm" onClick={() => openEditSchedule(sc)}>
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    loading={deletingScheduleId === sc.id}
                    onClick={() => void removeSchedule(sc.id)}
                    className="text-destructive/70 hover:text-destructive hover:bg-destructive/10"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Edit Modal */}
      <Modal
        open={showEdit}
        onClose={closeEdit}
        title={t('card.editModal.title')}
        size="lg"
        footer={
          <>
            <Button onClick={() => void saveEdit()} loading={editSaving}>
              {t('card.editModal.save')}
            </Button>
            <Button variant="outline" onClick={closeEdit}>
              {t('card.editModal.cancel')}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {editError && (
            <div className="text-sm text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-4 py-2.5">
              {editError}
            </div>
          )}
          <VehicleForm register={editRegister} errors={editErrors} control={editControl} />
        </div>
      </Modal>
      <ConfirmDialog {...dialogProps} />
    </div>
  );
}

function Info({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`text-foreground${mono ? ' font-mono text-xs' : ''}`}>{value}</p>
    </div>
  );
}
