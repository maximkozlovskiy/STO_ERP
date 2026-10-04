'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useForm, Controller } from 'react-hook-form';
import { i18nZodResolver } from '@/lib/i18nZodResolver';
import {
  supplierPaymentFormSchema,
  type SupplierPaymentFormInput,
  type SupplierPaymentFormValues,
} from '@sto/shared';
import { apiFetch } from '@/lib/api-client';
import { toast } from '@/lib/toast';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import { useDirtyForm } from '@/hooks/useDirtyForm';
import { DirtyConfirmDialog } from '@/components/ui/dirty-confirm-dialog';
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
import {
  useSupplierPayment,
  useUpdateSupplierPayment,
  useCreateSupplierPayment,
  type PaymentSourceType,
} from '@/hooks/api/useSupplierPayments';

/**
 * Оплата постачальнику (створення + редагування чернетки).
 *
 * `void` перед `handleSave()` / `handleModalClose()` у JSX: `handleSave` (RHF handleSubmit
 * над `onValid`) має try/catch, що пише текст відмови у `error` (баннер у модалці) і в
 * `toast.error`, плюс `finally`, який знімає savingRef/saving; у `handleModalClose` єдиний
 * `await` — `dirty.confirmClose()`, який ніколи не реджектиться. Відмова вже на екрані —
 * проміс обробника нікому не потрібен.
 */

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

/** Передзаповнення при створенні оплати з іншого документа (напр. PurchaseOrder). */
export interface SupplierPaymentPrefill {
  supplierId?: string;
  supplierName?: string;
  purchaseOrderId?: string;
  purchaseOrderNumber?: string;
  /** Сума-підказка (напр. залишок боргу по PO). Користувач може відкоригувати. */
  amount?: number;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  /** Якщо задано — режим редагування наявної DRAFT-оплати (PATCH). */
  paymentId?: string;
  /** Передзаповнення при створенні (ігнорується у режимі редагування). */
  prefill?: SupplierPaymentPrefill;
}

// «Чиста» база форми — reset() до неї на open дає rhfDirty=false (Bug #639: auto-select
// каси/банку виконується через setValue з shouldDirty:false, тому не вмикає dirty-guard).
const emptyDefaults = (): SupplierPaymentFormInput => ({
  supplierId: '',
  sourceType: 'CASH_REGISTER',
  bankAccountId: '',
  cashRegisterId: '',
  purchaseOrderId: '',
  amount: '',
  method: '',
  notes: '',
  documentDate: kyivToday(),
});

export function SupplierPaymentCreateModal({ open, onClose, onSaved, paymentId, prefill }: Props) {
  const { t } = useTranslation('supplierPayments');
  const features = useUiFeatures();
  const isEdit = !!paymentId;
  const dirty = useDirtyForm({ enabled: features.unsavedGuardEnabled });

  // react-hook-form + спільна zod-схема (єдине джерело валідації web ↔ api).
  const {
    control,
    register,
    reset,
    watch,
    setValue,
    handleSubmit,
    formState: { errors, isDirty: rhfDirty },
  } = useForm<SupplierPaymentFormInput, unknown, SupplierPaymentFormValues>({
    resolver: i18nZodResolver(supplierPaymentFormSchema),
    defaultValues: emptyDefaults(),
    mode: 'onBlur',
  });

  // Локальні (не-валідовані) поля відображення пікерів — display-текст постачальника/PO.
  const [supplierName, setSupplierName] = useState('');
  const [purchaseOrderNumber, setPurchaseOrderNumber] = useState('');

  const sourceType = watch('sourceType');
  const supplierId = watch('supplierId');

  const [saving, setSaving] = useState(false);
  // Синхронний re-entrancy guard: `disabled={saving}` спирається на re-render React
  // МІЖ подіями кліку — але два click-и, доставлені в ОДНОМУ tick (дуже швидкий
  // double-click / синтетичні події / Enter-repeat), обидва входять у submit до
  // того як disabled застосується → 2 POST /supplier-payments (2 оплати). createdIdRef
  // не рятує бо виставляється лише ПІСЛЯ await першого POST. Ref фліпається синхронно
  // на першому вході → другий вхід одразу повертається (WEB-H3 double-submit).
  const savingRef = useRef(false);
  const [error, setError] = useState('');

  const [banks, setBanks] = useState<BankAccount[]>([]);
  const [cashRegisters, setCashRegisters] = useState<CashRegister[]>([]);
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [supplierPickerOpen, setSupplierPickerOpen] = useState(false);
  const [poPickerOpen, setPoPickerOpen] = useState(false);
  const mountedRef = useRef(true);
  // Retry-safety: якщо create вже успішно створив оплату, але mutateAsync кинув
  // помилку ПІСЛЯ commit-у (обрив на відповіді), повторний клік «Створити» не
  // має створити ДРУГУ оплату. Зберігаємо id першого успіху та завершуємо форму.
  const createdIdRef = useRef<string | null>(null);
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

  const updateMut = useUpdateSupplierPayment();
  // Bug #594: створення через хук (а не raw apiFetch) щоб onSuccess у хуку
  // інвалідував supplierPaymentsKeys.all — інакше нова оплата не з'являється
  // у списку до staleTime=30s (usePaginatedList кешує на 30 секунд).
  const createMut = useCreateSupplierPayment();

  // Режим редагування — тягнемо наявну оплату для заповнення форми.
  const { data: existing } = useSupplierPayment(isEdit && open ? paymentId : null);
  const editNonDraft = isEdit && existing != null && existing.status !== 'DRAFT';

  // Заповнення форми з наявної оплати (edit) — раз на завантаження запису.
  const populatedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!open || !isEdit || !existing) return;
    if (populatedRef.current === existing.id) return;
    populatedRef.current = existing.id;
    // reset() ставить нову «чисту» базу з наявного запису → rhfDirty=false.
    reset({
      supplierId: existing.supplierId,
      sourceType: existing.sourceType,
      bankAccountId: existing.bankAccountId ?? '',
      cashRegisterId: existing.cashRegisterId ?? '',
      purchaseOrderId: existing.purchaseOrderId ?? '',
      amount: String(existing.amount),
      method: existing.method,
      notes: existing.notes ?? '',
      documentDate: existing.documentDate ?? kyivToday(),
    });
    setSupplierName(existing.supplierName ?? '');
    setPurchaseOrderNumber(existing.purchaseOrderNumber ?? '');
    // джерело вже обрано з запису — не даємо auto-select перезаписати
    autoSelectedRef.current = { cash: true, bank: true };
  }, [open, isEdit, existing, reset]);

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
  // shouldDirty:false — авто-вибір не вмикає dirty-guard (Bug #639). Не читає
  // cash/bankAccountId у deps, щоб не перевибирати щойно очищене користувачем поле.
  useEffect(() => {
    if (
      sourceType === 'CASH_REGISTER' &&
      cashRegisters.length === 1 &&
      !autoSelectedRef.current.cash
    ) {
      autoSelectedRef.current.cash = true;
      setValue('cashRegisterId', cashRegisters[0].id, { shouldDirty: false });
    }
    if (sourceType === 'BANK_ACCOUNT' && banks.length === 1 && !autoSelectedRef.current.bank) {
      autoSelectedRef.current.bank = true;
      setValue('bankAccountId', banks[0].id, { shouldDirty: false });
    }
  }, [sourceType, cashRegisters, banks, setValue]);

  useEffect(() => {
    if (methods.length > 0 && !watch('method')) {
      setValue('method', methods[0].code, { shouldDirty: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [methods]);

  // Reset on open/close — чиста база + скидання refs + (для create) prefill.
  // ВАЖЛИВО: reset() і prefill в ОДНОМУ ефекті, у порядку reset→prefill — інакше
  // окремий пізніший reset-ефект затирає щойно передзаповнений supplierId (кнопка
  // «Створити» лишалась би disabled бо supplierId порожній).
  useEffect(() => {
    if (open) {
      dirty.resetDirty();
      setError('');
      autoSelectedRef.current = { cash: false, bank: false };
      createdIdRef.current = null;
      savingRef.current = false;
      if (!isEdit) {
        // reset() ставить чисту базу → rhfDirty=false; далі накладаємо prefill.
        reset(emptyDefaults());
        setSupplierName('');
        setPurchaseOrderNumber('');
        // Передзаповнення при створенні з іншого документа (напр. PurchaseOrder).
        if (prefill) {
          if (prefill.supplierId) setValue('supplierId', prefill.supplierId);
          if (prefill.supplierName) setSupplierName(prefill.supplierName);
          if (prefill.purchaseOrderId) setValue('purchaseOrderId', prefill.purchaseOrderId);
          if (prefill.purchaseOrderNumber) setPurchaseOrderNumber(prefill.purchaseOrderNumber);
          if (prefill.amount != null && prefill.amount > 0)
            setValue('amount', String(prefill.amount));
        }
      }
    } else {
      // Повне очищення при закритті (edit populate спрацює наново при наступному open).
      populatedRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, paymentId]);

  // Міст RHF isDirty → useDirtyForm (DirtyConfirmDialog + beforeunload збережено).
  useEffect(() => {
    if (rhfDirty) dirty.markDirty();
    else dirty.resetDirty();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rhfDirty]);

  const onValid = useCallback(
    async (values: SupplierPaymentFormValues) => {
      // WEB-H3: синхронний guard проти concurrent double-submit (див. savingRef).
      if (savingRef.current) return;
      savingRef.current = true;
      setSaving(true);
      setError('');
      const payload = {
        supplierId: values.supplierId,
        sourceType: values.sourceType,
        bankAccountId: values.sourceType === 'BANK_ACCOUNT' ? values.bankAccountId : undefined,
        cashRegisterId: values.sourceType === 'CASH_REGISTER' ? values.cashRegisterId : undefined,
        purchaseOrderId: values.purchaseOrderId || undefined,
        amount: values.amount,
        method: values.method,
        notes: values.notes || undefined,
        documentDate: values.documentDate,
      };
      try {
        if (isEdit) {
          await updateMut.mutateAsync({ id: paymentId, data: payload });
          if (features.toastEnabled) toast.success(t('toast.paymentUpdated'));
        } else if (createdIdRef.current) {
          // Оплату вже створено на попередній спробі (retry після обриву на
          // відповіді) — не створюємо дубль, лише завершуємо форму.
          if (features.toastEnabled) toast.success(t('toast.paymentCreated'));
        } else {
          // Bug #594: через хук — щоб onSuccess інвалідував supplierPaymentsKeys.all.
          const created = await createMut.mutateAsync(payload);
          createdIdRef.current = created.id;
          if (features.toastEnabled) toast.success(t('toast.paymentCreated'));
        }
        dirty.resetDirty();
        onSaved();
        onClose();
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Помилка збереження';
        setError(msg);
        if (features.toastEnabled) toast.error(msg);
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    },
    [isEdit, paymentId, updateMut, createMut, features.toastEnabled, onSaved, onClose, dirty, t],
  );

  const handleSave = handleSubmit(onValid);

  const handleModalClose = useCallback(async () => {
    if (savingRef.current) return;
    if (!(await dirty.confirmClose())) return;
    onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose]);

  return (
    <>
      <Modal
        open={open}
        onClose={() => void handleModalClose()}
        onSubmit={() => void handleSave()}
        title={isEdit ? 'Редагувати оплату' : 'Нова оплата постачальнику'}
        size="lg"
        footer={
          <div className="flex gap-2 items-center justify-end w-full">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleModalClose()}
              disabled={saving}
            >
              Закрити
            </Button>
            <Button
              onClick={() => void handleSave()}
              loading={saving}
              disabled={saving || !supplierId || editNonDraft}
              size="sm"
            >
              {isEdit ? 'Зберегти' : 'Створити оплату'}
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          {editNonDraft && (
            <div className="text-[13px] text-warning bg-warning-subtle border border-warning/30 rounded-lg px-3 py-2">
              Редагування дозволено лише у статусі «Чернетка». Ця оплата вже проведена або
              скасована.
            </div>
          )}
          {error && (
            <div className="text-[13px] text-destructive bg-destructive-subtle border border-destructive/30 rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          {/* Постачальник */}
          <div>
            <EntityPickerField
              label="Постачальник"
              required
              display={supplierName}
              placeholder="Пошук постачальника…"
              className="h-8 text-[13px]"
              onPick={() => setSupplierPickerOpen(true)}
              onClear={() => {
                setValue('supplierId', '', { shouldDirty: true });
                setSupplierName('');
                // Прив'язка до PO належить конкретному постачальнику; при очищенні
                // постачальника треба скинути обидва поля пари, інакше залишається
                // orphan purchaseOrderId який не пройде backend-валідацію (PO не
                // належатиме "новому" вибраному постачальнику) — §8.2 paired FK state.
                setValue('purchaseOrderId', '', { shouldDirty: true });
                setPurchaseOrderNumber('');
              }}
            />
            {errors.supplierId && (
              <p className="text-[12px] text-destructive leading-tight mt-1">
                {errors.supplierId.message}
              </p>
            )}
          </div>

          {/* Джерело коштів */}
          <div className="grid grid-cols-2 gap-4">
            <Controller
              control={control}
              name="sourceType"
              render={({ field }) => (
                <Select
                  label="Джерело коштів"
                  required
                  value={field.value}
                  onChange={e => {
                    field.onChange(e.target.value);
                    // зміна джерела скидає обидва рахунки — щоб не лишити orphan FK
                    // невідповідного типу (backend guard відхилить, superRefine також).
                    setValue('bankAccountId', '', { shouldDirty: true });
                    setValue('cashRegisterId', '', { shouldDirty: true });
                  }}
                  className="h-8 text-[13px]"
                >
                  <option value="CASH_REGISTER">Каса</option>
                  <option value="BANK_ACCOUNT">Банківський рахунок</option>
                </Select>
              )}
            />

            {sourceType === 'CASH_REGISTER' ? (
              <Controller
                control={control}
                name="cashRegisterId"
                render={({ field }) => (
                  <Select
                    label="Каса"
                    required
                    value={typeof field.value === 'string' ? field.value : ''}
                    onChange={field.onChange}
                    errorMessage={errors.cashRegisterId?.message}
                    className="h-8 text-[13px]"
                  >
                    <option value="">— Оберіть —</option>
                    {cashRegisters.map(c => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </Select>
                )}
              />
            ) : (
              <Controller
                control={control}
                name="bankAccountId"
                render={({ field }) => (
                  <Select
                    label="Банківський рахунок"
                    required
                    value={typeof field.value === 'string' ? field.value : ''}
                    onChange={field.onChange}
                    errorMessage={errors.bankAccountId?.message}
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
              />
            )}
          </div>

          {/* Сума | Метод оплати */}
          <div className="grid grid-cols-2 gap-4">
            <Input
              label="Сума, ₴"
              type="text"
              inputMode="decimal"
              {...register('amount')}
              placeholder="0.00"
              errorMessage={errors.amount?.message}
              className="h-8 text-[13px] tabular-nums"
            />
            <Controller
              control={control}
              name="method"
              render={({ field }) => (
                <Select
                  label="Метод оплати"
                  required
                  value={field.value ?? ''}
                  onChange={field.onChange}
                  errorMessage={errors.method?.message}
                  className="h-8 text-[13px]"
                >
                  {methods.length === 0 && <option value="">—</option>}
                  {methods.map(m => (
                    <option key={m.code} value={m.code}>
                      {m.name}
                    </option>
                  ))}
                </Select>
              )}
            />
          </div>

          {/* Замовлення постачальнику (опціонально) | Дата */}
          <div className="grid grid-cols-2 gap-4">
            <EntityPickerField
              label="Замовлення (опціонально)"
              display={purchaseOrderNumber}
              placeholder="Прив’язати замовлення…"
              className="h-8 text-[13px]"
              disabled={!supplierId}
              onPick={() => setPoPickerOpen(true)}
              onClear={() => {
                setValue('purchaseOrderId', '', { shouldDirty: true });
                setPurchaseOrderNumber('');
              }}
            />
            <div>
              <label className="block text-[13px] font-medium text-foreground mb-1">
                Дата документа
              </label>
              <Controller
                control={control}
                name="documentDate"
                render={({ field }) => (
                  <DatePickerInput
                    value={typeof field.value === 'string' ? field.value : ''}
                    onChange={field.onChange}
                  />
                )}
              />
            </div>
          </div>

          {/* Опис */}
          <Input
            label="Опис"
            {...register('notes')}
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
          setValue('supplierId', item.id, { shouldDirty: true });
          setSupplierName(item.primary);
          // зміна постачальника скидає прив'язку до PO (PO належить конкретному постачальнику)
          setValue('purchaseOrderId', '', { shouldDirty: true });
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
          setValue('purchaseOrderId', item.id, { shouldDirty: true });
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

      <DirtyConfirmDialog {...dirty.dialogProps} />
    </>
  );
}
