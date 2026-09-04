'use client';

import { useEffect, useState, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, Pencil, Plus, Trash2 } from 'lucide-react';
import { useRequireAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { DatePickerInput } from '@/components/ui/date-picker-input';
import { Spinner } from '@/components/ui/spinner';
import { Modal, AnimatedBody } from '@/components/ui/modal';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useConfirm } from '@/hooks/useConfirm';
import { ExpiryBadge } from '@/components/ui/expiry-badge';
import { fmtInt, fmtDate } from '@/lib/format';

interface Vehicle {
  id: string;
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

const FUEL_TYPES = ['Бензин', 'Дизель', 'Газ', 'Гібрид', 'Електро', 'LPG'];
const TRANSMISSION_TYPES = [
  { value: '', label: 'Не вказано' },
  { value: 'manual', label: 'Механічна' },
  { value: 'automatic', label: 'Автоматична' },
  { value: 'variator', label: 'Варіатор' },
  { value: 'robot', label: 'Робот' },
];
const DRIVE_TYPES = [
  { value: '', label: 'Не вказано' },
  { value: 'fwd', label: 'Передній (FWD)' },
  { value: 'rwd', label: 'Задній (RWD)' },
  { value: 'awd', label: 'Повний (AWD)' },
  { value: '4wd', label: '4WD' },
];
const BODY_TYPES = [
  { value: '', label: 'Не вказано' },
  { value: 'sedan', label: 'Седан' },
  { value: 'hatchback', label: 'Хетчбек' },
  { value: 'suv', label: 'Позашляховик' },
  { value: 'crossover', label: 'Кросовер' },
  { value: 'van', label: 'Мінівен' },
  { value: 'truck', label: 'Вантажівка' },
  { value: 'coupe', label: 'Купе' },
  { value: 'wagon', label: 'Універсал' },
  { value: 'convertible', label: 'Кабріолет' },
];
const NODE_CATEGORY_LABELS: Record<string, string> = {
  engine: 'Двигун',
  gearbox: 'КПП',
  suspension: 'Підвіска',
  electrical: 'Електрика',
  AC: 'Кондиціонер',
  body: 'Кузов',
};

export default function VehicleCardPage() {
  useRequireAuth(['OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC']);
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
  const [scheduleForm, setScheduleForm] = useState({
    maintenanceType: 'ТО',
    intervalDays: '',
    intervalMileage: '',
    lastMaintenanceDate: '',
    lastMaintenanceMileage: '',
    notes: '',
  });
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
  const [editForm, setEditForm] = useState({
    make: '',
    model: '',
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
      if (ok()) setLoadError(e instanceof Error ? e.message : 'Помилка завантаження');
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
    setEditForm({
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

  const saveEdit = async () => {
    if (!editForm.make.trim() || !editForm.model.trim()) {
      setEditError("Марка та модель є обов'язковими полями");
      return;
    }
    setEditSaving(true);
    setEditError('');
    try {
      const body: Record<string, unknown> = {
        make: editForm.make.trim(),
        model: editForm.model.trim(),
      };
      if (editForm.vin.trim()) body.vin = editForm.vin.trim();
      if (editForm.licensePlate.trim()) body.licensePlate = editForm.licensePlate.trim();
      if (editForm.year) body.year = parseInt(editForm.year, 10);
      if (editForm.engineVolume) body.engineVolume = parseFloat(editForm.engineVolume);
      if (editForm.fuelType) body.fuelType = editForm.fuelType;
      if (editForm.currentMileage) body.currentMileage = parseInt(editForm.currentMileage, 10);
      if (editForm.color.trim()) body.color = editForm.color.trim();
      if (editForm.transmissionType) body.transmissionType = editForm.transmissionType;
      if (editForm.driveType) body.driveType = editForm.driveType;
      if (editForm.bodyType) body.bodyType = editForm.bodyType;
      if (editForm.engineCode.trim()) body.engineCode = editForm.engineCode.trim();
      if (editForm.insuranceExpiry) body.insuranceExpiry = editForm.insuranceExpiry;
      if (editForm.inspectionExpiry) body.inspectionExpiry = editForm.inspectionExpiry;
      body.notes = editForm.notes.trim() || null;

      const updated = await apiFetch<Vehicle>(`/vehicles/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      setVehicle(updated);
      setShowEdit(false);
    } catch (e: unknown) {
      setEditError(e instanceof Error ? e.message : 'Помилка збереження');
    } finally {
      setEditSaving(false);
    }
  };

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
      setLoadError(e instanceof Error ? e.message : 'Помилка збереження');
    } finally {
      setSaving(false);
    }
  };

  const removeNode = async (nodeId: string) => {
    if (!(await confirm({ title: 'Видалити вузол?', variant: 'destructive' }))) return;
    setSaving(true);
    try {
      await apiFetch<void>(`/vehicles/${id}/nodes/${nodeId}`, { method: 'DELETE' });
      load();
    } catch (e: unknown) {
      setLoadError(e instanceof Error ? e.message : 'Помилка видалення');
    } finally {
      setSaving(false);
    }
  };

  const addSchedule = async () => {
    if (!scheduleForm.maintenanceType.trim()) return;
    setSavingSchedule(true);
    try {
      await apiFetch<MaintenanceSchedule>('/maintenance-schedules', {
        method: 'POST',
        body: JSON.stringify({
          vehicleId: id,
          maintenanceType: scheduleForm.maintenanceType,
          intervalDays: scheduleForm.intervalDays ? Number(scheduleForm.intervalDays) : undefined,
          intervalMileage: scheduleForm.intervalMileage
            ? Number(scheduleForm.intervalMileage)
            : undefined,
          lastMaintenanceDate: scheduleForm.lastMaintenanceDate || undefined,
          lastMaintenanceMileage: scheduleForm.lastMaintenanceMileage
            ? Number(scheduleForm.lastMaintenanceMileage)
            : undefined,
          notes: scheduleForm.notes || undefined,
        }),
      });
      setScheduleForm({
        maintenanceType: 'ТО',
        intervalDays: '',
        intervalMileage: '',
        lastMaintenanceDate: '',
        lastMaintenanceMileage: '',
        notes: '',
      });
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
      setLoadError(e instanceof Error ? e.message : 'Помилка збереження регламенту');
    } finally {
      setSavingSchedule(false);
    }
  };

  const removeSchedule = async (scheduleId: string) => {
    if (!(await confirm({ title: 'Видалити регламент ТО?', variant: 'destructive' }))) return;
    setDeletingScheduleId(scheduleId);
    try {
      await apiFetch<void>(`/maintenance-schedules/${scheduleId}`, { method: 'DELETE' });
      setSchedules(s => s.filter(sc => sc.id !== scheduleId));
    } catch (e: unknown) {
      setLoadError(e instanceof Error ? e.message : 'Помилка видалення');
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
          Назад
        </Button>
        <h1 className="text-2xl font-bold text-foreground flex-1">
          {vehicle.make} {vehicle.model}
        </h1>
        <Button variant="outline" size="sm" onClick={openEdit}>
          <Pencil className="h-4 w-4" />
          Редагувати
        </Button>
      </div>

      {/* Vehicle info */}
      <div className="bg-surface rounded-xl border border-border p-5 grid grid-cols-2 gap-3 text-sm">
        {vehicle.licensePlate && <Info label="Держ. номер" value={vehicle.licensePlate} />}
        {vehicle.vin && <Info label="VIN" value={vehicle.vin} mono />}
        {vehicle.year && <Info label="Рік" value={String(vehicle.year)} />}
        {vehicle.engineVolume && <Info label="Об'єм, л" value={String(vehicle.engineVolume)} />}
        {vehicle.fuelType && <Info label="Паливо" value={vehicle.fuelType} />}
        {vehicle.currentMileage != null && (
          <Info label="Пробіг, км" value={fmtInt(vehicle.currentMileage)} />
        )}
        {vehicle.color && <Info label="Колір" value={vehicle.color} />}
        {vehicle.transmissionType && (
          <Info
            label="Коробка"
            value={
              TRANSMISSION_TYPES.find(t => t.value === vehicle.transmissionType)?.label ??
              vehicle.transmissionType
            }
          />
        )}
        {vehicle.driveType && (
          <Info
            label="Привід"
            value={DRIVE_TYPES.find(t => t.value === vehicle.driveType)?.label ?? vehicle.driveType}
          />
        )}
        {vehicle.bodyType && (
          <Info
            label="Кузов"
            value={BODY_TYPES.find(t => t.value === vehicle.bodyType)?.label ?? vehicle.bodyType}
          />
        )}
        {vehicle.engineCode && <Info label="Код двигуна" value={vehicle.engineCode} mono />}
        {vehicle.insuranceExpiry && (
          <div>
            <p className="text-xs text-muted-foreground">Страховка до</p>
            <div className="flex items-center gap-1.5 flex-wrap">
              <p className="text-foreground">{fmtDate(vehicle.insuranceExpiry)}</p>
              <ExpiryBadge
                date={vehicle.insuranceExpiry}
                nowMs={today?.getTime() ?? 0}
                expiredLabel="Страховка прострочена"
              />
            </div>
          </div>
        )}
        {vehicle.inspectionExpiry && (
          <div>
            <p className="text-xs text-muted-foreground">Техогляд до</p>
            <div className="flex items-center gap-1.5 flex-wrap">
              <p className="text-foreground">{fmtDate(vehicle.inspectionExpiry)}</p>
              <ExpiryBadge
                date={vehicle.inspectionExpiry}
                nowMs={today?.getTime() ?? 0}
                expiredLabel="Техогляд прострочений"
              />
            </div>
          </div>
        )}
        {vehicle.notes && (
          <div className="col-span-2">
            <Info label="Нотатки" value={vehicle.notes} />
          </div>
        )}
      </div>

      {/* Nodes */}
      <div className="bg-surface rounded-xl border border-border p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold text-foreground">Вузли автомобіля</h2>
          <Button variant="ghost" size="sm" onClick={() => setShowAddNode(v => !v)}>
            <Plus className="h-4 w-4" />
            Вузол
          </Button>
        </div>

        {showAddNode && (
          <AnimatedBody className="mb-4 p-3 bg-secondary rounded-lg space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-[13px] font-medium text-muted-foreground mb-1">
                  Категорія
                </label>
                <Select
                  value={nodeForm.category}
                  onChange={e => setNodeForm(f => ({ ...f, category: e.target.value }))}
                  className="h-8 text-[13px] py-0.5 px-2 pr-7"
                >
                  {Object.entries(NODE_CATEGORY_LABELS).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                  <option value="other">Інше</option>
                </Select>
              </div>
              <div>
                <label className="block text-[13px] font-medium text-muted-foreground mb-1">
                  Назва <span className="text-destructive">*</span>
                </label>
                <Input
                  value={nodeForm.name}
                  onChange={e => setNodeForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="Двигун 2.0 TSI"
                  className="h-8 text-[13px]"
                />
              </div>
            </div>
            <Input
              value={nodeForm.mileageAtInstall}
              onChange={e => setNodeForm(f => ({ ...f, mileageAtInstall: e.target.value }))}
              placeholder="Пробіг при встановленні, км"
              type="number"
              className="h-8 text-[13px]"
            />
            <Input
              value={nodeForm.notes}
              onChange={e => setNodeForm(f => ({ ...f, notes: e.target.value }))}
              placeholder="Нотатки"
              className="h-8 text-[13px]"
            />
            <div className="flex gap-2">
              <Button size="sm" onClick={addNode} loading={saving} disabled={!nodeForm.name}>
                Зберегти
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setShowAddNode(false)}>
                Скасувати
              </Button>
            </div>
          </AnimatedBody>
        )}

        {Object.keys(grouped).length === 0 && !showAddNode && (
          <p className="text-sm text-muted-foreground">Вузли не додані</p>
        )}

        {Object.entries(grouped).map(([cat, catNodes]) => (
          <div key={cat} className="mb-3">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">
              {NODE_CATEGORY_LABELS[cat] ?? cat}
            </p>
            <div className="divide-y divide-border border border-border rounded-lg overflow-hidden">
              {catNodes.map(n => (
                <div key={n.id} className="flex items-center justify-between px-3 py-2.5">
                  <div>
                    <p className="text-sm text-foreground">{n.name}</p>
                    {n.mileageAtInstall != null && (
                      <p className="text-xs text-muted-foreground">
                        Встановлено при {fmtInt(n.mileageAtInstall)} км
                      </p>
                    )}
                    {n.notes && <p className="text-xs text-muted-foreground">{n.notes}</p>}
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => removeNode(n.id)}
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
          <h2 className="font-semibold text-foreground">Регламент ТО</h2>
          <Button variant="ghost" size="sm" onClick={() => setShowAddSchedule(v => !v)}>
            <Plus className="h-4 w-4" />
            Регламент
          </Button>
        </div>

        {showAddSchedule && (
          <AnimatedBody className="mb-4 p-3 bg-secondary rounded-lg space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <Input
                label="Тип ТО"
                value={scheduleForm.maintenanceType}
                onChange={e => setScheduleForm(f => ({ ...f, maintenanceType: e.target.value }))}
                placeholder="ТО, Заміна масла..."
                className="h-8 text-[13px]"
              />
              <Input
                label="Нотатки"
                value={scheduleForm.notes}
                onChange={e => setScheduleForm(f => ({ ...f, notes: e.target.value }))}
                placeholder="Опціонально"
                className="h-8 text-[13px]"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Input
                label="Інтервал (дні)"
                type="number"
                min="1"
                value={scheduleForm.intervalDays}
                onChange={e => setScheduleForm(f => ({ ...f, intervalDays: e.target.value }))}
                placeholder="365"
                className="h-8 text-[13px]"
              />
              <Input
                label="Інтервал (км)"
                type="number"
                min="1"
                value={scheduleForm.intervalMileage}
                onChange={e => setScheduleForm(f => ({ ...f, intervalMileage: e.target.value }))}
                placeholder="10000"
                className="h-8 text-[13px]"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <DatePickerInput
                label="Дата останнього ТО"
                value={scheduleForm.lastMaintenanceDate}
                onChange={v => setScheduleForm(f => ({ ...f, lastMaintenanceDate: v }))}
              />
              <Input
                label="Пробіг при останньому ТО"
                type="number"
                min="0"
                value={scheduleForm.lastMaintenanceMileage}
                onChange={e =>
                  setScheduleForm(f => ({ ...f, lastMaintenanceMileage: e.target.value }))
                }
                placeholder="85000"
                className="h-8 text-[13px]"
              />
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={addSchedule}
                loading={savingSchedule}
                disabled={!scheduleForm.maintenanceType.trim()}
              >
                Зберегти
              </Button>
              <Button size="sm" variant="outline" onClick={() => setShowAddSchedule(false)}>
                Скасувати
              </Button>
            </div>
          </AnimatedBody>
        )}

        {schedules.length === 0 ? (
          <p className="text-sm text-muted-foreground">Регламентів ТО не додано</p>
        ) : (
          <div className="divide-y divide-border border border-border rounded-lg overflow-hidden">
            {schedules.map(sc => (
              <div key={sc.id} className="flex items-start justify-between px-3 py-2.5">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-foreground">{sc.maintenanceType}</p>
                    {!sc.isActive && (
                      <span className="text-[11px] px-1.5 py-0.5 bg-secondary text-muted-foreground rounded">
                        Неактивний
                      </span>
                    )}
                    {sc.nextMaintenanceDate && (
                      <ExpiryBadge
                        date={sc.nextMaintenanceDate}
                        nowMs={today?.getTime() ?? 0}
                        expiredLabel="Прострочено"
                        soonLabel="Незабаром"
                        soonDays={14}
                      />
                    )}
                  </div>
                  <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-0.5">
                    {sc.intervalDays && (
                      <p className="text-xs text-muted-foreground">Кожні {sc.intervalDays} дн.</p>
                    )}
                    {sc.intervalMileage && (
                      <p className="text-xs text-muted-foreground">
                        Кожні {fmtInt(sc.intervalMileage)} км
                      </p>
                    )}
                    {sc.nextMaintenanceDate && (
                      <p className="text-xs text-muted-foreground">
                        Наступне: {fmtDate(sc.nextMaintenanceDate)}
                      </p>
                    )}
                    {sc.nextMaintenanceMileage && (
                      <p className="text-xs text-muted-foreground">
                        При {fmtInt(sc.nextMaintenanceMileage)} км
                      </p>
                    )}
                    {sc.notes && <p className="text-xs text-muted-foreground">{sc.notes}</p>}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  loading={deletingScheduleId === sc.id}
                  onClick={() => removeSchedule(sc.id)}
                  className="text-destructive/70 hover:text-destructive hover:bg-destructive/10 shrink-0"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Edit Modal */}
      <Modal
        open={showEdit}
        onClose={() => setShowEdit(false)}
        title="Редагування автомобіля"
        size="lg"
        footer={
          <>
            <Button
              onClick={saveEdit}
              loading={editSaving}
              disabled={!editForm.make.trim() || !editForm.model.trim()}
            >
              Зберегти
            </Button>
            <Button variant="outline" onClick={() => setShowEdit(false)}>
              Скасувати
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
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Марка"
              required
              value={editForm.make}
              onChange={e => setEditForm(f => ({ ...f, make: e.target.value }))}
              placeholder="Toyota"
              className="h-8 text-[13px]"
            />
            <Input
              label="Модель"
              required
              value={editForm.model}
              onChange={e => setEditForm(f => ({ ...f, model: e.target.value }))}
              placeholder="Camry"
              className="h-8 text-[13px]"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Держ. номер"
              value={editForm.licensePlate}
              onChange={e => setEditForm(f => ({ ...f, licensePlate: e.target.value }))}
              placeholder="AA 1234 BB"
              className="h-8 text-[13px]"
            />
            <Input
              label="VIN"
              value={editForm.vin}
              onChange={e => setEditForm(f => ({ ...f, vin: e.target.value }))}
              placeholder="1HGCM82633A004352"
              className="font-mono h-8 text-[13px]"
            />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Input
              label="Рік"
              type="number"
              value={editForm.year}
              onChange={e => setEditForm(f => ({ ...f, year: e.target.value }))}
              placeholder="2024"
              min="1900"
              max="2100"
              className="h-8 text-[13px]"
            />
            <Input
              label="Об'єм, л"
              type="number"
              value={editForm.engineVolume}
              onChange={e => setEditForm(f => ({ ...f, engineVolume: e.target.value }))}
              placeholder="2.0"
              step="0.1"
              className="h-8 text-[13px]"
            />
            <Input
              label="Пробіг, км"
              type="number"
              value={editForm.currentMileage}
              onChange={e => setEditForm(f => ({ ...f, currentMileage: e.target.value }))}
              placeholder="85000"
              min="0"
              className="h-8 text-[13px]"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Select
              label="Тип палива"
              value={editForm.fuelType}
              onChange={e => setEditForm(f => ({ ...f, fuelType: e.target.value }))}
              placeholder="Не вказано"
              className="h-8 text-[13px] py-0.5 px-2 pr-7"
            >
              {FUEL_TYPES.map(ft => (
                <option key={ft} value={ft}>
                  {ft}
                </option>
              ))}
            </Select>
            <Input
              label="Колір"
              value={editForm.color}
              onChange={e => setEditForm(f => ({ ...f, color: e.target.value }))}
              placeholder="Сірий металік"
              className="h-8 text-[13px]"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Select
              label="Коробка передач"
              value={editForm.transmissionType}
              onChange={e => setEditForm(f => ({ ...f, transmissionType: e.target.value }))}
              className="h-8 text-[13px] py-0.5 px-2 pr-7"
            >
              {TRANSMISSION_TYPES.map(t => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </Select>
            <Select
              label="Привід"
              value={editForm.driveType}
              onChange={e => setEditForm(f => ({ ...f, driveType: e.target.value }))}
              className="h-8 text-[13px] py-0.5 px-2 pr-7"
            >
              {DRIVE_TYPES.map(t => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Select
              label="Тип кузова"
              value={editForm.bodyType}
              onChange={e => setEditForm(f => ({ ...f, bodyType: e.target.value }))}
              className="h-8 text-[13px] py-0.5 px-2 pr-7"
            >
              {BODY_TYPES.map(t => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </Select>
            <Input
              label="Код двигуна"
              value={editForm.engineCode}
              onChange={e => setEditForm(f => ({ ...f, engineCode: e.target.value }))}
              placeholder="2AZ-FE"
              className="font-mono h-8 text-[13px]"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <DatePickerInput
              label="Страховка до"
              value={editForm.insuranceExpiry}
              onChange={v => setEditForm(f => ({ ...f, insuranceExpiry: v }))}
            />
            <DatePickerInput
              label="Техогляд до"
              value={editForm.inspectionExpiry}
              onChange={v => setEditForm(f => ({ ...f, inspectionExpiry: v }))}
            />
          </div>
          <Input
            label="Нотатки"
            value={editForm.notes}
            onChange={e => setEditForm(f => ({ ...f, notes: e.target.value }))}
            placeholder="Додаткова інформація..."
            className="h-8 text-[13px]"
          />
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
