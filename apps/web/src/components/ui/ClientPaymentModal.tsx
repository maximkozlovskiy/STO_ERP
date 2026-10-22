'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CASH_METHOD_CODE, type ApiSchema } from '@sto/shared';
import { apiFetch } from '@/lib/api-client';
import { getCached, setCache } from '@/lib/ref-cache';
import { fmtMoney } from '@/lib/format';
import { invoiceRemaining } from '@/lib/invoice-payment';
import { useBaseCurrency, useCashRegisters, type CashRegister } from '@/hooks/api/useCash';
import { useCreatePayment } from '@/hooks/api/useInvoices';
import { useBankAccountOptions, type BankAccountOption } from '@/hooks/api/useBankStatements';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { newIdempotencyKey } from '@/lib/idempotency-key';
import { useAuth } from '@/lib/auth';

/** Спосіб оплати у вікні: код, назва і куди за замовчуванням надходять кошти. */
type PaymentMethodDto = ApiSchema<'PaymentMethodResponseDto'>;
type PayMethodOption = Pick<PaymentMethodDto, 'code' | 'name'> &
  Partial<
    Pick<
      PaymentMethodDto,
      | 'defaultSourceType'
      | 'defaultCashRegisterId'
      | 'defaultBankAccountId'
      | 'defaultDestinationName'
      | 'defaultDestinationCurrencyCode'
    >
  >;

const EMPTY_CASH_REGISTERS: CashRegister[] = [];
const EMPTY_BANK_ACCOUNTS: BankAccountOption[] = [];
// Ролі `GET /bank-accounts` (bank-accounts.controller). Адміністратор (RECEPTIONIST) оплату приймає,
// а переліку рахунків не має (403): йому вікно пропонує рахунок способу оплати, назву якого дає
// `GET /payment-methods` (BR-PAY-023).
const BANK_LIST_ROLES: readonly string[] = ['OWNER', 'ADMIN', 'ACCOUNTANT'];
const QR_METHOD_CODE = 'monobank_qr';
// Коди QR-способів оплати — `<шлюз>_qr` (monobank_qr, privat24_qr, liqpay_qr; setup.service).
const QR_CODE_SUFFIX = '_qr';

/**
 * Що оплачується. `invoice` — рахунок (сторінка рахунків; наряд сервер виводить із рахунку,
 * BR-PAY-021); `workOrder` — сам наряд (аванс до «Виконано», оплата після, BR-PAY-020).
 */
export interface ClientPaymentTarget {
  kind: 'invoice' | 'workOrder';
  id: string;
  counterpartyId: string;
  /** Сума документа: рахунку або «Разом» наряду. */
  amount: number;
  paidAmount?: number | null;
  /** Валюта документа; порожньо — базова. Каси іншої валюти не пропонуються. */
  currencyCode?: string | null;
}

export interface ClientPaymentModalProps {
  open: boolean;
  target: ClientPaymentTarget | null;
  /** Заголовок вікна задає викликач: «Оплата рахунку …», «Аванс за нарядом …», «Оплата наряду …». */
  title: string;
  onClose: () => void;
  /** Оплату зареєстровано: сума, що пішла на сервер, і вона ж із валютою документа («300,00 ₴»). */
  onPaid: (amount: number, formatted: string) => void;
  /**
   * monobank QR — лише для рахунку: QR-оплату створює сервер за рахунком. Без колбека спосіб QR
   * у переліку не показується.
   */
  onShowQr?: (amount: number | undefined) => void;
}

/**
 * Вікно «Оплатити» — спільне для рахунку й наряду (рішення власника 2026-10-15). Винесене зі
 * сторінки рахунків разом із її правилами:
 *  - каса для готівки обов'язкова (BR-PAY-019, `CASH_METHOD_CODE`); поле «Каса» є й для способу,
 *    у якого кошти за замовчуванням надходять у касу, і заповнюється касою способу, доки касир
 *    не обрав іншу сам;
 *  - безготівковий спосіб без каси за замовчуванням вимагає банківський рахунок (BR-PAY-023): поле
 *    «Рахунок» заповнене рахунком способу оплати, доки касир не обрав інший; QR — без поля;
 *  - каси — лише у валюті документа (Bug #857); порожній перелік пояснено (Bug #858);
 *  - сума за замовчуванням — залишок (порожнє поле);
 *  - один ключ ідемпотентності на відкриття вікна;
 *  - помилка сервера — у самому вікні, вікно лишається.
 */
export function ClientPaymentModal({
  open,
  target,
  title,
  onClose,
  onPaid,
  onShowQr,
}: ClientPaymentModalProps) {
  const { t } = useTranslation('invoices');
  const { data: baseCurrency } = useBaseCurrency();
  const baseCode = baseCurrency?.code ?? 'UAH';
  const baseSymbol = baseCurrency?.symbol ?? '₴';
  const createPayment = useCreatePayment();
  const { employee } = useAuth();

  const [payMethods, setPayMethods] = useState<PayMethodOption[]>([]);
  const [form, setForm] = useState({ method: CASH_METHOD_CODE, amount: '', notes: '' });
  // Каса, яку касир обрав сам; null — поле йде за касою за замовчуванням способу оплати.
  const [cashChoice, setCashChoice] = useState<string | null>(null);
  // Банківський рахунок, який касир обрав сам; null — поле йде за рахунком способу оплати.
  const [bankChoice, setBankChoice] = useState<string | null>(null);
  const [error, setError] = useState('');
  const idempotencyKeyRef = useRef('');

  // Кожне відкриття — чиста форма і новий ключ ідемпотентності.
  useEffect(() => {
    if (!open) return;
    setForm({ method: CASH_METHOD_CODE, amount: '', notes: '' });
    setCashChoice(null);
    setBankChoice(null);
    setError('');
    idempotencyKeyRef.current = newIdempotencyKey();
  }, [open, target?.id]);

  // Каси — лише коли вікно відкрите (сервер віддає невидалені, перші 200 за назвою).
  const {
    data: cashRegisters = EMPTY_CASH_REGISTERS,
    isPending: cashRegistersPending,
    isError: cashRegistersError,
  } = useCashRegisters(open);

  const allowQr = !!onShowQr && target?.kind === 'invoice';

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    // Без QR-сценарію (наряд) — жодного QR-способу: setup створює ще privat24_qr і liqpay_qr, і
    // обраний такий спосіб реєстрував оплату одразу, без жодного QR (Bug #870).
    const keep = (list: PayMethodOption[]) =>
      allowQr ? list : list.filter(m => !m.code.endsWith(QR_CODE_SUFFIX));
    // Довідник — одразу з sessionStorage, свіжий список фоном.
    const cached = getCached<PayMethodOption[]>('cache:payment-methods');
    if (cached) setPayMethods(keep(cached));
    apiFetch<PaymentMethodDto[]>('/payment-methods')
      .then(d => {
        const active = d
          .filter(m => m.isActive)
          .map(m => ({
            code: m.code,
            name: m.name,
            defaultSourceType: m.defaultSourceType,
            defaultCashRegisterId: m.defaultCashRegisterId,
            defaultBankAccountId: m.defaultBankAccountId,
            defaultDestinationName: m.defaultDestinationName,
            defaultDestinationCurrencyCode: m.defaultDestinationCurrencyCode,
          }));
        setCache('cache:payment-methods', active);
        if (!cancelled) setPayMethods(keep(active));
      })
      .catch((e: unknown) => {
        if (!cancelled && !cached) {
          setError(e instanceof Error ? e.message : t('errors.loadPaymentMethods'));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, allowQr, t]);

  // Вікно могло відкритись раніше, ніж прийшли способи: якщо «Готівку» вимкнено, у формі лишився б
  // неактивний код. Синхронізуємо з першим активним способом лише коли поточного немає в переліку.
  useEffect(() => {
    if (!open || payMethods.length === 0) return;
    setForm(f =>
      payMethods.some(m => m.code === f.method) ? f : { ...f, method: payMethods[0].code },
    );
  }, [payMethods, open]);

  const method = payMethods.find(m => m.code === form.method);
  const needsCash = form.method === CASH_METHOD_CODE;
  // monobank QR: вікно лише показує QR, оплату створює сервер за способом оплати — каса з поля
  // нікуди не йшла б (Bug #859), тож поля для QR немає.
  const isQr = form.method === QR_METHOD_CODE;
  const showsCash = !isQr && (needsCash || method?.defaultSourceType === 'CASH_REGISTER');
  const defaultCashId =
    method?.defaultSourceType === 'CASH_REGISTER' ? (method.defaultCashRegisterId ?? '') : '';
  // Валюта оплати — валюта каси, а сервер приймає лише валюту документа.
  const currencyCode = target?.currencyCode || baseCode;
  const cashOptions = useMemo(() => {
    const options = cashRegisters
      .filter(r => (r.currencyCode || baseCode) === currencyCode)
      .map(r => ({ id: r.id, name: r.name }));
    // Каса за замовчуванням жива (сервер дав її назву), але не потрапила в перші 200 за назвою.
    // Валюту поза переліком каже сервер — без неї гривнева каса йшла доларовому документу (Bug #857).
    if (
      defaultCashId &&
      method?.defaultDestinationName &&
      method.defaultDestinationCurrencyCode === currencyCode &&
      !cashRegisters.some(r => r.id === defaultCashId)
    )
      options.unshift({ id: defaultCashId, name: method.defaultDestinationName });
    return options;
  }, [
    cashRegisters,
    baseCode,
    currencyCode,
    defaultCashId,
    method?.defaultDestinationName,
    method?.defaultDestinationCurrencyCode,
  ]);
  const cashId = cashChoice ?? (cashOptions.some(o => o.id === defaultCashId) ? defaultCashId : '');
  const blockedNoCash = needsCash && !cashId;

  // BR-PAY-023: безготівкова оплата без каси — на банківський рахунок у валюті документа.
  const showsBank = !isQr && !showsCash;
  const canListBanks = BANK_LIST_ROLES.includes(employee?.role ?? '');
  const {
    data: bankAccounts = EMPTY_BANK_ACCOUNTS,
    isPending: bankAccountsPending,
    isError: bankAccountsError,
  } = useBankAccountOptions(open && showsBank && canListBanks);
  const defaultBankId =
    method?.defaultSourceType === 'BANK_ACCOUNT' ? (method.defaultBankAccountId ?? '') : '';
  const bankOptions = useMemo(() => {
    const options = bankAccounts
      .filter(a => (a.currencyCode || baseCode) === currencyCode)
      .map(a => ({ id: a.id, name: a.name }));
    // Рахунок способу оплати, якого немає в переліку (роль без `GET /bank-accounts`): назву й
    // валюту дає сервер способів оплати; рахунок іншої валюти не пропонуємо.
    if (
      defaultBankId &&
      method?.defaultDestinationName &&
      method.defaultDestinationCurrencyCode === currencyCode &&
      !bankAccounts.some(a => a.id === defaultBankId)
    )
      options.unshift({ id: defaultBankId, name: method.defaultDestinationName });
    return options;
  }, [
    bankAccounts,
    baseCode,
    currencyCode,
    defaultBankId,
    method?.defaultDestinationName,
    method?.defaultDestinationCurrencyCode,
  ]);
  const bankId = bankChoice ?? (bankOptions.some(o => o.id === defaultBankId) ? defaultBankId : '');
  const blockedNoBank = showsBank && !bankId;
  // Вимкнений запит теж «pending» — для ролі без переліку рахунків не чекаємо його.
  const bankHint =
    !showsBank || (canListBanks && bankAccountsPending) || payMethods.length === 0
      ? undefined
      : canListBanks && bankAccountsError
        ? t('payment.bankAccountsLoadError')
        : bankOptions.length === 0
          ? canListBanks
            ? t('payment.noBankAccountInCurrency', { code: currencyCode })
            : t('payment.methodHasNoBankAccount', { code: currencyCode })
          : blockedNoBank
            ? t('payment.bankAccountRequired')
            : undefined;
  const blocked = blockedNoCash || blockedNoBank;
  // Підказку показуємо, лише коли каси й способи вже прийшли. Порожній перелік пояснюємо
  // (Bug #858): збій завантаження чи жодної каси у валюті документа — а не «оберіть касу».
  const cashHint =
    !showsCash || cashRegistersPending || payMethods.length === 0
      ? undefined
      : cashRegistersError
        ? t('payment.cashRegistersLoadError')
        : cashOptions.length === 0
          ? t('payment.noCashRegisterInCurrency', { code: currencyCode })
          : blockedNoCash
            ? t('payment.cashRegisterRequired')
            : undefined;

  const remaining = target ? invoiceRemaining(target.amount, target.paidAmount) : 0;
  const paid = target?.paidAmount ?? 0;
  const isBase = !target?.currencyCode || target.currencyCode === baseCode;
  const sym = isBase ? baseSymbol : (target?.currencyCode ?? '');
  const fmt = (n: number) => `${fmtMoney(n)} ${sym}`;

  // Порожнє поле = оплата залишку (сума − сплачене), не всієї суми документа.
  const parsedAmount = (): number => {
    const raw = parseFloat(form.amount);
    return !form.amount || !Number.isFinite(raw) ? remaining : raw;
  };

  // Повторний клік / Enter під час запиту не шле другу оплату; той самий прапорець тримає вікно
  // відкритим (Escape теж), доки відповідь не прийшла — інакше результат оплати загубився б.
  const savingRef = useRef(false);

  const handlePay = async () => {
    if (!target || blocked || savingRef.current) return;
    const amount = parsedAmount();
    // BR-PAY-017: сума — від копійки до залишку. `min`/`max` поля кнопку не блокують (форми немає),
    // тож без цієї перевірки «0» чи сума понад залишок ішли на сервер.
    if (!(amount > 0) || amount > remaining + 1e-9) {
      setError(t('payment.amountOutOfRange', { remaining: fmt(remaining) }));
      return;
    }
    savingRef.current = true;
    setError('');
    try {
      await createPayment.mutateAsync({
        idempotencyKey: idempotencyKeyRef.current,
        counterpartyId: target.counterpartyId,
        ...(target.kind === 'invoice' ? { invoiceId: target.id } : { workOrderId: target.id }),
        amount,
        method: form.method,
        notes: form.notes || undefined,
        // Каса з поля перемагає замовчування способу; без поля сервер бере призначення способу.
        ...(showsCash && cashId ? { sourceType: 'CASH_REGISTER', cashRegisterId: cashId } : {}),
        ...(showsBank && bankId ? { sourceType: 'BANK_ACCOUNT', bankAccountId: bankId } : {}),
      });
      onPaid(amount, fmt(amount));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('errors.payment'));
    } finally {
      savingRef.current = false;
    }
  };

  // Стабільний onClose: Modal перевішує keydown-listener на кожну нову ідентичність колбека.
  const handleClose = useCallback(() => {
    if (savingRef.current) return;
    onClose();
  }, [onClose]);

  return (
    <Modal
      open={open && !!target}
      onClose={handleClose}
      title={title}
      footer={
        isQr && allowQr ? (
          <Button
            onClick={() => {
              const raw = parseFloat(form.amount);
              onShowQr?.(form.amount && Number.isFinite(raw) ? raw : undefined);
            }}
            className="w-full"
          >
            {t('payment.showQr')}
          </Button>
        ) : (
          <Button
            onClick={() => void handlePay()}
            loading={createPayment.isPending}
            disabled={blocked || remaining <= 0}
            className="w-full"
          >
            {t('payment.confirmPayment')}
          </Button>
        )
      }
    >
      {target && (
        <div className="space-y-4">
          {error && (
            <div
              role="alert"
              className="text-sm text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg p-3"
            >
              {error}
            </div>
          )}
          <div className="p-3 bg-info-subtle rounded-lg text-sm text-info-text space-y-0.5">
            <div>
              {target.kind === 'invoice'
                ? t('payment.invoiceAmount')
                : t('payment.workOrderAmount')}{' '}
              <strong className="tabular-nums">{fmt(target.amount)}</strong>
            </div>
            {paid > 0 && (
              <div>
                {t('payment.alreadyPaid')} <strong className="tabular-nums">{fmt(paid)}</strong>
              </div>
            )}
            <div>
              {t('payment.remaining')} <strong className="tabular-nums">{fmt(remaining)}</strong>
            </div>
          </div>
          <Select
            label={t('payment.method')}
            required
            value={form.method}
            onChange={e => setForm(f => ({ ...f, method: e.target.value }))}
            className="h-8 text-[13px] py-0.5 px-2 pr-7"
          >
            {payMethods.length > 0 ? (
              payMethods.map(m => (
                <option key={m.code} value={m.code}>
                  {m.name}
                </option>
              ))
            ) : (
              <>
                <option value="cash">{t('payment.methodCash')}</option>
                <option value="card_terminal">{t('payment.methodTerminal')}</option>
                <option value="bank_transfer">{t('payment.methodBankTransfer')}</option>
              </>
            )}
          </Select>
          {showsCash && (
            <Select
              label={t('payment.cashRegister')}
              required={needsCash}
              value={cashId}
              onChange={e => setCashChoice(e.target.value)}
              placeholder={t('payment.cashRegisterPlaceholder')}
              errorMessage={cashHint}
              className="h-8 text-[13px] py-0.5 px-2 pr-7"
            >
              {cashOptions.map(r => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </Select>
          )}
          {showsBank && (
            <Select
              label={t('payment.bankAccount')}
              required
              value={bankId}
              onChange={e => setBankChoice(e.target.value)}
              placeholder={t('payment.bankAccountPlaceholder')}
              errorMessage={bankHint}
              className="h-8 text-[13px] py-0.5 px-2 pr-7"
            >
              {bankOptions.map(a => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          )}
          <Input
            label={t('payment.amount', { sym })}
            type="number"
            value={form.amount}
            onChange={e => setForm(f => ({ ...f, amount: e.target.value }))}
            placeholder={String(remaining)}
            min="0.01"
            max={String(remaining)}
            step="0.01"
            hint={t('payment.amountHint')}
            className="h-8 text-[13px]"
          />
          <Input
            label={t('payment.notes')}
            value={form.notes}
            onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
            className="h-8 text-[13px]"
          />
        </div>
      )}
    </Modal>
  );
}
