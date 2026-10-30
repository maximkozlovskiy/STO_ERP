'use client';

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { CASH_METHOD_CODE, isOnlineMethodCode } from '@sto/shared';
import { useConfirm } from '@/hooks/useConfirm';
import { apiFetch } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Modal } from '@/components/ui/modal';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { TemplatePickerModal, type SystemTemplate } from '@/components/ui/template-picker-modal';
import { cn } from '@/lib/utils';
import { useCashRegisters } from '@/hooks/api/useCash';
import { useBankAccountOptions } from '@/hooks/api/useBankStatements';
import { type PaymentMethod } from './shared';

/** Куди надходять кошти у формі: '' — не вказано. */
type DestinationType = '' | 'CASH_REGISTER' | 'BANK_ACCOUNT';
interface DestinationForm {
  type: DestinationType;
  cashRegisterId: string;
  bankAccountId: string;
}
const NO_DESTINATION: DestinationForm = { type: '', cashRegisterId: '', bankAccountId: '' };

const destinationOf = (pm: PaymentMethod): DestinationForm => ({
  type: pm.defaultSourceType ?? '',
  cashRegisterId: pm.defaultCashRegisterId ?? '',
  bankAccountId: pm.defaultBankAccountId ?? '',
});

/** Тип обрано, а касу чи рахунок — ні: зберігати нічого, сервер відповів би 400. */
const destinationIncomplete = (d: DestinationForm) =>
  (d.type === 'CASH_REGISTER' && !d.cashRegisterId) ||
  (d.type === 'BANK_ACCOUNT' && !d.bankAccountId);

/** Тіло запиту: три поля разом; id іншого типу сервер обнулить сам. */
const destinationBody = (d: DestinationForm) =>
  d.type === 'CASH_REGISTER'
    ? { defaultSourceType: d.type, defaultCashRegisterId: d.cashRegisterId }
    : d.type === 'BANK_ACCOUNT'
      ? { defaultSourceType: d.type, defaultBankAccountId: d.bankAccountId }
      : { defaultSourceType: null, defaultCashRegisterId: null, defaultBankAccountId: null };

const sameDestination = (a: DestinationForm, b: DestinationForm) =>
  a.type === b.type &&
  (a.type !== 'CASH_REGISTER' || a.cashRegisterId === b.cashRegisterId) &&
  (a.type !== 'BANK_ACCOUNT' || a.bankAccountId === b.bankAccountId);

/**
 * Поле «Куди надходять кошти» картки способу оплати. Каси й рахунки читаються, лише коли картка
 * відкрита. Збережена каса, якої немає в переліку (видалена чи поза першими 200 за назвою), все
 * одно показується опцією — з назвою від сервера, або позначкою, що її видалено.
 */
function DestinationFields({
  value,
  onChange,
  savedName,
  active,
  cashOnly = false,
  bankOnly = false,
}: {
  value: DestinationForm;
  onChange: (next: DestinationForm) => void;
  savedName?: string | null;
  active: boolean;
  /**
   * «Готівка» (BR-PAY-019): гроші лягають лише в касу — банківського рахунку немає у виборі.
   * Рахунок, збережений до правила, лишається видимим (недоступна опція + пояснення), інакше
   * поле показувало б «— не вказано —», а вибрати саме цей варіант браузер не дав би.
   */
  cashOnly?: boolean;
  /**
   * Онлайн-спосіб `<шлюз>_qr` (BR-PAY-031): гроші приходять від шлюзу на банківський рахунок —
   * каси немає у виборі. Каса, збережена до правила, лишається видимою (недоступна + пояснення).
   */
  bankOnly?: boolean;
}) {
  const { t } = useTranslation('ndi');
  const { data: registers = [] } = useCashRegisters(active);
  const { data: accounts = [] } = useBankAccountOptions(active);
  const withSaved = (options: { id: string; name: string }[], id: string) =>
    id && !options.some(o => o.id === id)
      ? [{ id, name: savedName ?? t('payments.destinationMissing') }, ...options]
      : options;
  const cashOptions = withSaved(
    registers.map(r => ({ id: r.id, name: r.name })),
    value.type === 'CASH_REGISTER' ? value.cashRegisterId : '',
  );
  const bankOptions = withSaved(
    accounts.map(a => ({ id: a.id, name: a.name })),
    value.type === 'BANK_ACCOUNT' ? value.bankAccountId : '',
  );
  const incomplete = destinationIncomplete(value);
  const legacyBank = cashOnly && value.type === 'BANK_ACCOUNT';
  const legacyCash = bankOnly && value.type === 'CASH_REGISTER';

  return (
    <div className="space-y-3">
      <Select
        label={t('payments.destinationLabel')}
        value={value.type}
        onChange={e => onChange({ ...value, type: e.target.value as DestinationType })}
        hint={t('payments.destinationHint')}
        errorMessage={
          legacyBank
            ? t('payments.cashOnlyRegister')
            : legacyCash
              ? t('payments.onlineBankOnly')
              : undefined
        }
        className="h-8 text-[13px] py-0.5 px-2 pr-7"
      >
        <option value="">{t('payments.destinationNone')}</option>
        {(!bankOnly || legacyCash) && (
          <option value="CASH_REGISTER" disabled={bankOnly}>
            {t('payments.destinationCash')}
          </option>
        )}
        {(!cashOnly || legacyBank) && (
          <option value="BANK_ACCOUNT" disabled={cashOnly}>
            {t('payments.destinationBank')}
          </option>
        )}
      </Select>
      {value.type === 'CASH_REGISTER' && (
        <Select
          label={t('payments.cashRegisterLabel')}
          required
          disabled={bankOnly}
          value={value.cashRegisterId}
          onChange={e => onChange({ ...value, cashRegisterId: e.target.value })}
          placeholder={t('payments.selectPlaceholder')}
          errorMessage={incomplete ? t('payments.destinationRequired') : undefined}
          className="h-8 text-[13px] py-0.5 px-2 pr-7"
        >
          {cashOptions.map(o => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </Select>
      )}
      {value.type === 'BANK_ACCOUNT' && (
        <Select
          label={t('payments.bankAccountLabel')}
          required
          disabled={cashOnly}
          value={value.bankAccountId}
          onChange={e => onChange({ ...value, bankAccountId: e.target.value })}
          placeholder={t('payments.selectPlaceholder')}
          errorMessage={incomplete ? t('payments.destinationRequired') : undefined}
          className="h-8 text-[13px] py-0.5 px-2 pr-7"
        >
          {bankOptions.map(o => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </Select>
      )}
    </div>
  );
}

export default function PaymentsTab() {
  const { t } = useTranslation('ndi');
  const { confirm, dialogProps } = useConfirm();
  const [payments, setPayments] = useState<PaymentMethod[]>([]);
  const [error, setError] = useState('');

  const [editPayment, setEditPayment] = useState<PaymentMethod | null>(null);
  const [editPaymentForm, setEditPaymentForm] = useState({
    name: '',
    requiresFiscal: false,
    isCash: false,
    destination: NO_DESTINATION,
  });
  const [paymentModal, setPaymentModal] = useState(false);
  const [paymentTemplatePicker, setPaymentTemplatePicker] = useState(false);
  const [newPaymentForm, setNewPaymentForm] = useState({
    code: '',
    name: '',
    requiresFiscal: false,
    isCash: false,
    destination: NO_DESTINATION,
  });
  const [savingPayment, setSavingPayment] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<PaymentMethod[]>('/payment-methods')
      .then(setPayments)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : t('payments.loadError')));
  }, [t]);

  // Колонка «Надходження»: тип і назва від сервера; тип без назви — касу чи рахунок видалено.
  const destinationText = (pm: PaymentMethod) => {
    if (!pm.defaultSourceType) return t('payments.destinationNone');
    const kind = t(
      pm.defaultSourceType === 'CASH_REGISTER'
        ? 'payments.destinationCash'
        : 'payments.destinationBank',
    );
    return `${kind}: ${pm.defaultDestinationName ?? t('payments.destinationMissing')}`;
  };

  const togglePayment = async (pm: PaymentMethod) => {
    setError('');
    setTogglingId(pm.id);
    try {
      const updated = await apiFetch<PaymentMethod>(`/payment-methods/${pm.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: !pm.isActive }),
      });
      setPayments(prev => prev.map(p => (p.id === updated.id ? updated : p)));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('common.error'));
    } finally {
      setTogglingId(null);
    }
  };

  const openEditPayment = (pm: PaymentMethod) => {
    setEditPayment(pm);
    setEditPaymentForm({
      name: pm.name,
      requiresFiscal: pm.requiresFiscal,
      isCash: pm.isCash,
      destination: destinationOf(pm),
    });
  };

  // BR-PAY-032: ознаку «Готівка» системного способу `cash` не зняти (сервер теж відмовляє).
  const cashFlagLocked = editPayment?.code === CASH_METHOD_CODE;

  const saveEditPayment = async () => {
    if (!editPayment) return;
    // Bug #1010: відмова попередньої спроби не лишається над списком після успішного збереження.
    setError('');
    setSavingPayment(true);
    try {
      // Системний метод: сервер блокує зміну name (payment-methods.service isSystem-guard),
      // requiresFiscal лишається редагованим. Не надсилаємо name — інакше незмінений name
      // все одно спрацьовує guard (!== undefined) → 400.
      const updated = await apiFetch<PaymentMethod>(`/payment-methods/${editPayment.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          ...(editPayment.isSystem ? {} : { name: editPaymentForm.name }),
          requiresFiscal: editPaymentForm.requiresFiscal,
          ...(editPaymentForm.isCash === editPayment.isCash
            ? {}
            : { isCash: editPaymentForm.isCash }),
          // Призначення шлемо лише змінене: збережена, а потім видалена каса інакше давала б 404
          // на будь-яке інше редагування способу.
          ...(sameDestination(editPaymentForm.destination, destinationOf(editPayment))
            ? {}
            : destinationBody(editPaymentForm.destination)),
        }),
      });
      setPayments(prev => prev.map(p => (p.id === updated.id ? updated : p)));
      setEditPayment(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('common.error'));
    } finally {
      setSavingPayment(false);
    }
  };

  const createPaymentMethod = async () => {
    setError('');
    if (!newPaymentForm.code.trim() || !newPaymentForm.name.trim()) {
      setError(t('payments.codeNameRequired'));
      return;
    }
    setSavingPayment(true);
    try {
      const created = await apiFetch<PaymentMethod>('/payment-methods', {
        method: 'POST',
        body: JSON.stringify({
          code: newPaymentForm.code.trim().toUpperCase(),
          name: newPaymentForm.name.trim(),
          requiresFiscal: newPaymentForm.requiresFiscal,
          isCash: newPaymentForm.isCash,
          ...(newPaymentForm.destination.type ? destinationBody(newPaymentForm.destination) : {}),
        }),
      });
      setPayments(prev => [...prev, created]);
      setPaymentModal(false);
      setNewPaymentForm({
        code: '',
        name: '',
        requiresFiscal: false,
        isCash: false,
        destination: NO_DESTINATION,
      });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('common.error'));
    } finally {
      setSavingPayment(false);
    }
  };

  const importPaymentsFromTemplates = async (templates: SystemTemplate[]) => {
    // sto-optimize: bulk-create templates паралель — кожен POST незалежний (унікальні codes
    // у шаблонах). Sequential N × RTT → max single RTT. Promise.allSettled зберігає
    // per-item error tracking без abort'у решти при першій помилці.
    const results = await Promise.allSettled(
      templates.map(t =>
        apiFetch<PaymentMethod>('/payment-methods', {
          method: 'POST',
          body: JSON.stringify(t.data),
        }),
      ),
    );
    const created: PaymentMethod[] = [];
    for (const r of results) {
      if (r.status === 'fulfilled') created.push(r.value);
    }
    if (created.length > 0) {
      setPayments(prev => [...prev, ...created]);
    }
  };

  const deletePaymentMethod = async (id: string) => {
    if (!(await confirm({ title: t('payments.deleteConfirmTitle'), variant: 'destructive' })))
      return;
    setError('');
    try {
      await apiFetch(`/payment-methods/${id}`, { method: 'DELETE' });
      setPayments(prev => prev.filter(p => p.id !== id));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('common.error'));
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
        <Button variant="outline" onClick={() => setPaymentTemplatePicker(true)}>
          {t('common.fromTemplate')}
        </Button>
        <Button
          leftIcon={<Plus className="h-4 w-4" />}
          onClick={() => {
            setNewPaymentForm({
              code: '',
              name: '',
              requiresFiscal: false,
              isCash: false,
              destination: NO_DESTINATION,
            });
            setPaymentModal(true);
          }}
        >
          {t('payments.addButton')}
        </Button>
      </div>

      <TemplatePickerModal
        open={paymentTemplatePicker}
        onClose={() => setPaymentTemplatePicker(false)}
        entityType="payment_method"
        title={t('payments.templateTitle')}
        existingKeys={payments.map(p => p.code)}
        onImport={importPaymentsFromTemplates}
      />

      <div className="bg-surface rounded-xl border border-border divide-y divide-border">
        {payments.length === 0 && (
          <p className="p-6 text-sm text-muted-foreground">{t('payments.empty')}</p>
        )}
        {payments.map(pm => (
          <div key={pm.id} className="flex items-center justify-between px-5 py-4">
            <div>
              <div className="flex items-center gap-2">
                <p className="text-sm font-medium text-foreground">{pm.name}</p>
                {pm.isSystem && (
                  <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground bg-muted rounded px-1.5 py-0.5">
                    {t('payments.system')}
                  </span>
                )}
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                {pm.code}
                {pm.isCash ? t('payments.cashSuffix') : ''}
                {pm.requiresFiscal ? t('payments.fiscalSuffix') : ''}
              </p>
            </div>
            <div className="flex items-center gap-4">
              <div className="text-right min-w-0">
                <p className="text-[11px] text-muted-foreground">
                  {t('payments.destinationColumn')}
                </p>
                <p
                  className={cn(
                    'text-xs truncate max-w-56',
                    pm.defaultSourceType && !pm.defaultDestinationName
                      ? 'text-destructive-text'
                      : 'text-foreground',
                  )}
                  data-testid={`pm-destination-${pm.code}`}
                >
                  {destinationText(pm)}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => void togglePayment(pm)}
                  disabled={togglingId === pm.id}
                  role="switch"
                  aria-checked={pm.isActive}
                  aria-label={t('payments.activeAria', { name: pm.name })}
                  className={cn(
                    'relative inline-flex h-5 w-9 rounded-full transition-colors',
                    pm.isActive ? 'bg-primary' : 'bg-border',
                  )}
                >
                  <span
                    className={cn(
                      'inline-block h-4 w-4 rounded-full bg-surface shadow transform transition-transform mt-0.5',
                      pm.isActive ? 'translate-x-4' : 'translate-x-0.5',
                    )}
                  />
                </button>
                <button
                  onClick={() => openEditPayment(pm)}
                  aria-label={`${t('payments.editTitle')}: ${pm.name}`}
                  className="p-1 text-muted-foreground hover:text-foreground"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                {!pm.isSystem && (
                  <button
                    onClick={() => void deletePaymentMethod(pm.id)}
                    aria-label={t('payments.deleteAria', { name: pm.name })}
                    className="p-1 text-destructive/70 hover:text-destructive hover:bg-destructive/10 rounded"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Edit payment modal */}
      {editPayment && (
        <Modal
          open={!!editPayment}
          onClose={() => setEditPayment(null)}
          title={t('payments.editTitle')}
          footer={
            <Button
              onClick={() => void saveEditPayment()}
              loading={savingPayment}
              disabled={destinationIncomplete(editPaymentForm.destination)}
              className="w-full"
            >
              {t('common.save')}
            </Button>
          }
        >
          <div className="space-y-4">
            {editPayment.isSystem && (
              <p className="text-xs text-muted-foreground">{t('payments.systemHint')}</p>
            )}
            <Input
              label={t('payments.fieldName')}
              value={editPaymentForm.name}
              onChange={e => setEditPaymentForm(f => ({ ...f, name: e.target.value }))}
              required
              disabled={editPayment.isSystem}
              className="h-8 text-[13px]"
            />
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={editPaymentForm.requiresFiscal}
                onChange={e =>
                  setEditPaymentForm(f => ({ ...f, requiresFiscal: e.target.checked }))
                }
                className="rounded border-border"
              />
              <span className="text-[13px] text-foreground">{t('payments.fiscalLabel')}</span>
            </label>
            <div>
              <label
                className={cn(
                  'flex items-center gap-2',
                  cashFlagLocked ? 'cursor-not-allowed' : 'cursor-pointer',
                )}
              >
                <input
                  type="checkbox"
                  checked={editPaymentForm.isCash}
                  // BR-PAY-032: системний `cash` завжди готівковий — оплати з каси йдуть ним у чек ПРРО.
                  disabled={cashFlagLocked}
                  aria-describedby={cashFlagLocked ? 'pm-cash-flag-locked' : undefined}
                  onChange={e => setEditPaymentForm(f => ({ ...f, isCash: e.target.checked }))}
                  className="rounded border-border"
                />
                <span className="text-[13px] text-foreground">{t('payments.cashLabel')}</span>
              </label>
              {cashFlagLocked && (
                <p id="pm-cash-flag-locked" className="mt-1 text-xs text-muted-foreground">
                  {t('payments.cashFlagLocked')}
                </p>
              )}
            </div>
            <DestinationFields
              value={editPaymentForm.destination}
              onChange={destination => setEditPaymentForm(f => ({ ...f, destination }))}
              savedName={editPayment.defaultDestinationName}
              active
              cashOnly={editPaymentForm.isCash}
              bankOnly={isOnlineMethodCode(editPayment.code)}
            />
          </div>
        </Modal>
      )}

      {/* Create payment modal */}
      <Modal
        open={paymentModal}
        onClose={() => setPaymentModal(false)}
        title={t('payments.createTitle')}
        footer={
          <Button
            onClick={() => void createPaymentMethod()}
            loading={savingPayment}
            disabled={
              !newPaymentForm.code ||
              !newPaymentForm.name ||
              destinationIncomplete(newPaymentForm.destination)
            }
            className="w-full"
          >
            {t('payments.addSubmit')}
          </Button>
        }
      >
        <div className="space-y-4">
          <Input
            label={t('payments.fieldCode')}
            value={newPaymentForm.code}
            onChange={e => setNewPaymentForm(f => ({ ...f, code: e.target.value }))}
            placeholder={t('payments.codePlaceholder')}
            required
            hint={t('payments.codeHint')}
            className="h-8 text-[13px]"
          />
          <Input
            label={t('payments.fieldName')}
            value={newPaymentForm.name}
            onChange={e => setNewPaymentForm(f => ({ ...f, name: e.target.value }))}
            placeholder={t('payments.namePlaceholder')}
            required
            className="h-8 text-[13px]"
          />
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={newPaymentForm.requiresFiscal}
              onChange={e => setNewPaymentForm(f => ({ ...f, requiresFiscal: e.target.checked }))}
              className="rounded border-border"
            />
            <span className="text-[13px] text-foreground">{t('payments.fiscalLabel')}</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={newPaymentForm.isCash}
              onChange={e => setNewPaymentForm(f => ({ ...f, isCash: e.target.checked }))}
              className="rounded border-border"
            />
            <span className="text-[13px] text-foreground">{t('payments.cashLabel')}</span>
          </label>
          <DestinationFields
            value={newPaymentForm.destination}
            onChange={destination => setNewPaymentForm(f => ({ ...f, destination }))}
            active={paymentModal}
            cashOnly={newPaymentForm.isCash}
            bankOnly={isOnlineMethodCode(newPaymentForm.code)}
          />
        </div>
      </Modal>

      <ConfirmDialog {...dialogProps} />
    </div>
  );
}
