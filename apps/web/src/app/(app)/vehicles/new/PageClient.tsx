'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { useRequireAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { DatePickerInput } from '@/components/ui/date-picker-input';

interface VehicleResponse {
  id: string;
  customerGarageId: string;
  make: string;
  model: string;
}

// Гараж не має власного GET-by-id endpoint (лише список /counterparties/:id/garages) —
// назва передається з картки контрагента через query, без зайвого round-trip до API.

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

export default function NewVehiclePageClient() {
  useRequireAuth(['OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC']);
  const router = useRouter();
  const searchParams = useSearchParams();
  const garageId = searchParams.get('garageId') ?? '';
  const garageNameParam = searchParams.get('garageName') ?? '';

  const [form, setForm] = useState({
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
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [garageName, setGarageName] = useState(garageNameParam);
  // Bug (review): `new Date().getFullYear()` у render path → hydration mismatch
  // при build-time SSR + рантайм у наступному році. Тримати у useState через
  // useEffect — placeholder з'явиться після hydration, без SSR/CSR розбіжності.
  const [currentYear, setCurrentYear] = useState('');
  useEffect(() => {
    setCurrentYear(String(new Date().getFullYear()));
  }, []);

  const set = (field: string, value: string) => setForm(f => ({ ...f, [field]: value }));

  const handleSubmit = async () => {
    if (!form.make.trim() || !form.model.trim()) {
      setError("Марка та модель є обов'язковими полями");
      return;
    }
    if (!garageId) {
      setError('Гараж не вказано');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const body: Record<string, unknown> = {
        customerGarageId: garageId,
        make: form.make.trim(),
        model: form.model.trim(),
      };
      if (form.vin.trim()) body.vin = form.vin.trim();
      if (form.licensePlate.trim()) body.licensePlate = form.licensePlate.trim();
      if (form.year) body.year = parseInt(form.year, 10);
      if (form.engineVolume) body.engineVolume = parseFloat(form.engineVolume);
      if (form.fuelType) body.fuelType = form.fuelType;
      if (form.currentMileage) body.currentMileage = parseInt(form.currentMileage, 10);
      if (form.color.trim()) body.color = form.color.trim();
      if (form.transmissionType) body.transmissionType = form.transmissionType;
      if (form.driveType) body.driveType = form.driveType;
      if (form.bodyType) body.bodyType = form.bodyType;
      if (form.engineCode.trim()) body.engineCode = form.engineCode.trim();
      if (form.insuranceExpiry) body.insuranceExpiry = form.insuranceExpiry;
      if (form.inspectionExpiry) body.inspectionExpiry = form.inspectionExpiry;
      if (form.notes.trim()) body.notes = form.notes.trim();

      const vehicle = await apiFetch<VehicleResponse>('/vehicles', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      router.replace(`/vehicles/${vehicle.id}`);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка збереження');
    } finally {
      setSaving(false);
    }
  };

  if (!garageId) {
    return (
      <div className="page-container max-w-xl flex flex-col items-center justify-center py-20 gap-4">
        <p className="text-destructive-text">Гараж не вказано. Поверніться до картки клієнта.</p>
        <Button variant="ghost" onClick={() => router.back()}>
          <ArrowLeft className="h-4 w-4 mr-1" />
          Назад
        </Button>
      </div>
    );
  }

  return (
    <div className="page-container max-w-2xl space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => router.back()}>
          <ArrowLeft className="h-4 w-4" />
          Назад
        </Button>
        <div>
          <h1 className="text-xl font-bold text-foreground">Новий автомобіль</h1>
          {garageName && <p className="text-sm text-muted-foreground">Гараж: {garageName}</p>}
        </div>
      </div>

      {error && (
        <div className="text-sm text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-4 py-2.5">
          {error}
        </div>
      )}

      {/* Main info */}
      <div className="bg-surface rounded-xl border border-border p-5 space-y-4">
        <h2 className="text-sm font-semibold text-foreground">Основна інформація</h2>
        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Марка"
            required
            value={form.make}
            onChange={e => set('make', e.target.value)}
            placeholder="Toyota"
            className="h-8 text-[13px]"
          />
          <Input
            label="Модель"
            required
            value={form.model}
            onChange={e => set('model', e.target.value)}
            placeholder="Camry"
            className="h-8 text-[13px]"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Держ. номер"
            value={form.licensePlate}
            onChange={e => set('licensePlate', e.target.value)}
            placeholder="AA 1234 BB"
            className="h-8 text-[13px]"
          />
          <Input
            label="VIN"
            value={form.vin}
            onChange={e => set('vin', e.target.value)}
            placeholder="1HGCM82633A004352"
            className="font-mono h-8 text-[13px]"
          />
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Input
            label="Рік випуску"
            type="number"
            value={form.year}
            onChange={e => set('year', e.target.value)}
            placeholder={currentYear}
            min="1900"
            max="2100"
            className="h-8 text-[13px]"
          />
          <Input
            label="Об'єм двигуна, л"
            type="number"
            value={form.engineVolume}
            onChange={e => set('engineVolume', e.target.value)}
            placeholder="2.0"
            step="0.1"
            className="h-8 text-[13px]"
          />
          <Input
            label="Пробіг, км"
            type="number"
            value={form.currentMileage}
            onChange={e => set('currentMileage', e.target.value)}
            placeholder="85000"
            min="0"
            className="h-8 text-[13px]"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Select
            label="Тип палива"
            value={form.fuelType}
            onChange={e => set('fuelType', e.target.value)}
            placeholder="Не вказано"
            className="h-8 text-[13px] py-0.5 px-2 pr-7"
          >
            {FUEL_TYPES.map(f => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </Select>
          <Input
            label="Колір"
            value={form.color}
            onChange={e => set('color', e.target.value)}
            placeholder="Сірий металік"
            className="h-8 text-[13px]"
          />
        </div>
      </div>

      {/* Technical details */}
      <div className="bg-surface rounded-xl border border-border p-5 space-y-4">
        <h2 className="text-sm font-semibold text-foreground">Технічні характеристики</h2>
        <div className="grid grid-cols-2 gap-3">
          <Select
            label="Коробка передач"
            value={form.transmissionType}
            onChange={e => set('transmissionType', e.target.value)}
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
            value={form.driveType}
            onChange={e => set('driveType', e.target.value)}
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
            value={form.bodyType}
            onChange={e => set('bodyType', e.target.value)}
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
            value={form.engineCode}
            onChange={e => set('engineCode', e.target.value)}
            placeholder="2AZ-FE"
            className="font-mono h-8 text-[13px]"
          />
        </div>
      </div>

      {/* Documents */}
      <div className="bg-surface rounded-xl border border-border p-5 space-y-4">
        <h2 className="text-sm font-semibold text-foreground">Документи</h2>
        <div className="grid grid-cols-2 gap-3">
          <DatePickerInput
            label="Страховка до"
            value={form.insuranceExpiry}
            onChange={v => set('insuranceExpiry', v)}
          />
          <DatePickerInput
            label="Техогляд до"
            value={form.inspectionExpiry}
            onChange={v => set('inspectionExpiry', v)}
          />
        </div>
      </div>

      {/* Notes */}
      <div className="bg-surface rounded-xl border border-border p-5">
        <Input
          label="Нотатки"
          value={form.notes}
          onChange={e => set('notes', e.target.value)}
          placeholder="Додаткова інформація про авто..."
          className="h-8 text-[13px]"
        />
      </div>

      {/* Actions */}
      <div className="flex gap-3 pb-6">
        <Button
          onClick={handleSubmit}
          loading={saving}
          disabled={!form.make.trim() || !form.model.trim()}
          className="flex-1"
        >
          Зберегти автомобіль
        </Button>
        <Button variant="outline" onClick={() => router.back()}>
          Скасувати
        </Button>
      </div>
    </div>
  );
}
