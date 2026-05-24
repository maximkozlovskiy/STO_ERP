'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useRequireAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api-client';

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
      await apiFetch(`/vehicles/${id}/nodes`, {
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
    try { await apiFetch(`/vehicles/${id}/nodes/${nodeId}`, { method: 'DELETE' }); load(); }
    catch (e: unknown) { setLoadError(e instanceof Error ? e.message : 'Помилка видалення'); }
  };

  if (!vehicle) return (
    <div className="flex items-center justify-center min-h-screen flex-col gap-4">
      {loadError
        ? <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-2">{loadError}</p>
        : <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin" />}
    </div>
  );

  const grouped = nodes.reduce<Record<string, VehicleNode[]>>((acc, n) => {
    (acc[n.category] ??= []).push(n);
    return acc;
  }, {});

  return (
    <div className="max-w-3xl mx-auto px-4 py-8 space-y-6">
      {loadError && <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-2">{loadError}</p>}
      <div className="flex items-center gap-3">
        <button onClick={() => router.back()} className="text-gray-400 hover:text-gray-600 text-sm">← Назад</button>
        <h1 className="text-2xl font-bold text-gray-900">{vehicle.make} {vehicle.model}</h1>
      </div>

      {/* Vehicle info */}
      <div className="bg-white rounded-xl border p-5 grid grid-cols-2 gap-3 text-sm">
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
      <div className="bg-white rounded-xl border p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold text-gray-900">Вузли автомобіля</h2>
          <button onClick={() => setShowAddNode(v => !v)} className="text-sm text-blue-600 hover:underline">+ Вузол</button>
        </div>

        {showAddNode && (
          <div className="mb-4 p-3 bg-gray-50 rounded-lg space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Категорія</label>
                <select value={nodeForm.category} onChange={e => setNodeForm(f => ({ ...f, category: e.target.value }))}
                  className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm">
                  {Object.entries(NODE_CATEGORY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  <option value="other">Інше</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Назва *</label>
                <input value={nodeForm.name} onChange={e => setNodeForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="Двигун 2.0 TSI"
                  className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm" />
              </div>
            </div>
            <input value={nodeForm.mileageAtInstall} onChange={e => setNodeForm(f => ({ ...f, mileageAtInstall: e.target.value }))}
              placeholder="Пробіг при встановленні, км" type="number"
              className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm" />
            <input value={nodeForm.notes} onChange={e => setNodeForm(f => ({ ...f, notes: e.target.value }))}
              placeholder="Нотатки" className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm" />
            <div className="flex gap-2">
              <button onClick={addNode} disabled={saving || !nodeForm.name}
                className="px-4 py-1.5 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-60">
                {saving ? '...' : 'Зберегти'}
              </button>
              <button onClick={() => setShowAddNode(false)} className="px-4 py-1.5 text-gray-500 text-sm">Скасувати</button>
            </div>
          </div>
        )}

        {Object.keys(grouped).length === 0 && !showAddNode && (
          <p className="text-sm text-gray-400">Вузли не додані</p>
        )}

        {Object.entries(grouped).map(([cat, catNodes]) => (
          <div key={cat} className="mb-3">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1">
              {NODE_CATEGORY_LABELS[cat] ?? cat}
            </p>
            <div className="divide-y border rounded-lg overflow-hidden">
              {catNodes.map(n => (
                <div key={n.id} className="flex items-center justify-between px-3 py-2.5">
                  <div>
                    <p className="text-sm text-gray-900">{n.name}</p>
                    {n.mileageAtInstall != null && (
                      <p className="text-xs text-gray-400">Встановлено при {n.mileageAtInstall.toLocaleString('uk-UA')} км</p>
                    )}
                    {n.notes && <p className="text-xs text-gray-400">{n.notes}</p>}
                  </div>
                  <button onClick={() => removeNode(n.id)} className="text-xs text-red-400 hover:text-red-600 px-2">×</button>
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
      <p className="text-xs text-gray-400">{label}</p>
      <p className="text-gray-900">{value}</p>
    </div>
  );
}
