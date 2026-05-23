'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useRequireAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api-client';

interface Counterparty {
  id: string; type: string; firstName: string | null; lastName: string | null;
  companyName: string | null; phone: string | null; email: string | null;
  edrpou: string | null; vatPayer: boolean; balance: number; notes: string | null;
}
interface Garage { id: string; name: string; address: string | null; }
interface Vehicle { id: string; make: string; model: string; licensePlate: string | null; year: number | null; currentMileage: number | null; }

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <div>
      <p className="text-xs text-gray-400 mb-0.5">{label}</p>
      <p className="text-sm text-gray-900">{value}</p>
    </div>
  );
}

export default function CounterpartyCardPage() {
  useRequireAuth(['OWNER', 'ADMIN', 'RECEPTIONIST', 'ACCOUNTANT']);
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [cp, setCp] = useState<Counterparty | null>(null);
  const [garages, setGarages] = useState<Garage[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [selectedGarage, setSelectedGarage] = useState<string | null>(null);
  const [showAddGarage, setShowAddGarage] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [garageName, setGarageName] = useState('');
  const [garageAddress, setGarageAddress] = useState('');

  const load = useCallback(() => {
    Promise.all([
      apiFetch<Counterparty>(`/counterparties/${id}`).then(setCp),
      apiFetch<Garage[]>(`/counterparties/${id}/garages`).then(g => {
        setGarages(g);
        if (g.length > 0 && !selectedGarage) setSelectedGarage(g[0].id);
      }),
    ]).catch((e: unknown) => setLoadError(e instanceof Error ? e.message : 'Помилка завантаження'));
  }, [id]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!selectedGarage) return;
    apiFetch<Vehicle[]>(`/vehicles?customerGarageId=${selectedGarage}`).then(setVehicles).catch((e: unknown) => setLoadError(e instanceof Error ? e.message : 'Помилка завантаження'));
  }, [selectedGarage]);

  const addGarage = async () => {
    if (!garageName.trim()) return;
    try {
      await apiFetch(`/counterparties/${id}/garages`, {
        method: 'POST', body: JSON.stringify({ name: garageName, address: garageAddress || undefined }),
      });
      setGarageName(''); setGarageAddress(''); setShowAddGarage(false);
      load();
    } catch (e: unknown) { setLoadError(e instanceof Error ? e.message : 'Помилка збереження'); }
  };

  const displayName = (c: Counterparty) =>
    c.companyName ?? [c.lastName, c.firstName].filter(Boolean).join(' ') ?? '—';

  if (!cp) return <div className="flex items-center justify-center min-h-screen"><div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin" /></div>;

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 space-y-6">
      {loadError && <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-2">{loadError}</p>}
      {/* Header */}
      <div className="flex items-start gap-4">
        <button onClick={() => router.back()} className="mt-1 text-gray-400 hover:text-gray-600 text-sm">← Назад</button>
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-gray-900">{displayName(cp)}</h1>
          <p className="text-sm text-gray-500 mt-1">
            {cp.type === 'CLIENT' ? 'Клієнт' : cp.type === 'SUPPLIER' ? 'Постачальник' : 'Клієнт / Постачальник'}
            {cp.vatPayer && ' · Платник ПДВ'}
          </p>
        </div>
        <div className={`text-lg font-semibold ${cp.balance < 0 ? 'text-red-600' : cp.balance > 0 ? 'text-green-600' : 'text-gray-600'}`}>
          {cp.balance.toLocaleString('uk-UA', { minimumFractionDigits: 2 })} ₴
          <p className="text-xs font-normal text-gray-400 text-right">баланс</p>
        </div>
      </div>

      {/* Info */}
      <div className="bg-white rounded-xl border p-5 grid grid-cols-2 gap-4">
        <Field label="Телефон" value={cp.phone} />
        <Field label="Email" value={cp.email} />
        <Field label="ЄДРПОУ" value={cp.edrpou} />
        <Field label="Нотатки" value={cp.notes} />
      </div>

      {/* Garages + Vehicles */}
      <div className="bg-white rounded-xl border p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold text-gray-900">Гаражі та автомобілі</h2>
          <button onClick={() => setShowAddGarage(v => !v)} className="text-sm text-blue-600 hover:underline">
            + Гараж
          </button>
        </div>

        {showAddGarage && (
          <div className="mb-4 p-3 bg-gray-50 rounded-lg space-y-2">
            <input value={garageName} onChange={e => setGarageName(e.target.value)} placeholder="Назва гаражу *"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
            <input value={garageAddress} onChange={e => setGarageAddress(e.target.value)} placeholder="Адреса (необов'язково)"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
            <div className="flex gap-2">
              <button onClick={addGarage} className="px-4 py-1.5 bg-blue-600 text-white rounded text-sm hover:bg-blue-700">Зберегти</button>
              <button onClick={() => setShowAddGarage(false)} className="px-4 py-1.5 text-gray-500 text-sm hover:text-gray-700">Скасувати</button>
            </div>
          </div>
        )}

        {garages.length === 0 && !showAddGarage && (
          <p className="text-sm text-gray-400">Немає гаражів</p>
        )}

        {garages.length > 0 && (
          <div className="flex gap-2 mb-4 flex-wrap">
            {garages.map(g => (
              <button key={g.id} onClick={() => setSelectedGarage(g.id)}
                className={`px-3 py-1.5 rounded-lg text-sm border transition-colors ${selectedGarage === g.id ? 'bg-blue-600 text-white border-blue-600' : 'border-gray-300 text-gray-600 hover:bg-gray-50'}`}>
                {g.name}
                {g.address && <span className="text-xs opacity-70 ml-1">· {g.address}</span>}
              </button>
            ))}
          </div>
        )}

        {selectedGarage && (
          <>
            <div className="flex items-center justify-between mb-2">
              <p className="text-sm font-medium text-gray-700">Автомобілі</p>
              <button onClick={() => router.push(`/vehicles/new?garageId=${selectedGarage}`)} className="text-sm text-blue-600 hover:underline">+ Авто</button>
            </div>
            {vehicles.length === 0
              ? <p className="text-sm text-gray-400">Немає автомобілів</p>
              : (
                <div className="divide-y border rounded-lg overflow-hidden">
                  {vehicles.map(v => (
                    <button key={v.id} onClick={() => router.push(`/vehicles/${v.id}`)}
                      className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-50 text-left">
                      <div>
                        <p className="text-sm font-medium text-gray-900">{v.make} {v.model}</p>
                        <p className="text-xs text-gray-400">{[v.licensePlate, v.year, v.currentMileage ? `${v.currentMileage.toLocaleString()} км` : null].filter(Boolean).join(' · ')}</p>
                      </div>
                      <span className="text-gray-300 text-sm">→</span>
                    </button>
                  ))}
                </div>
              )}
          </>
        )}
      </div>
    </div>
  );
}
