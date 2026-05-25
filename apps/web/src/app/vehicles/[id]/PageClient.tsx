'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, Pencil, Plus, Trash2 } from 'lucide-react';
import { useRequireAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Modal } from '@/components/ui/modal';

interface Vehicle {
  id: string; make: string; model: string; vin: string | null; licensePlate: string | null;
  year: number | null; engineVolume: number | null; fuelType: string | null;
  currentMileage: number | null; color: string | null; notes: string | null;
  transmissionType: string | null; driveType: string | null; bodyType: string | null;
  engineCode: string | null; insuranceExpiry: string | null; inspectionExpiry: string | null;
}
interface VehicleNode { id: string; category: string; name: string; mileageAtInstall: number | null; notes: string | null; }

const FUEL_TYPES = ['Бензин', 'Дизель', 'Газ', 'Гібрид', 'Електро', 'LPG'];
const TRANSMISSION_TYPES = [
  { value: '', label: 'Не вказано' }, { value: 'manual', label: 'Механічна' },
  { value: 'automatic', label: 'Автоматична' }, { value: 'variator', label: 'Варіатор' },
  { value: 'robot', label: 'Робот' },
];
const DRIVE_TYPES = [
  { value: '', label: 'Не вказано' }, { value: 'fwd', label: 'Передній (FWD)' },
  { value: 'rwd', label: 'Задній (RWD)' }, { value: 'awd', label: 'Повний (AWD)' },
  { value: '4wd', label: '4WD' },
];
const BODY_TYPES = [
  { value: '', label: 'Не вказано' }, { value: 'sedan', label: 'Седан' },
  { value: 'hatchback', label: 'Хетчбек' }, { value: 'suv', label: 'Позашляховик' },
  { value: 'crossover', label: 'Кросовер' }, { value: 'van', label: 'Мінівен' },
  { value: 'truck', label: 'Вантажівка' }, { value: 'coupe', label: 'Купе' },
  { value: 'wagon', label: 'Універсал' }, { value: 'convertible', label: 'Кабріолет' },
];
const NODE_CATEGORY_LABELS: Record<string, string> = {
  engine: 'Двигун', gearbox: 'КПП', suspension: 'Підвіска',
  electrical: 'Електрика', AC: 'Кондиціонер', body: 'Кузов',
};

export default function VehicleCardPage() {
  useRequireAuth(['OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC']);
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [vehicle, setVehicle] = useState<Vehicle | null>(null);
  const [nodes, setNodes] = useState<VehicleNode[]>([]);
  const [showAddNode, setShowAddNode] = useState(false);
  const [nodeForm, setNodeForm] = useState({ category: 'engine', name: '', mileageAtInstall: '', notes: '' });
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState('');

  const [showEdit, setShowEdit] = useState(false);
  const [editForm, setEditForm] = useState({
    make: '', model: '', vin: '', licensePlate: '', year: '', engineVolume: '',
    fuelType: '', currentMileage: '', color: '', transmissionType: '', driveType: '',
    bodyType: '', engineCode: '', insuranceExpiry: '', inspectionExpiry: '', notes: '',
  });
  const [editError, setEditError] = useState('');
  const [editSaving, setEditSaving] = useState(false);

  const load = () => {
    Promise.all([
      apiFetch<Vehicle>(`/vehicles/${id}`).then(setVehicle),
      apiFetch<VehicleNode[]>(`/vehicles/${id}/nodes`).then(setNodes),
    ]).catch((e: unknown) => setLoadError(e instanceof Error ? e.message : 'Помилка завантаження'));
  };
  useEffect(() => { load(); }, [id]);

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
      setEditError('Марка та модель є обов\'язковими полями');
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
          mileageAtInstall: nodeForm.mileageAtInstall ? Number(nodeForm.mileageAtInstall) : undefined,
          notes: nodeForm.notes || undefined,
        }),
      });
      setNodeForm({ category: 'engine', name: '', mileageAtInstall: '', notes: '' });
      setShowAddNode(false);
      load();
    } catch (e: unknown) { setLoadError(e instanceof Error ? e.message : 'Помилка збереження'); }
    finally { setSaving(false); }
  };

  const removeNode = async (nodeId: string) => {
    if (!confirm('Видалити вузол?')) return;
    setSaving(true);
    try { await apiFetch<void>(`/vehicles/${id}/nodes/${nodeId}`, { method: 'DELETE' }); load(); }
    catch (e: unknown) { setLoadError(e instanceof Error ? e.message : 'Помилка видалення'); }
    finally { setSaving(false); }
  };

  if (!vehicle) return (
    <div className="flex items-center justify-center min-h-screen flex-col gap-4">
      {loadError
        ? <p className="text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-4 py-2">{loadError}</p>
        : <Spinner size="lg" />}
    </div>
  );

  const grouped = nodes.reduce<Record<string, VehicleNode[]>>((acc, n) => {
    (acc[n.category] ??= []).push(n);
    return acc;
  }, {});

  return (
    <div className="page-container max-w-3xl space-y-6">
      {loadError && (
        <div className="text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-4 py-2">{loadError}</div>
      )}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => router.back()}>
          <ArrowLeft className="h-4 w-4" />
          Назад
        </Button>
        <h1 className="text-2xl font-bold text-foreground flex-1">{vehicle.make} {vehicle.model}</h1>
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
        {vehicle.currentMileage != null && <Info label="Пробіг, км" value={vehicle.currentMileage.toLocaleString('uk-UA')} />}
        {vehicle.color && <Info label="Колір" value={vehicle.color} />}
        {vehicle.transmissionType && <Info label="Коробка" value={TRANSMISSION_TYPES.find(t => t.value === vehicle.transmissionType)?.label ?? vehicle.transmissionType} />}
        {vehicle.driveType && <Info label="Привід" value={DRIVE_TYPES.find(t => t.value === vehicle.driveType)?.label ?? vehicle.driveType} />}
        {vehicle.bodyType && <Info label="Кузов" value={BODY_TYPES.find(t => t.value === vehicle.bodyType)?.label ?? vehicle.bodyType} />}
        {vehicle.engineCode && <Info label="Код двигуна" value={vehicle.engineCode} mono />}
        {vehicle.insuranceExpiry && <Info label="Страховка до" value={new Date(vehicle.insuranceExpiry).toLocaleDateString('uk-UA')} />}
        {vehicle.inspectionExpiry && <Info label="Техогляд до" value={new Date(vehicle.inspectionExpiry).toLocaleDateString('uk-UA')} />}
        {vehicle.notes && <div className="col-span-2"><Info label="Нотатки" value={vehicle.notes} /></div>}
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
          <div className="mb-4 p-3 bg-secondary rounded-lg space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">Категорія</label>
                <Select
                  value={nodeForm.category}
                  onChange={e => setNodeForm(f => ({ ...f, category: e.target.value }))}
                >
                  {Object.entries(NODE_CATEGORY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  <option value="other">Інше</option>
                </Select>
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">Назва <span className="text-red-500">*</span></label>
                <Input
                  value={nodeForm.name}
                  onChange={e => setNodeForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="Двигун 2.0 TSI"
                />
              </div>
            </div>
            <Input
              value={nodeForm.mileageAtInstall}
              onChange={e => setNodeForm(f => ({ ...f, mileageAtInstall: e.target.value }))}
              placeholder="Пробіг при встановленні, км"
              type="number"
            />
            <Input
              value={nodeForm.notes}
              onChange={e => setNodeForm(f => ({ ...f, notes: e.target.value }))}
              placeholder="Нотатки"
            />
            <div className="flex gap-2">
              <Button size="sm" onClick={addNode} loading={saving} disabled={!nodeForm.name}>
                Зберегти
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setShowAddNode(false)}>
                Скасувати
              </Button>
            </div>
          </div>
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
                      <p className="text-xs text-muted-foreground">Встановлено при {n.mileageAtInstall.toLocaleString('uk-UA')} км</p>
                    )}
                    {n.notes && <p className="text-xs text-muted-foreground">{n.notes}</p>}
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => removeNode(n.id)}
                    className="text-destructive/60 hover:text-destructive"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Edit Modal */}
      <Modal
        open={showEdit}
        onClose={() => setShowEdit(false)}
        title="Редагування автомобіля"
        size="lg"
        footer={
          <>
            <Button onClick={saveEdit} loading={editSaving} disabled={!editForm.make.trim() || !editForm.model.trim()}>
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
            <Input label="Марка" required value={editForm.make} onChange={e => setEditForm(f => ({ ...f, make: e.target.value }))} placeholder="Toyota" />
            <Input label="Модель" required value={editForm.model} onChange={e => setEditForm(f => ({ ...f, model: e.target.value }))} placeholder="Camry" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Input label="Держ. номер" value={editForm.licensePlate} onChange={e => setEditForm(f => ({ ...f, licensePlate: e.target.value }))} placeholder="AA 1234 BB" />
            <Input label="VIN" value={editForm.vin} onChange={e => setEditForm(f => ({ ...f, vin: e.target.value }))} placeholder="1HGCM82633A004352" className="font-mono" />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Input label="Рік" type="number" value={editForm.year} onChange={e => setEditForm(f => ({ ...f, year: e.target.value }))} placeholder="2024" min="1900" max="2100" />
            <Input label="Об'єм, л" type="number" value={editForm.engineVolume} onChange={e => setEditForm(f => ({ ...f, engineVolume: e.target.value }))} placeholder="2.0" step="0.1" />
            <Input label="Пробіг, км" type="number" value={editForm.currentMileage} onChange={e => setEditForm(f => ({ ...f, currentMileage: e.target.value }))} placeholder="85000" min="0" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Select label="Тип палива" value={editForm.fuelType} onChange={e => setEditForm(f => ({ ...f, fuelType: e.target.value }))} placeholder="Не вказано">
              {FUEL_TYPES.map(ft => <option key={ft} value={ft}>{ft}</option>)}
            </Select>
            <Input label="Колір" value={editForm.color} onChange={e => setEditForm(f => ({ ...f, color: e.target.value }))} placeholder="Сірий металік" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Select label="Коробка передач" value={editForm.transmissionType} onChange={e => setEditForm(f => ({ ...f, transmissionType: e.target.value }))}>
              {TRANSMISSION_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
            </Select>
            <Select label="Привід" value={editForm.driveType} onChange={e => setEditForm(f => ({ ...f, driveType: e.target.value }))}>
              {DRIVE_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Select label="Тип кузова" value={editForm.bodyType} onChange={e => setEditForm(f => ({ ...f, bodyType: e.target.value }))}>
              {BODY_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
            </Select>
            <Input label="Код двигуна" value={editForm.engineCode} onChange={e => setEditForm(f => ({ ...f, engineCode: e.target.value }))} placeholder="2AZ-FE" className="font-mono" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Input label="Страховка до" type="date" value={editForm.insuranceExpiry} onChange={e => setEditForm(f => ({ ...f, insuranceExpiry: e.target.value }))} />
            <Input label="Техогляд до" type="date" value={editForm.inspectionExpiry} onChange={e => setEditForm(f => ({ ...f, inspectionExpiry: e.target.value }))} />
          </div>
          <Input label="Нотатки" value={editForm.notes} onChange={e => setEditForm(f => ({ ...f, notes: e.target.value }))} placeholder="Додаткова інформація..." />
        </div>
      </Modal>
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
