'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import { useBaseCurrency } from '@/hooks/api/useCash';
import { Select } from '@/components/ui/select';

/**
 * Мультивалюта (Фаза 3): спільний вибір валюти документа (Invoice/WorkOrder/PurchaseOrder).
 * Дзеркалить inline-патерн НДІ→BankAccountsTab (fetch /currencies + Select), але єдиним компонентом
 * — щоб не дублювати у 3 модалках. `defaultToBase` авто-обирає базову валюту org, коли value порожнє.
 */
interface CurrencyItem {
  id: string;
  code: string;
  name: string;
  symbol?: string | null;
}

interface CurrencySelectProps {
  value: string;
  onChange: (currencyId: string) => void;
  label?: string;
  errorMessage?: string;
  required?: boolean;
  disabled?: boolean;
  /** Якщо value порожнє — авто-обрати базову валюту org (за замовчуванням true). */
  defaultToBase?: boolean;
}

export function CurrencySelect({
  value,
  onChange,
  label = 'Валюта',
  errorMessage,
  required,
  disabled,
  defaultToBase = true,
}: CurrencySelectProps) {
  const [currencies, setCurrencies] = useState<CurrencyItem[]>([]);
  const { data: base } = useBaseCurrency();

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ items: CurrencyItem[] }>('/currencies')
      .then(r => {
        if (!cancelled) setCurrencies(r.items ?? []);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // Авто-вибір базової валюти, коли нічого не обрано (лише один раз, коли з'явились дані).
  useEffect(() => {
    if (!defaultToBase || value || currencies.length === 0 || !base?.code) return;
    const baseCur = currencies.find(c => c.code === base.code);
    if (baseCur) onChange(baseCur.id);
  }, [defaultToBase, value, currencies, base?.code, onChange]);

  return (
    <Select
      label={label}
      value={value}
      required={required}
      disabled={disabled}
      errorMessage={errorMessage}
      placeholder="Оберіть валюту…"
      onChange={e => onChange(e.target.value)}
    >
      {currencies.map(c => (
        <option key={c.id} value={c.id}>
          {c.code} — {c.name}
        </option>
      ))}
    </Select>
  );
}
