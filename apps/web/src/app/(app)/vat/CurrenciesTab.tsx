'use client';

import { useEffect, useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useConfirm } from '@/hooks/useConfirm';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Modal } from '@/components/ui/modal';
import { TemplatePickerModal, type SystemTemplate } from '@/components/ui/template-picker-modal';
import { apiFetch } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/lib/toast';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import { getCached, setCache } from '@/lib/ref-cache';
import type { Currency } from './types';

export default function CurrenciesTab() {
  const { confirm, dialogProps } = useConfirm();
  const currentFeatures = useUiFeatures();
  const [error, setError] = useState('');

  const [currencies, setCurrencies] = useState<Currency[]>([]);
  const [currencyModal, setCurrencyModal] = useState(false);
  const [editingCurrency, setEditingCurrency] = useState<Currency | null>(null);
  const [currencyForm, setCurrencyForm] = useState({
    name: '',
    code: '',
    symbol: '',
    fullName: '',
    internationalName: '',
    nbuFetchEnabled: false,
    nbuMarkupPercent: '',
  });
  const [currencyErrors, setCurrencyErrors] = useState<{ name?: string; code?: string }>({});
  const [savingCurrency, setSavingCurrency] = useState(false);
  const [loadingCurrencies, setLoadingCurrencies] = useState(false);
  const [currencyTemplatePicker, setCurrencyTemplatePicker] = useState(false);

  useEffect(() => {
    setLoadingCurrencies(true);
    const cached = getCached<{ items: Currency[] }>('cache:currencies');
    if (cached) {
      setCurrencies(cached.items);
      setLoadingCurrencies(false);
    }
    apiFetch<{ items: Currency[] }>('/currencies')
      .then(res => {
        setCurrencies(res.items);
        setCache('cache:currencies', res);
        setLoadingCurrencies(false);
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : 'Помилка завантаження');
        setLoadingCurrencies(false);
      });
  }, []);

  const openCurrencyModal = (c?: Currency) => {
    setEditingCurrency(c ?? null);
    setCurrencyErrors({});
    setCurrencyForm(
      c
        ? {
            name: c.name,
            code: c.code,
            symbol: c.symbol ?? '',
            fullName: c.fullName ?? '',
            internationalName: c.internationalName ?? '',
            nbuFetchEnabled: c.nbuFetchEnabled ?? false,
            nbuMarkupPercent: c.nbuMarkupPercent != null ? String(c.nbuMarkupPercent) : '',
          }
        : {
            name: '',
            code: '',
            symbol: '',
            fullName: '',
            internationalName: '',
            nbuFetchEnabled: false,
            nbuMarkupPercent: '',
          },
    );
    setCurrencyModal(true);
  };

  const saveCurrency = async () => {
    const errs: typeof currencyErrors = {};
    if (!currencyForm.name.trim()) errs.name = 'Введіть назву валюти';
    if (!currencyForm.code.trim()) errs.code = 'Введіть код валюти';
    if (Object.keys(errs).length > 0) {
      setCurrencyErrors(errs);
      return;
    }
    setCurrencyErrors({});
    setSavingCurrency(true);
    try {
      const body = {
        name: currencyForm.name.trim(),
        code: currencyForm.code.trim(),
        symbol: currencyForm.symbol.trim() || undefined,
        fullName: currencyForm.fullName.trim() || undefined,
        internationalName: currencyForm.internationalName.trim() || undefined,
        nbuFetchEnabled: currencyForm.nbuFetchEnabled,
        nbuMarkupPercent:
          currencyForm.nbuFetchEnabled && currencyForm.nbuMarkupPercent !== ''
            ? parseFloat(currencyForm.nbuMarkupPercent)
            : null,
      };
      if (editingCurrency) {
        const updated = await apiFetch<Currency>(`/currencies/${editingCurrency.id}`, {
          method: 'PATCH',
          body: JSON.stringify(body),
        });
        setCurrencies(prev => {
          const next = prev.map(c => (c.id === updated.id ? updated : c));
          setCache('cache:currencies', { items: next });
          return next;
        });
      } else {
        const created = await apiFetch<Currency>('/currencies', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        setCurrencies(prev => {
          const next = [...prev, created];
          setCache('cache:currencies', { items: next });
          return next;
        });
      }
      setCurrencyModal(false);
      if (currentFeatures.toastEnabled)
        toast.success(editingCurrency ? 'Збережено' : 'Валюту додано');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка');
    } finally {
      setSavingCurrency(false);
    }
  };

  const deleteCurrency = async (id: string) => {
    if (!(await confirm({ title: 'Видалити валюту?', variant: 'destructive' }))) return;
    try {
      await apiFetch(`/currencies/${id}`, { method: 'DELETE' });
      setCurrencies(prev => {
        const next = prev.filter(c => c.id !== id);
        setCache('cache:currencies', { items: next });
        return next;
      });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка');
    }
  };

  const importCurrenciesFromTemplates = async (templates: SystemTemplate[]) => {
    for (const t of templates) {
      const created = await apiFetch<Currency>('/currencies', {
        method: 'POST',
        body: JSON.stringify(t.data),
      });
      setCurrencies(prev => {
        const next = [...prev, created];
        setCache('cache:currencies', { items: next });
        return next;
      });
    }
  };

  return (
    <div className="space-y-4">
      {error && (
        <div className="text-sm text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg p-3">
          {error}
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={() => setCurrencyTemplatePicker(true)}>
          З шаблону
        </Button>
        <Button onClick={() => openCurrencyModal()}>
          <Plus className="w-4 h-4 mr-1" />
          Валюта
        </Button>
      </div>
      <TemplatePickerModal
        open={currencyTemplatePicker}
        onClose={() => setCurrencyTemplatePicker(false)}
        entityType="currency"
        title="Додати валюти з шаблону"
        existingKeys={currencies.map(c => c.code)}
        onImport={importCurrenciesFromTemplates}
      />
      {loadingCurrencies && <p className="text-muted-foreground text-sm">Завантаження...</p>}
      {!loadingCurrencies && currencies.length === 0 && (
        <p className="text-muted-foreground text-sm">Валюти не додано</p>
      )}
      <div className="space-y-2">
        {currencies.map(c => (
          <div
            key={c.id}
            className="bg-surface border border-border rounded-lg px-4 py-3 flex items-center gap-3"
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium text-foreground">{c.name}</span>
                <span className="text-sm text-muted-foreground">
                  {c.code}
                  {c.symbol ? ` (${c.symbol})` : ''}
                </span>
              </div>
              {c.fullName && <p className="text-xs text-muted-foreground mt-0.5">{c.fullName}</p>}
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <input
                type="checkbox"
                checked={c.nbuFetchEnabled}
                readOnly
                className="h-4 w-4 rounded border-border accent-primary pointer-events-none"
              />
              <span className="text-xs text-muted-foreground whitespace-nowrap">НБУ</span>
            </div>
            <span className="text-xs text-muted-foreground shrink-0 w-14 text-right">
              {c.nbuMarkupPercent != null ? `+${c.nbuMarkupPercent}%` : '—'}
            </span>
            <div className="flex gap-2 shrink-0">
              <button
                aria-label="Редагувати валюту"
                onClick={() => openCurrencyModal(c)}
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                <Pencil className="w-4 h-4" />
              </button>
              <button
                aria-label="Видалити валюту"
                onClick={() => void deleteCurrency(c.id)}
                className="text-destructive/70 hover:text-destructive transition-colors"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          </div>
        ))}
      </div>

      <Modal
        open={currencyModal}
        onClose={() => setCurrencyModal(false)}
        title={editingCurrency ? 'Редагувати валюту' : 'Нова валюта'}
        footer={
          <>
            <Button variant="outline" onClick={() => setCurrencyModal(false)}>
              Скасувати
            </Button>
            <Button onClick={() => void saveCurrency()} loading={savingCurrency}>
              Зберегти
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Input
            label="Назва"
            required
            value={currencyForm.name}
            errorMessage={currencyErrors.name}
            onChange={e => {
              setCurrencyForm({ ...currencyForm, name: e.target.value });
              if (currencyErrors.name) setCurrencyErrors(p => ({ ...p, name: undefined }));
            }}
          />
          <Input
            label="Код (ISO 4217)"
            required
            value={currencyForm.code}
            errorMessage={currencyErrors.code}
            onChange={e => {
              setCurrencyForm({ ...currencyForm, code: e.target.value.toUpperCase() });
              if (currencyErrors.code) setCurrencyErrors(p => ({ ...p, code: undefined }));
            }}
            placeholder="UAH"
          />
          <Input
            label="Символ"
            value={currencyForm.symbol}
            onChange={e => setCurrencyForm({ ...currencyForm, symbol: e.target.value })}
            placeholder="₴"
          />
          <Input
            label="Повна назва"
            value={currencyForm.fullName}
            onChange={e => setCurrencyForm({ ...currencyForm, fullName: e.target.value })}
          />
          <div className="flex items-center justify-between pt-2 border-t border-border">
            <div>
              <p className="text-sm font-medium text-foreground">Завантажувати курс з НБУ</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Автоматично підтягувати офіційний курс щодня
              </p>
            </div>
            <input
              type="checkbox"
              checked={currencyForm.nbuFetchEnabled}
              onChange={e =>
                setCurrencyForm({ ...currencyForm, nbuFetchEnabled: e.target.checked })
              }
              className="h-4 w-4 rounded border-border accent-primary cursor-pointer"
            />
          </div>
          <Input
            label="Відсоток нарахування (%)"
            type="number"
            min={0}
            max={100}
            step={0.01}
            value={currencyForm.nbuMarkupPercent}
            onChange={e => setCurrencyForm({ ...currencyForm, nbuMarkupPercent: e.target.value })}
            placeholder="0.00"
            disabled={!currencyForm.nbuFetchEnabled}
          />
        </div>
      </Modal>

      <ConfirmDialog {...dialogProps} />
    </div>
  );
}
