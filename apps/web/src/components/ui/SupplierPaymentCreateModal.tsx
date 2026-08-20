'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import { toast } from '@/lib/toast';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import { getCached, setCache } from '@/lib/ref-cache';
import { displayCounterpartyName } from '@/lib/utils';
import { kyivToday } from '@/lib/format';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { DatePickerInput } from '@/components/ui/date-picker-input';
import { EntityPickerField } from '@/components/ui/entity-picker-field';
import { SearchPickerModal } from '@/components/ui/search-picker-modal';
import type { PaymentSourceType } from '@/hooks/api/useSupplierPayments';

interface Supplier {
  id: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
}

interface BankAccount {
  id: string;
  name: string;
}

interface CashRegister {
  id: string;
  name: string;
}

interface PaymentMethod {
  code: string;
  name: string;
  isActive: boolean;
}

interface PurchaseOrderRef {
  id: string;
  number: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}

export function SupplierPaymentCreateModal({ open, onClose, onSaved }: Props) {
  const features = useUiFeatures();

  const [supplierId, setSupplierId] = useState('');
  const [supplierName, setSupplierName] = useState('');
  const [sourceType, setSourceType] = useState<PaymentSourceType>('CASH_REGISTER');
  const [bankAccountId, setBankAccountId] = useState('');
  const [cashRegisterId, setCashRegisterId] = useState('');
  const [purchaseOrderId, setPurchaseOrderId] = useState('');
  const [purchaseOrderNumber, setPurchaseOrderNumber] = useState('');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('');
  const [notes, setNotes] = useState('');
  const [documentDate, setDocumentDate] = useState(() => kyivToday());

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const [banks, setBanks] = useState<BankAccount[]>([]);
  const [cashRegisters, setCashRegisters] = useState<CashRegister[]>([]);
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [supplierPickerOpen, setSupplierPickerOpen] = useState(false);
  const [poPickerOpen, setPoPickerOpen] = useState(false);
  const mountedRef = useRef(true);
  // Auto-select single source має спрацювати РАЗ на джерело (коли завантажився
  // список), а не після кожного рендера — інакше повторно вибирає щойно очищене
  // користувачем поле «— Оберіть —» і його неможливо лишити порожнім.
  const autoSelectedRef = useRef<{ cash: boolean; bank: boolean }>({ cash: false, bank: false });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // ── Reference data ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    // Кеш зберігається у формі { items } — та сама що у /ndi BankAccountsTab/
    // CashRegistersTab. Читати ЛИШЕ через Array.isArray guard: чужа/стара форма
    // (голий масив або items=undefined) інакше потрапить у banks.map → crash (Bug #592).
    const cachedBanks = getCached<{ items: BankAccount[] }>('cache:bank-accounts');
    if (cachedBanks && Array.isArray(cachedBanks.items)) setBanks(cachedBanks.items);
    const cachedCash = getCached<{ items: CashRegister[] }>('cache:cash-registers');
    if (cachedCash && Array.isArray(cachedCash.items)) setCashRegisters(cachedCash.items);

    apiFetch<{ items: BankAccount[] }>('/bank-accounts')
      .then(res => {
        if (!mountedRef.current) return;
        setCache('cache:bank-accounts', res);
        setBanks(res.items);
      })
      .catch(() => {});
    apiFetch<{ items: CashRegister[] }>('/cash-registers')
      .then(res => {
        if (!mountedRef.current) return;
        setCache('cache:cash-registers', res);
        setCashRegisters(res.items);
      })
      .catch(() => {});
    apiFetch<PaymentMethod[]>('/payment-methods')
      .then(data => {
        if (!mountedRef.current) return;
        setMethods(data.filter(m => m.isActive));
      })
      .catch(() => {});
  }, [open]);

  // Auto-select single source — раз на джерело коли список прибув.
  // Не читає cashRegisterId/bankAccountId у deps, щоб не перевибирати
  // щойно очищене користувачем поле.
  useEffect(() => {
    if (
      sourceType === 'CASH_REGISTER' &&
      cashRegisters.length === 1 &&
      !autoSelectedRef.current.cash
    ) {
      autoSelectedRef.current.cash = true;
      setCashRegisterId(cashRegisters[0].id);
    }
    if (sourceType === 'BANK_ACCOUNT' && banks.length === 1 && !autoSelectedRef.current.bank) {
      autoSelectedRef.current.bank = true;
      setBankAccountId(banks[0].id);
    }
  }, [sourceType, cashRegisters, banks]);

  useEffect(() => {
    if (methods.length > 0 && !method) setMethod(methods[0].code);
  }, [methods, method]);

  const resetForm = useCallback(() => {
    setSupplierId('');
    setSupplierName('');
    setSourceType('CASH_REGISTER');
    setBankAccountId('');
    setCashRegisterId('');
    setPurchaseOrderId('');
    setPurchaseOrderNumber('');
    setAmount('');
    setMethod('');
    setNotes('');
    setDocumentDate(kyivToday());
    setError('');
    autoSelectedRef.current = { cash: false, bank: false };
  }, []);

  useEffect(() => {
    if (!open) resetForm();
  }, [open, resetForm]);

  const handleSave = useCallback(async () => {
    if (!supplierId) {
      setError('Оберіть постачальника');
      return;
    }
    if (sourceType === 'BANK_ACCOUNT' && !bankAccountId) {
      setError('Оберіть банківський рахунок');
      return;
    }
    if (sourceType === 'CASH_REGISTER' && !cashRegisterId) {
      setError('Оберіть касу');
      return;
    }
    // UA-locale: користувач може ввести кому як десятковий роздільник.
    const amt = parseFloat(amount.replace(',', '.'));
    if (!Number.isFinite(amt) || amt <= 0) {
      setError('Сума має бути більшою за нуль');
      return;
    }
    if (!method) {
      setError('Оберіть метод оплати');
      return;
    }
    setError('');
    setSaving(true);
    try {
      await apiFetch('/supplier-payments', {
        method: 'POST',
        body: JSON.stringify({
          supplierId,
          sourceType,
          bankAccountId: sourceType === 'BANK_ACCOUNT' ? bankAccountId : undefined,
          cashRegisterId: sourceType === 'CASH_REGISTER' ? cashRegisterId : undefined,
          purchaseOrderId: purchaseOrderId || undefined,
          amount: amt,
          method,
          notes: notes || undefined,
          documentDate,
        }),
      });
      if (features.toastEnabled) toast.success('Оплату створено');
      onSaved();
      onClose();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Помилка збереження';
      setError(msg);
      if (features.toastEnabled) toast.error(msg);
    } finally {
      setSaving(false);
    }
  }, [
    supplierId,
    sourceType,
    bankAccountId,
    cashRegisterId,
    purchaseOrderId,
    amount,
    method,
    notes,
    documentDate,
    features.toastEnabled,
    onSaved,
    onClose,
  ]);

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        title="Нова оплата постачальнику"
        size="lg"
        footer={
          <div className="flex gap-2 items-center justify-end w-full">
            <Button variant="outline" size="sm" onClick={onClose} disabled={saving}>
              Закрити
            </Button>
            <Button
              onClick={handleSave}
              loading={saving}
              disabled={saving || !supplierId}
              size="sm"
            >
              Створити оплату
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          {error && (
            <div className="text-[13px] text-destructive bg-destructive-subtle border border-destructive/30 rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          {/* Постачальник */}
          <div>
            <label className="block text-[13px] font-medium text-foreground mb-1">
              Постачальник <span className="text-destructive">*</span>
            </label>
            <EntityPickerField
              display={supplierName}
              placeholder="Пошук постачальника…"
              className="h-8 text-[13px]"
              onPick={() => setSupplierPickerOpen(true)}
              onClear={() => {
                setSupplierId('');
                setSupplierName('');
                // Прив'язка до PO належить конкретному постачальнику; при очищенні
                // постачальника треба скинути обидва поля пари, інакше залишається
                // orphan purchaseOrderId який не пройде backend-валідацію (PO не
                // належатиме "новому" вибраному постачальнику) — §8.2 paired FK state.
                setPurchaseOrderId('');
                setPurchaseOrderNumber('');
              }}
            />
          </div>

          {/* Джерело коштів */}
          <div className="grid grid-cols-2 gap-4">
            <Select
              label="Джерело коштів"
              required
              value={sourceType}
              onChange={e => {
                setSourceType(e.target.value as PaymentSourceType);
                setBankAccountId('');
                setCashRegisterId('');
              }}
              className="h-8 text-[13px]"
            >
              <option value="CASH_REGISTER">Каса</option>
              <option value="BANK_ACCOUNT">Банківський рахунок</option>
            </Select>

            {sourceType === 'CASH_REGISTER' ? (
              <Select
                label="Каса"
                required
                value={cashRegisterId}
                onChange={e => setCashRegisterId(e.target.value)}
                className="h-8 text-[13px]"
              >
                <option value="">— Оберіть —</option>
                {cashRegisters.map(c => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            ) : (
              <Select
                label="Банківський рахунок"
                required
                value={bankAccountId}
                onChange={e => setBankAccountId(e.target.value)}
                className="h-8 text-[13px]"
              >
                <option value="">— Оберіть —</option>
                {banks.map(b => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </Select>
            )}
          </div>

          {/* Сума | Метод оплати */}
          <div className="grid grid-cols-2 gap-4">
            <Input
              label="Сума, ₴"
              type="text"
              inputMode="decimal"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              placeholder="0.00"
              className="h-8 text-[13px] tabular-nums"
            />
            <Select
              label="Метод оплати"
              required
              value={method}
              onChange={e => setMethod(e.target.value)}
              className="h-8 text-[13px]"
            >
              {methods.length === 0 && <option value="">—</option>}
              {methods.map(m => (
                <option key={m.code} value={m.code}>
                  {m.name}
                </option>
              ))}
            </Select>
          </div>

          {/* Замовлення постачальнику (опціонально) | Дата */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-[13px] font-medium text-foreground mb-1">
                Замовлення (опціонально)
              </label>
              <EntityPickerField
                display={purchaseOrderNumber}
                placeholder="Прив’язати замовлення…"
                className="h-8 text-[13px]"
                disabled={!supplierId}
                onPick={() => setPoPickerOpen(true)}
                onClear={() => {
                  setPurchaseOrderId('');
                  setPurchaseOrderNumber('');
                }}
              />
            </div>
            <div>
              <label className="block text-[13px] font-medium text-foreground mb-1">
                Дата документа
              </label>
              <DatePickerInput value={documentDate} onChange={setDocumentDate} />
            </div>
          </div>

          {/* Опис */}
          <Input
            label="Опис"
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="Додаткова інформація…"
            className="h-8 text-[13px]"
          />
        </div>
      </Modal>

      {/* Supplier picker */}
      <SearchPickerModal
        open={supplierPickerOpen}
        onClose={() => setSupplierPickerOpen(false)}
        onSelect={(item: { id: string; primary: string }) => {
          setSupplierId(item.id);
          setSupplierName(item.primary);
          // зміна постачальника скидає прив'язку до PO (PO належить конкретному постачальнику)
          setPurchaseOrderId('');
          setPurchaseOrderNumber('');
          setSupplierPickerOpen(false);
        }}
        title="Оберіть постачальника"
        fetchItems={q =>
          apiFetch<{ items: Supplier[] }>(
            `/counterparties?q=${encodeURIComponent(q)}&types=SUPPLIER&types=BOTH&limit=30`,
          ).then(d => d.items.map(c => ({ id: c.id, primary: displayCounterpartyName(c) })))
        }
      />

      {/* Purchase order picker (filtered by supplier) */}
      <SearchPickerModal
        open={poPickerOpen}
        onClose={() => setPoPickerOpen(false)}
        onSelect={(item: { id: string; primary: string }) => {
          setPurchaseOrderId(item.id);
          setPurchaseOrderNumber(item.primary);
          setPoPickerOpen(false);
        }}
        title="Оберіть замовлення постачальнику"
        fetchItems={q =>
          apiFetch<{ items: PurchaseOrderRef[] }>(
            `/purchase-orders?q=${encodeURIComponent(q)}&supplierId=${supplierId}&limit=30`,
          ).then(d => d.items.map(po => ({ id: po.id, primary: po.number })))
        }
      />
    </>
  );
}
