'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useForm, Controller } from 'react-hook-form';
import {
  CASH_REASON_RULES,
  cashOperationSchema,
  manualCashReasons,
  type CashDirectionValue,
  type CashOperationFormInput,
  type CashOperationFormValues,
  type CashReasonValue,
} from '@sto/shared';
import { apiFetch } from '@/lib/api-client';
import { i18nZodResolver } from '@/lib/i18nZodResolver';
import { toast } from '@/lib/toast';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import { useDirtyForm } from '@/hooks/useDirtyForm';
import { DirtyConfirmDialog } from '@/components/ui/dirty-confirm-dialog';
import { displayCounterpartyName } from '@/lib/utils';
import { poStatusLabel, woStatusLabel } from '@/i18n/enumLabel';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { EntityPickerField } from '@/components/ui/entity-picker-field';
import { SearchPickerModal, type SearchPickerItem } from '@/components/ui/search-picker-modal';
import { useCreateCashOperation, type CashRegister } from '@/hooks/api/useCash';
import { useExpenseCategories, flattenActiveByType } from '@/hooks/api/useExpenseCategories';
import { newIdempotencyKey } from '@/lib/idempotency-key';

interface Props {
  open: boolean;
  onClose: () => void;
  direction: CashDirectionValue;
  register: CashRegister | null;
  /** Обмеження приводів за роллю (приймальня). Не задано — усі ручні приводи напряму. */
  allowedReasons?: readonly CashReasonValue[];
  /**
   * Чи доступний довідник статей: GET /expense-categories вимагає бухгалтера й вище. Приймальня
   * статті не бачить і не обирає — її підставляє сервер за приводом.
   */
  categoriesEnabled: boolean;
}

interface CounterpartyRow {
  id: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
}
interface EmployeeRow {
  id: string;
  firstName: string;
  lastName: string;
}
interface DocumentRow {
  id: string;
  number: string;
  status: string;
}

type Picker = 'counterparty' | 'employee' | 'baseDocument' | null;

const asText = (v: unknown): string => (typeof v === 'string' ? v : '');

const emptyDefaults = (
  direction: CashDirectionValue,
  reason: CashReasonValue,
): CashOperationFormInput => ({
  direction,
  reason,
  amount: '',
  expenseCategoryId: '',
  counterpartyId: '',
  employeeId: '',
  baseDocumentType: '',
  baseDocumentId: '',
  notes: '',
});

/** Привід, з якого картка стартує: загальне внесення / видача, якщо роль його має. */
function initialReason(
  direction: CashDirectionValue,
  reasons: readonly CashReasonValue[],
): CashReasonValue {
  const generic: CashReasonValue = direction === 'IN' ? 'MANUAL_IN' : 'MANUAL_OUT';
  return reasons.includes(generic) ? generic : (reasons[0] ?? generic);
}

const FIELD_ERROR = 'text-[12px] text-destructive leading-tight mt-1';

/**
 * Картка ручної касової операції (BR-CASH-016…022).
 *
 * Які поля показати й які з них обов'язкові, каже `CASH_REASON_RULES[привід]` — та сама таблиця,
 * за якою перевіряє сервер. Валідація — спільна `cashOperationSchema`.
 *
 * `void` перед `submit()` у JSX: `onValid` має try/catch, що пише відмову сервера в банер
 * картки, і `finally`, який знімає guard. Відмова вже на екрані — проміс нікому не потрібен.
 * `void` перед `close()`: єдиний `await` там — `dirty.confirmClose()`, який не реджектиться.
 */
export function CashOperationModal({
  open,
  onClose,
  direction,
  register: cashRegister,
  allowedReasons,
  categoriesEnabled,
}: Props) {
  const { t } = useTranslation('cash');
  const features = useUiFeatures();
  // Закриття картки з уведеним питає підтвердження — як в інших картках документів (Bug #853).
  const dirty = useDirtyForm({ enabled: features.unsavedGuardEnabled });
  const createOp = useCreateCashOperation();
  const { data: categoryTree } = useExpenseCategories(false, categoriesEnabled);

  const reasons = useMemo(
    () => manualCashReasons(direction).filter(r => !allowedReasons || allowedReasons.includes(r)),
    [direction, allowedReasons],
  );
  // Статті напряму: внесення → оприбуткування, видача → витрати.
  const categoryOptions = useMemo(
    () => flattenActiveByType(categoryTree, direction === 'IN' ? 'INCOME' : 'EXPENSE'),
    [categoryTree, direction],
  );

  const {
    control,
    register,
    reset,
    watch,
    setValue,
    getValues,
    clearErrors,
    handleSubmit,
    formState: { errors },
  } = useForm<CashOperationFormInput, unknown, CashOperationFormValues>({
    resolver: i18nZodResolver(cashOperationSchema),
    defaultValues: emptyDefaults(direction, initialReason(direction, reasons)),
  });

  // Тексти пікерів — поза схемою: сервер приймає лише id.
  const [counterpartyName, setCounterpartyName] = useState('');
  const [employeeName, setEmployeeName] = useState('');
  const [baseDocumentNumber, setBaseDocumentNumber] = useState('');
  const [picker, setPicker] = useState<Picker>(null);
  const openPicker = (next: Exclude<Picker, null>) => setPicker(next);
  const closePicker = useCallback(() => setPicker(null), []);
  const [error, setError] = useState('');

  // Один ключ на відкриття картки: повтор після обриву на відповіді не створить другу оплату.
  const idempotencyKeyRef = useRef('');
  // Синхронний guard від подвійного кліку в одному tick-у (disabled ще не застосувався).
  const savingRef = useRef(false);
  // true — статтю підставлено за приводом (а не обрано людиною): її можна замінити при зміні приводу.
  const categoryAutoRef = useRef(false);

  const reason = watch('reason');
  const counterpartyId = asText(watch('counterpartyId'));
  const rule = CASH_REASON_RULES[reason];

  /** Підставляє статтю приводу, якщо поточну не обирала людина. */
  const applyDefaultCategory = (nextReason: CashReasonValue) => {
    if (asText(getValues('expenseCategoryId')) && !categoryAutoRef.current) return;
    const match = categoryOptions.find(c => c.defaultReason === nextReason);
    setValue('expenseCategoryId', match?.id ?? '');
    categoryAutoRef.current = !!match;
  };

  const clearBaseDocument = () => {
    setValue('baseDocumentType', '');
    setValue('baseDocumentId', '');
    setBaseDocumentNumber('');
  };
  // Підстава належить контрагентові: без нього (або з іншим) вона стає чужим документом.
  const clearCounterparty = () => {
    setValue('counterpartyId', '');
    setCounterpartyName('');
    clearBaseDocument();
  };
  const clearEmployee = () => {
    setValue('employeeId', '');
    setEmployeeName('');
  };

  useEffect(() => {
    if (!open) return;
    reset(emptyDefaults(direction, initialReason(direction, reasons)));
    setCounterpartyName('');
    setEmployeeName('');
    setBaseDocumentNumber('');
    setPicker(null);
    setError('');
    idempotencyKeyRef.current = newIdempotencyKey();
    savingRef.current = false;
    categoryAutoRef.current = false;
    dirty.resetDirty();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, direction]);

  // Стаття приводу, з якого картка стартує. Довідник статей може прийти вже після відкриття —
  // тому окремий ефект від `categoryOptions`, а не рядок у reset вище.
  useEffect(() => {
    if (!open) return;
    applyDefaultCategory(getValues('reason'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, direction, categoryOptions]);

  const onReasonChange = (next: CashReasonValue) => {
    const prevRule = CASH_REASON_RULES[getValues('reason')];
    const nextRule = CASH_REASON_RULES[next];
    setValue('reason', next);
    // Поля, яких новий привід не має, очищаємо: інакше в запит пішов би контрагент чи
    // працівник попереднього приводу. Клієнт і постачальник — різні ролі, тож теж очищення.
    if (nextRule.counterparty !== prevRule.counterparty) clearCounterparty();
    if (!nextRule.employee) clearEmployee();
    applyDefaultCategory(next);
    clearErrors();
  };

  const onValid = async (values: CashOperationFormValues) => {
    if (savingRef.current || !cashRegister) return;
    savingRef.current = true;
    setError('');
    try {
      await createOp.mutateAsync({
        cashRegisterId: cashRegister.id,
        idempotencyKey: idempotencyKeyRef.current,
        ...values,
      });
      toast.success(direction === 'IN' ? t('operations.deposited') : t('operations.withdrawn'));
      onClose();
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : t('operations.opError'));
    } finally {
      savingRef.current = false;
    }
  };

  const submit = handleSubmit(onValid);
  /**
   * Чи є в картці щось, уведене людиною. Привід і стаття не рахуються: привід завжди обраний,
   * статтю підставляє сам привід — порожня картка з іншим приводом закривається без запиту.
   */
  const hasInput = () => {
    const v = getValues();
    return [v.amount, v.counterpartyId, v.employeeId, v.baseDocumentId, v.notes].some(
      x => asText(x).trim() !== '',
    );
  };
  const close = async () => {
    if (createOp.isPending) return;
    if (hasInput()) dirty.markDirty();
    else dirty.resetDirty();
    if (!(await dirty.confirmClose())) return;
    onClose();
  };

  const isClient = rule.counterparty === 'client';
  const currency = cashRegister?.currencySymbol ?? cashRegister?.currencyCode ?? '';
  const categoryLabel = rule.categoryRequired
    ? t('operations.fieldCategoryExpense')
    : direction === 'IN'
      ? t('operations.fieldCategoryIncomeOptional')
      : t('operations.fieldCategoryExpenseOptional');

  // useCallback: пікер перечитує список щоразу, коли змінюється сама функція запиту.
  const fetchCounterparties = useCallback(
    (q: string): Promise<SearchPickerItem[]> =>
      apiFetch<{ items: CounterpartyRow[] }>(
        `/counterparties?q=${encodeURIComponent(q)}&types=${isClient ? 'CLIENT' : 'SUPPLIER'}&types=BOTH&limit=30`,
      ).then(d => d.items.map(c => ({ id: c.id, primary: displayCounterpartyName(c) }))),
    [isClient],
  );

  const fetchEmployees = useCallback(
    (q: string): Promise<SearchPickerItem[]> =>
      apiFetch<{ items: EmployeeRow[] }>(`/employees?q=${encodeURIComponent(q)}&limit=30`).then(d =>
        d.items.map(e => ({ id: e.id, primary: `${e.lastName} ${e.firstName}`.trim() })),
      ),
    [],
  );

  // Лише документи обраного контрагента: наряди клієнта або замовлення постачальника.
  const baseDocument = rule.baseDocument;
  const fetchBaseDocuments = useCallback(
    (q: string): Promise<SearchPickerItem[]> =>
      baseDocument === 'WorkOrder'
        ? apiFetch<{ items: DocumentRow[] }>(
            `/work-orders?q=${encodeURIComponent(q)}&counterpartyId=${counterpartyId}&limit=30`,
          ).then(d =>
            d.items.map(w => ({ id: w.id, primary: w.number, secondary: woStatusLabel(w.status) })),
          )
        : apiFetch<{ items: DocumentRow[] }>(
            `/purchase-orders?q=${encodeURIComponent(q)}&supplierId=${counterpartyId}&limit=30`,
          ).then(d =>
            d.items.map(p => ({ id: p.id, primary: p.number, secondary: poStatusLabel(p.status) })),
          ),
    [baseDocument, counterpartyId],
  );

  return (
    <>
      <Modal
        open={open}
        onClose={() => void close()}
        onSubmit={() => void submit()}
        title={direction === 'IN' ? t('operations.modalTitleIn') : t('operations.modalTitleOut')}
        footer={
          <Button
            onClick={() => void submit()}
            loading={createOp.isPending}
            disabled={createOp.isPending}
            className="w-full"
          >
            {direction === 'IN' ? t('operations.deposit') : t('operations.withdraw')}
          </Button>
        }
      >
        {error && (
          <div
            role="alert"
            className="mb-4 text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-3 py-2"
          >
            {error}
          </div>
        )}
        <div className="space-y-4">
          <Input
            label={
              currency ? `${t('operations.fieldAmount')}, ${currency}` : t('operations.fieldAmount')
            }
            required
            type="text"
            inputMode="decimal"
            {...register('amount')}
            placeholder="0,00"
            autoFocus
            errorMessage={errors.amount?.message}
            className="h-8 text-[13px] tabular-nums"
          />

          <Controller
            control={control}
            name="reason"
            render={({ field }) => (
              <Select
                label={t('operations.fieldReason')}
                required
                value={field.value}
                onChange={e => onReasonChange(e.target.value as CashReasonValue)}
                errorMessage={errors.reason?.message}
              >
                {reasons.map(r => (
                  <option key={r} value={r}>
                    {t(`reasons.${r}`, { defaultValue: r })}
                  </option>
                ))}
              </Select>
            )}
          />

          {rule.counterparty && (
            <div>
              <EntityPickerField
                label={t('operations.fieldCounterparty')}
                required
                display={counterpartyName}
                placeholder={
                  isClient
                    ? t('operations.counterpartyPlaceholderClient')
                    : t('operations.counterpartyPlaceholderSupplier')
                }
                className="h-8 text-[13px]"
                onPick={() => openPicker('counterparty')}
                onClear={clearCounterparty}
              />
              {errors.counterpartyId && (
                <p role="alert" className={FIELD_ERROR}>
                  {errors.counterpartyId.message}
                </p>
              )}
            </div>
          )}

          {rule.employee && (
            <div>
              <EntityPickerField
                label={t('operations.fieldEmployee')}
                required
                display={employeeName}
                placeholder={t('operations.employeePlaceholder')}
                className="h-8 text-[13px]"
                onPick={() => openPicker('employee')}
                onClear={clearEmployee}
              />
              {errors.employeeId && (
                <p role="alert" className={FIELD_ERROR}>
                  {errors.employeeId.message}
                </p>
              )}
            </div>
          )}

          {rule.baseDocument && counterpartyId && (
            <div>
              <EntityPickerField
                label={
                  rule.baseDocument === 'WorkOrder'
                    ? t('operations.fieldBaseWorkOrder')
                    : t('operations.fieldBasePurchaseOrder')
                }
                display={baseDocumentNumber}
                placeholder={t('operations.basePlaceholder')}
                className="h-8 text-[13px]"
                onPick={() => openPicker('baseDocument')}
                onClear={clearBaseDocument}
              />
              {errors.baseDocumentId && (
                <p role="alert" className={FIELD_ERROR}>
                  {errors.baseDocumentId.message}
                </p>
              )}
            </div>
          )}

          {categoriesEnabled && (
            <Controller
              control={control}
              name="expenseCategoryId"
              render={({ field }) => (
                <Select
                  label={categoryLabel}
                  required={!!rule.categoryRequired}
                  value={asText(field.value)}
                  onChange={e => {
                    categoryAutoRef.current = false;
                    field.onChange(e.target.value);
                  }}
                  errorMessage={errors.expenseCategoryId?.message}
                >
                  <option value="">{t('operations.categoryNone')}</option>
                  {categoryOptions.map(c => (
                    <option key={c.id} value={c.id}>
                      {'  '.repeat(c.depth)}
                      {c.name}
                    </option>
                  ))}
                </Select>
              )}
            />
          )}

          <Input
            label={t('operations.fieldNotes')}
            {...register('notes')}
            placeholder={t('operations.notesPlaceholder')}
            errorMessage={errors.notes?.message}
            className="h-8 text-[13px]"
          />
        </div>
      </Modal>

      <SearchPickerModal
        open={picker === 'counterparty'}
        onClose={closePicker}
        title={isClient ? t('operations.pickClientTitle') : t('operations.pickSupplierTitle')}
        selectedId={counterpartyId || null}
        fetchItems={fetchCounterparties}
        onSelect={item => {
          // Інший контрагент — підстава попереднього йому не належить.
          if (item.id !== counterpartyId) clearBaseDocument();
          setValue('counterpartyId', item.id, { shouldValidate: !!errors.counterpartyId });
          setCounterpartyName(item.primary);
          closePicker();
        }}
      />

      <SearchPickerModal
        open={picker === 'employee'}
        onClose={closePicker}
        title={t('operations.pickEmployeeTitle')}
        selectedId={asText(watch('employeeId')) || null}
        fetchItems={fetchEmployees}
        onSelect={item => {
          setValue('employeeId', item.id, { shouldValidate: !!errors.employeeId });
          setEmployeeName(item.primary);
          closePicker();
        }}
      />

      <SearchPickerModal
        open={picker === 'baseDocument'}
        onClose={closePicker}
        title={
          rule.baseDocument === 'WorkOrder'
            ? t('operations.pickWorkOrderTitle')
            : t('operations.pickPurchaseOrderTitle')
        }
        selectedId={asText(watch('baseDocumentId')) || null}
        fetchItems={fetchBaseDocuments}
        onSelect={item => {
          // Тип і id підстави — лише разом (схема відхиляє половину пари).
          setValue('baseDocumentType', rule.baseDocument ?? '');
          setValue('baseDocumentId', item.id);
          setBaseDocumentNumber(item.primary);
          closePicker();
        }}
      />

      <DirtyConfirmDialog {...dirty.dialogProps} />
    </>
  );
}
