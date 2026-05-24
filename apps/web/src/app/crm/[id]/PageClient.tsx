'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, Plus } from 'lucide-react';
import { useRequireAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';

interface Counterparty {
  id: string; type: string; firstName: string | null; lastName: string | null;
  companyName: string | null; phone: string | null; email: string | null;
  edrpou: string | null; vatPayer: boolean; balance: number; notes: string | null;
}
interface Garage { id: string; name: string; address: string | null; }
interface Vehicle { id: string; make: string; model: string; licensePlate: string | null; year: number | null; currentMileage: number | null; }

const TYPE_LABELS: Record<string, string> = { CLIENT: 'Клієнт', SUPPLIER: 'Постачальник', BOTH: 'Клієнт / Постачальник' };
const TYPE_BADGE: Record<string, BadgeVariant> = { CLIENT: 'default', SUPPLIER: 'secondary', BOTH: 'warning' };

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <div>
      <p className="text-xs text-muted-foreground mb-0.5">{label}</p>
      <p className="text-sm text-foreground">{value}</p>
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
  const [saving, setSaving] = useState(false);
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
    setSaving(true);
    try {
      await apiFetch<Garage>(`/counterparties/${id}/garages`, {
        method: 'POST', body: JSON.stringify({ name: garageName, address: garageAddress || undefined }),
      });
      setGarageName(''); setGarageAddress(''); setShowAddGarage(false);
      load();
    } catch (e: unknown) { setLoadError(e instanceof Error ? e.message : 'Помилка збереження'); }
    finally { setSaving(false); }
  };

  const displayName = (c: Counterparty) =>
    c.companyName ?? [c.lastName, c.firstName].filter(Boolean).join(' ') ?? '—';

  if (!cp) return (
    <div className="flex items-center justify-center min-h-screen flex-col gap-4">
      {loadError
        ? <p className="text-[13px] text-[hsl(0_84%_42%)] bg-destructive-subtle border border-[hsl(0_84%_80%)] rounded-lg px-4 py-2">{loadError}</p>
        : <Spinner size="lg" />}
    </div>
  );

  return (
    <div className="page-container max-w-4xl space-y-6">
      {loadError && (
        <div className="text-[13px] text-[hsl(0_84%_42%)] bg-destructive-subtle border border-[hsl(0_84%_80%)] rounded-lg px-4 py-2">{loadError}</div>
      )}

      {/* Header */}
      <div className="flex items-start gap-4">
        <Button variant="ghost" size="sm" onClick={() => router.back()} className="mt-1">
          <ArrowLeft className="h-4 w-4" />
          Назад
        </Button>
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-foreground">{displayName(cp)}</h1>
          <div className="flex items-center gap-2 mt-1">
            <Badge variant={TYPE_BADGE[cp.type] ?? 'secondary'}>
              {TYPE_LABELS[cp.type] ?? cp.type}
            </Badge>
            {cp.vatPayer && <Badge variant="secondary">Платник ПДВ</Badge>}
          </div>
        </div>
        <div className={cn(
          'text-lg font-semibold',
          cp.balance < 0 ? 'text-destructive' : cp.balance > 0 ? 'text-success' : 'text-muted-foreground'
        )}>
          {cp.balance.toLocaleString('uk-UA', { minimumFractionDigits: 2 })} ₴
          <p className="text-xs font-normal text-muted-foreground text-right">баланс</p>
        </div>
      </div>

      {/* Info */}
      <div className="bg-surface rounded-xl border border-border p-5 grid grid-cols-2 gap-4">
        <Field label="Телефон" value={cp.phone} />
        <Field label="Email" value={cp.email} />
        <Field label="ЄДРПОУ" value={cp.edrpou} />
        <Field label="Нотатки" value={cp.notes} />
      </div>

      {/* Garages + Vehicles */}
      <div className="bg-surface rounded-xl border border-border p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold text-foreground">Гаражі та автомобілі</h2>
          <Button variant="ghost" size="sm" onClick={() => setShowAddGarage(v => !v)}>
            <Plus className="h-4 w-4" />
            Гараж
          </Button>
        </div>

        {showAddGarage && (
          <div className="mb-4 p-3 bg-secondary rounded-lg space-y-2">
            <Input
              value={garageName}
              onChange={e => setGarageName(e.target.value)}
              placeholder="Назва гаражу *"
            />
            <Input
              value={garageAddress}
              onChange={e => setGarageAddress(e.target.value)}
              placeholder="Адреса (необов'язково)"
            />
            <div className="flex gap-2">
              <Button size="sm" onClick={addGarage} loading={saving} disabled={!garageName.trim()}>
                Зберегти
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setShowAddGarage(false)}>
                Скасувати
              </Button>
            </div>
          </div>
        )}

        {garages.length === 0 && !showAddGarage && (
          <p className="text-sm text-muted-foreground">Немає гаражів</p>
        )}

        {garages.length > 0 && (
          <div className="flex gap-2 mb-4 flex-wrap">
            {garages.map(g => (
              <button
                key={g.id}
                onClick={() => setSelectedGarage(g.id)}
                className={cn(
                  'px-3 py-1.5 rounded-lg text-sm border transition-colors',
                  selectedGarage === g.id
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'border-border text-muted-foreground hover:bg-secondary',
                )}
              >
                {g.name}
                {g.address && <span className="text-xs opacity-70 ml-1">· {g.address}</span>}
              </button>
            ))}
          </div>
        )}

        {selectedGarage && (
          <>
            <div className="flex items-center justify-between mb-2">
              <p className="text-sm font-medium text-foreground">Автомобілі</p>
              <Button variant="ghost" size="sm" onClick={() => router.push(`/vehicles/new?garageId=${selectedGarage}`)}>
                <Plus className="h-4 w-4" />
                Авто
              </Button>
            </div>
            {vehicles.length === 0
              ? <p className="text-sm text-muted-foreground">Немає автомобілів</p>
              : (
                <div className="divide-y divide-border border border-border rounded-lg overflow-hidden">
                  {vehicles.map(v => (
                    <button
                      key={v.id}
                      onClick={() => router.push(`/vehicles/${v.id}`)}
                      className="w-full flex items-center justify-between px-4 py-3 hover:bg-secondary text-left transition-colors"
                    >
                      <div>
                        <p className="text-sm font-medium text-foreground">{v.make} {v.model}</p>
                        <p className="text-xs text-muted-foreground">{[v.licensePlate, v.year, v.currentMileage ? `${v.currentMileage.toLocaleString()} км` : null].filter(Boolean).join(' · ')}</p>
                      </div>
                      <span className="text-muted-foreground text-sm">→</span>
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
