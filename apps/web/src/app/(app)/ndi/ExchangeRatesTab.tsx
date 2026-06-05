'use client';

import { useEffect, useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useConfirm } from '@/hooks/useConfirm';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Modal } from '@/components/ui/modal';
import { SearchCombobox } from '@/components/ui/search-combobox';
import { apiFetch } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/lib/toast';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import type { Currency, ExchangeRate } from './types';

// Kyiv-local date formatter (YYYY-MM-DD) for exchange rate default date.
const KYIV_YMD = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Kyiv' });
const kyivToday = () => KYIV_YMD.format(new Date());

interface NbuSettings {
  nbuFetchHour?: number;
}

export default function ExchangeRatesTab() {
  const { confirm, dialogProps } = useConfirm();
  const currentFeatures = useUiFeatures();
  const [error, setError] = useState('');

  const [exchangeRates, setExchangeRates] = useState<ExchangeRate[]>([]);
  const [rateModal, setRateModal] = useState(false);
  const [editingRate, setEditingRate] = useState<ExchangeRate | null>(null);
  const [rateForm, setRateForm] = useState({
    currencyId: '',
    currencyDisplay: '',
    date: '',
    rate: '',
    coefficient: '1',
  });
  const [rateErrors, setRateErrors] = useState<{
    currencyId?: string;
    date?: string;
    rate?: string;
    coefficient?: string;
  }>({});
  const [savingRate, setSavingRate] = useState(false);
  const [loadingRates, setLoadingRates] = useState(false);
  const [fetchingNbu, setFetchingNbu] = useState(false);
  const [nbuFetchHour, setNbuFetchHour] = useState<number>(12);
  const [savingNbu, setSavingNbu] = useState(false);

  useEffect(() => {
    setLoadingRates(true);
    Promise.all([
      apiFetch<{ items: ExchangeRate[] }>('/exchange-rates'),
      apiFetch<NbuSettings>('/settings/organisation'),
    ])
      .then(([ratesRes, orgSettings]) => {
        setExchangeRates(ratesRes.items);
        setNbuFetchHour(orgSettings.nbuFetchHour ?? 12);
        setLoadingRates(false);
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : 'Помилка завантаження');
        setLoadingRates(false);
      });
  }, []);

  const openRateModal = (r?: ExchangeRate) => {
    setEditingRate(r ?? null);
    setRateErrors({});
    setRateForm(
      r
        ? {
            currencyId: r.currencyId,
            currencyDisplay: `${r.currencyCode} — ${r.currencyName}`,
            date: r.date,
            rate: String(r.rate),
            coefficient: String(r.coefficient),
          }
        : {
            currencyId: '',
            currencyDisplay: '',
            date: kyivToday(),
            rate: '',
            coefficient: '1',
          },
    );
    setRateModal(true);
  };

  const saveRate = async () => {
    const errs: typeof rateErrors = {};
    if (!editingRate && !rateForm.currencyId) errs.currencyId = 'Оберіть валюту';
    if (!rateForm.date) errs.date = 'Вкажіть дату';
    const rateNum = Number(rateForm.rate);
    if (!rateForm.rate || !Number.isFinite(rateNum) || rateNum <= 0)
      errs.rate = 'Курс має бути більше 0';
    const coefNum = Number(rateForm.coefficient);
    if (!Number.isFinite(coefNum) || coefNum <= 0)
      errs.coefficient = 'Кількість одиниць має бути більше 0';
    if (Object.keys(errs).length > 0) {
      setRateErrors(errs);
      return;
    }
    setRateErrors({});
    setSavingRate(true);
    try {
      const body = {
        currencyId: rateForm.currencyId,
        date: rateForm.date,
        rate: rateNum,
        coefficient: coefNum,
      };
      if (editingRate) {
        const updated = await apiFetch<ExchangeRate>(`/exchange-rates/${editingRate.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ date: body.date, rate: body.rate, coefficient: body.coefficient }),
        });
        setExchangeRates(prev => prev.map(r => (r.id === updated.id ? updated : r)));
      } else {
        const created = await apiFetch<ExchangeRate>('/exchange-rates', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        setExchangeRates(prev => [created, ...prev]);
      }
      setRateModal(false);
      if (currentFeatures.toastEnabled) toast.success('Збережено');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка');
    } finally {
      setSavingRate(false);
    }
  };

  const deleteRate = async (id: string) => {
    if (!(await confirm({ title: 'Видалити курс?', variant: 'destructive' }))) return;
    try {
      await apiFetch(`/exchange-rates/${id}`, { method: 'DELETE' });
      setExchangeRates(prev => prev.filter(r => r.id !== id));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка');
    }
  };

  const saveNbuFetchHour = async () => {
    setSavingNbu(true);
    try {
      await apiFetch('/settings/organisation', {
        method: 'PATCH',
        body: JSON.stringify({ nbuFetchHour }),
      });
      if (currentFeatures.toastEnabled) toast.success('Час завантаження збережено');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Помилка збереження';
      setError(msg);
      if (currentFeatures.toastEnabled) toast.error(msg);
    } finally {
      setSavingNbu(false);
    }
  };

  const triggerNbuFetch = async () => {
    setFetchingNbu(true);
    setError('');
    try {
      await apiFetch('/exchange-rates/nbu-fetch', { method: 'POST' });
      if (currentFeatures.toastEnabled) toast.success('Завантаження курсів НБУ поставлено в чергу');
      // Reload rates after 3s to show newly fetched data
      setTimeout(() => {
        void apiFetch<{ items: ExchangeRate[] }>('/exchange-rates').then(r =>
          setExchangeRates(r.items),
        );
      }, 3_000);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Помилка запуску завантаження';
      setError(msg);
      if (currentFeatures.toastEnabled) toast.error(msg);
    } finally {
      setFetchingNbu(false);
    }
  };

  return (
    <div className="space-y-4">
      {error && (
        <div className="text-sm text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg p-3">
          {error}
        </div>
      )}
      {/* NBU auto-fetch controls */}
      <div className="bg-surface border border-border rounded-lg px-4 py-3 space-y-3">
        <p className="text-sm font-medium text-foreground">Автозавантаження курсів НБУ</p>
        <div className="flex items-end gap-3 flex-wrap">
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">
              Година завантаження (0–23)
            </label>
            <input
              type="number"
              min={0}
              max={23}
              step={1}
              value={nbuFetchHour}
              onChange={e =>
                setNbuFetchHour(Math.max(0, Math.min(23, Math.floor(Number(e.target.value)))))
              }
              className="w-20 px-3 py-2 text-sm border border-border rounded-lg bg-input text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Щодня о {nbuFetchHour}:00 (за Києвом)
            </p>
          </div>
          <div className="flex gap-2 pb-6">
            <Button size="sm" onClick={() => void saveNbuFetchHour()} loading={savingNbu}>
              Зберегти час
            </Button>
            <Button
              size="sm"
              variant="outline"
              loading={fetchingNbu}
              onClick={() => void triggerNbuFetch()}
            >
              Завантажити зараз
            </Button>
          </div>
        </div>
      </div>

      <div className="flex justify-end">
        <Button onClick={() => openRateModal()}>
          <Plus className="w-4 h-4 mr-1" />
          Додати курс
        </Button>
      </div>
      {loadingRates && <p className="text-muted-foreground text-sm">Завантаження...</p>}
      {!loadingRates && exchangeRates.length === 0 && (
        <p className="text-muted-foreground text-sm">Курси не додано</p>
      )}
      <div className="space-y-2">
        {exchangeRates.map(r => (
          <div
            key={r.id}
            className="bg-surface border border-border rounded-lg px-4 py-3 flex items-center justify-between"
          >
            <div>
              <span className="font-medium text-foreground">{r.currencyCode}</span>
              <span className="ml-2 text-sm text-muted-foreground">{r.date}</span>
              <span className="ml-2 text-sm text-foreground">
                {Number(r.coefficient)} = {Number(r.rate)} UAH
              </span>
            </div>
            <div className="flex gap-2">
              <button
                aria-label="Редагувати курс"
                onClick={() => openRateModal(r)}
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                <Pencil className="w-4 h-4" />
              </button>
              <button
                aria-label="Видалити курс"
                onClick={() => void deleteRate(r.id)}
                className="text-destructive/70 hover:text-destructive transition-colors"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          </div>
        ))}
      </div>

      <Modal
        open={rateModal}
        onClose={() => setRateModal(false)}
        title={editingRate ? 'Редагувати курс' : 'Новий курс'}
        footer={
          <>
            <Button variant="outline" onClick={() => setRateModal(false)}>
              Скасувати
            </Button>
            <Button onClick={() => void saveRate()} loading={savingRate}>
              Зберегти
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {!editingRate && (
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">Валюта *</label>
              <SearchCombobox<Currency>
                value={rateForm.currencyId}
                displayValue={rateForm.currencyDisplay}
                onSelect={item => {
                  setRateForm({
                    ...rateForm,
                    currencyId: item.id,
                    currencyDisplay: `${item.code} — ${item.name}`,
                  });
                  if (rateErrors.currencyId) setRateErrors(p => ({ ...p, currencyId: undefined }));
                }}
                onClear={() => setRateForm({ ...rateForm, currencyId: '', currencyDisplay: '' })}
                fetchItems={async q => {
                  const r = await apiFetch<{ items: Currency[] }>(
                    `/currencies?q=${encodeURIComponent(q)}&limit=10`,
                  );
                  return r.items.map(c => ({
                    ...c,
                    primary: `${c.code} — ${c.name}`,
                    secondary: c.symbol ?? undefined,
                  }));
                }}
                placeholder="Пошук валюти..."
              />
              {rateErrors.currencyId && (
                <p className="text-xs text-destructive-text mt-1">{rateErrors.currencyId}</p>
              )}
            </div>
          )}
          <Input
            label="Дата"
            required
            type="date"
            value={rateForm.date}
            errorMessage={rateErrors.date}
            onChange={e => {
              setRateForm({ ...rateForm, date: e.target.value });
              if (rateErrors.date) setRateErrors(p => ({ ...p, date: undefined }));
            }}
          />
          <Input
            label="Курс (UAH)"
            required
            type="number"
            step="0.000001"
            value={rateForm.rate}
            errorMessage={rateErrors.rate}
            onChange={e => {
              setRateForm({ ...rateForm, rate: e.target.value });
              if (rateErrors.rate) setRateErrors(p => ({ ...p, rate: undefined }));
            }}
          />
          <Input
            label="Кількість одиниць"
            type="number"
            step="1"
            value={rateForm.coefficient}
            errorMessage={rateErrors.coefficient}
            onChange={e => {
              setRateForm({ ...rateForm, coefficient: e.target.value });
              if (rateErrors.coefficient) setRateErrors(p => ({ ...p, coefficient: undefined }));
            }}
            hint="Скільки одиниць валюти відповідають вказаному курсу"
          />
        </div>
      </Modal>

      <ConfirmDialog {...dialogProps} />
    </div>
  );
}
