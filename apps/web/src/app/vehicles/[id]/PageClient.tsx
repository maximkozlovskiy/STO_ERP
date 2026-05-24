'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, Plus, Trash2 } from 'lucide-react';
import { useRequireAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';

interface Vehicle {
  id: string; make: string; model: string; vin: string | null; licensePlate: string | null;
  year: number | null; engineVolume: number | null; fuelType: string | null;
  currentMileage: number | null; color: string | null; notes: string | null;
}
interface VehicleNode { id: string; category: string; name: string; mileageAtInstall: number | null; notes: string | null; }

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

  const load = () => {
    Promise.all([
      apiFetch<Vehicle>(`/vehicles/${id}`).then(setVehicle),
      apiFetch<VehicleNode[]>(`/vehicles/${id}/nodes`).then(setNodes),
    ]).catch((e: unknown) => setLoadError(e instanceof Error ? e.message : 'Помилка завантаження'));
  };
  useEffect(() => { load(); }, [id]);

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
        ? <p className="text-[13px] text-[hsl(0_84%_42%)] bg-destructive-subtle border border-[hsl(0_84%_80%)] rounded-lg px-4 py-2">{loadError}</p>
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
        <div className="text-[13px] text-[hsl(0_84%_42%)] bg-destructive-subtle border border-[hsl(0_84%_80%)] rounded-lg px-4 py-2">{loadError}</div>
      )}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => router.back()}>
          <ArrowLeft className="h-4 w-4" />
          Назад
        </Button>
        <h1 className="text-2xl font-bold text-foreground">{vehicle.make} {vehicle.model}</h1>
      </div>

      {/* Vehicle info */}
      <div className="bg-surface rounded-xl border border-border p-5 grid grid-cols-2 gap-3 text-sm">
        {vehicle.licensePlate && <Info label="Держ. номер" value={vehicle.licensePlate} />}
        {vehicle.vin && <Info label="VIN" value={vehicle.vin} />}
        {vehicle.year && <Info label="Рік" value={String(vehicle.year)} />}
        {vehicle.engineVolume && <Info label="Об'єм, л" value={String(vehicle.engineVolume)} />}
        {vehicle.fuelType && <Info label="Паливо" value={vehicle.fuelType} />}
        {vehicle.currentMileage != null && <Info label="Пробіг, км" value={vehicle.currentMileage.toLocaleString('uk-UA')} />}
        {vehicle.color && <Info label="Колір" value={vehicle.color} />}
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
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-foreground">{value}</p>
    </div>
  );
}
