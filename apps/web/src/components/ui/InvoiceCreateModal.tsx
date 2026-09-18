'use client';

import { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import { useForm, useFieldArray, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  invoiceFormSchema,
  INVOICE_TYPE_VALUES,
  type InvoiceFormInput,
  type InvoiceFormValues,
} from '@sto/shared';
import {
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  Minus,
  Printer,
  Download,
  Share2,
  MessageSquare,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import { apiFetch } from '@/lib/api-client';
import { toast } from '@/lib/toast';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import { useDirtyForm } from '@/hooks/useDirtyForm';
import { DirtyConfirmDialog } from '@/components/ui/dirty-confirm-dialog';
import { useTabBarContext } from '@/contexts/TabBarContext';
import { displayCounterpartyName, cn } from '@/lib/utils';
import { kyivToday } from '@/lib/format';
import {
  INVOICE_STATUS_LABELS,
  INVOICE_STATUS_DESCRIPTIONS,
  INVOICE_STATUS_TRANSITIONS,
  INVOICE_TYPE_LABELS,
} from '@sto/shared';
import { invoiceStatusLabel, invoiceTypeLabel } from '@/i18n/enumLabel';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { DatePickerInput } from '@/components/ui/date-picker-input';
import { EntityPickerField } from '@/components/ui/entity-picker-field';
import { SearchPickerModal, type SearchPickerItem } from '@/components/ui/search-picker-modal';
import { CurrencySelect } from '@/components/ui/CurrencySelect';
import { useBaseCurrency } from '@/hooks/api/useCash';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Counterparty {
  id: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  phone?: string | null;
}

interface InvoiceDetail {
  id: string;
  number: string;
  status: string;
  invoiceType?: string | null;
  counterpartyId: string;
  counterpartyName?: string | null;
  currencyId?: string | null;
  currencyCode?: string | null;
  workOrderId?: string | null;
  workOrderNumber?: string | null;
  amount: number;
  totalWithoutVat?: number;
  totalVat?: number;
  totalWithVat?: number;
  paidAmount?: number;
  dueDate?: string | null;
  documentDate?: string | null;
  notes?: string | null;
  lines?: InvoiceLine[];
}

interface InvoiceLine {
  id: string;
  description: string;
  quantity: number;
  unitPrice: number;
  vatRate: number;
  priceWithVat: number;
}

interface LocalLine {
  _key: string;
  id?: string;
  description: string;
  quantity: string;
  unitPrice: string;
  // WEB-R3-4: авторитетна сума рядка З ПДВ (backend-derived priceWithVat — вже per-line total, не
  // per-unit: backend рахує з lineSum=qty×price). Дозволяє прев'ю «Разом» збігатися з фактичною
  // сумою рахунку і для EXCLUSIVE (ПДВ зверху), і для INCLUSIVE (ПДВ у ціні — беремо готове
  // значення, НЕ перераховуємо, щоб не подвоїти). Нові ручні рядки — undefined (backend
  // recalcTotals порахує при збереженні), прев'ю тоді qty×unitPrice без ПДВ (чесно).
  lineTotalWithVat?: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

// Must stay in sync with INVOICE_STATUS_BADGE in @sto/shared.
const STATUS_COLORS: Record<string, string> = {
  DRAFT: 'bg-secondary text-muted-foreground',
  SENT: 'bg-info-subtle text-info-text',
  PARTIALLY_PAID: 'bg-warning-subtle text-warning-text',
  PAID: 'bg-success-subtle text-success',
  OVERDUE: 'bg-warning-subtle text-warning-text',
  CANCELLED: 'bg-destructive-subtle text-destructive',
};

const TRANSITION_LABELS: Record<string, string> = {
  SENT: 'Надіслати',
  PAID: 'Позначити оплаченим',
  CANCELLED: 'Скасувати',
};

const INVOICE_STATUS_ORDER = Object.keys(INVOICE_STATUS_LABELS);

const EMPTY_TRANSITIONS: readonly string[] = Object.freeze([]);

const nextKey = () =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `k${Math.random().toString(36).slice(2)}`;

const EMPTY_LINE: Omit<LocalLine, '_key'> = { description: '', quantity: '1', unitPrice: '' };

// Бек-дефолт invoiceType='INVOICE' (Prisma @default, createFromWorkOrder/refreshFromWorkOrder
// не передають invoiceType у create()) — значення НЕ входить до UI-enum STANDARD/PREPAYMENT/
// CREDIT_NOTE (INVOICE_TYPE_VALUES). Без нормалізації reset() пише 'INVOICE' у форму й
// zodResolver валить submit існуючих (переважно виставлених з наряду) рахунків. Будь-яке
// значення поза enum → 'STANDARD' (найближчий за змістом дефолт).
const normalizeInvoiceType = (value?: string | null): InvoiceFormValues['invoiceType'] =>
  value && (INVOICE_TYPE_VALUES as readonly string[]).includes(value)
    ? (value as InvoiceFormValues['invoiceType'])
    : 'STANDARD';

// ─── Props ────────────────────────────────────────────────────────────────────

export interface InvoiceCreateModalProps {
  open: boolean;
  onClose: () => void;
  onSaved?: () => void;
  invoiceId?: string;
  onMinimize?: () => void;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function InvoiceCreateModal({
  open,
  onClose,
  onSaved,
  invoiceId,
  onMinimize,
}: InvoiceCreateModalProps) {
  const isEditMode = !!invoiceId;
  const features = useUiFeatures();
  const dirty = useDirtyForm({ enabled: features.unsavedGuardEnabled });
  const { minimizeModal } = useTabBarContext();

  // react-hook-form + спільна zod-схема (шапка + line-items через useFieldArray).
  const {
    register,
    control,
    reset,
    watch,
    setValue,
    getValues,
    handleSubmit,
    formState: { errors, isDirty: rhfDirty },
  } = useForm<InvoiceFormInput, unknown, InvoiceFormValues>({
    resolver: zodResolver(invoiceFormSchema),
    defaultValues: {
      counterpartyId: '',
      invoiceType: 'STANDARD',
      currencyId: '',
      dueDate: '',
      documentDate: kyivToday(),
      notes: '',
      lines: [],
    },
    mode: 'onBlur',
  });
  // Line-items: fields несуть _key/id/description/quantity/unitPrice + локальне lineTotalWithVat
  // (авторитетна сума з ПДВ для прев'ю; не валідується схемою). append/remove керують масивом.
  const { fields, append, remove } = useFieldArray({ control, name: 'lines' });
  const watchedLines = watch('lines');
  const watchedCurrencyId = watch('currencyId');
  // Мультивалюта (Фаза 3): локальний перелік валют — щоб з currencyId вивести символ/код
  // для колонок «Ціна»/«Сума» та підсумків (CurrencySelect не експонує обраний елемент).
  const [currencies, setCurrencies] = useState<
    { id: string; code: string; symbol?: string | null }[]
  >([]);
  const { data: baseCurrency } = useBaseCurrency();
  const [counterpartyDisplay, setCounterpartyDisplay] = useState('');
  const [currentStatus, setCurrentStatus] = useState('DRAFT');
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [workOrderNumber, setWorkOrderNumber] = useState<string | null>(null);
  const [paidAmount, setPaidAmount] = useState<number | null>(null);
  const [newLine, setNewLine] = useState<Omit<LocalLine, '_key'>>(EMPTY_LINE);
  const [showLineInput, setShowLineInput] = useState(false);
  const [headerCollapsed, setHeaderCollapsed] = useState(false);
  const [statusMenuOpen, setStatusMenuOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [transitioning, setTransitioning] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saveAsOpen, setSaveAsOpen] = useState(false);
  const [error, setError] = useState('');
  const [cpPickerOpen, setCpPickerOpen] = useState(false);

  const savingRef = useRef(false);
  const transitioningRef = useRef(false);
  const statusMenuRef = useRef<HTMLDivElement>(null);
  // snapshot id-шників рядків станом на load — щоб у handleSave виявити
  // рядки які користувач видалив локально (з UI). Без цього DELETE на бекенд не
  // йде і видалені рядки повертаються при наступному перезавантаженні модалки.
  const initialLineIdsRef = useRef<Set<string>>(new Set());
  // Retry-safety: якщо POST /invoices вже створив рахунок, але наступний крок
  // (POST /lines) провалився на обриві — повторний клік «Створити» не має
  // створити ДРУГИЙ рахунок. Зберігаємо id першого успіху й дошиваємо лише
  // ще-не-збережені рядки (їх видаляємо зі state після кожного успішного POST).
  const createdInvoiceRef = useRef<{ id: string; number: string } | null>(null);
  // Bug #755: retry-safety для РЯДКІВ. Multi-request submit (POST шапка → N× POST /lines)
  // при обриві на рядку #2 лишав рядок #1 уже збереженим на беку; повторний клік
  // ре-постив ВСІ рядки з форми (linesToPost щоразу з RHF-масиву) → задвоєна сума.
  // Тут запам'ятовуємо _key кожного успішно збереженого рядка (create+edit) і на
  // ретраї пропускаємо його. _key стабільний per-line (nextKey() при load/append/flush).
  const postedLineKeysRef = useRef<Set<string>>(new Set());

  const setSavingBoth = (v: boolean) => {
    savingRef.current = v;
    setSaving(v);
  };
  const setTransitioningBoth = (v: boolean) => {
    transitioningRef.current = v;
    setTransitioning(v);
  };

  // Close status menu on outside click
  useEffect(() => {
    if (!statusMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (statusMenuRef.current && !statusMenuRef.current.contains(e.target as Node)) {
        setStatusMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [statusMenuOpen]);

  // Reset on open
  useEffect(() => {
    if (!open) return;
    dirty.resetDirty();
    setError('');
    setStatusMenuOpen(false);
    setHeaderCollapsed(false);
    setInvoiceNumber('');
    setCurrentStatus('DRAFT');
    setWorkOrderNumber(null);
    setPaidAmount(null);
    setNewLine(EMPTY_LINE);
    setShowLineInput(false);
    initialLineIdsRef.current = new Set();
    createdInvoiceRef.current = null;
    postedLineKeysRef.current = new Set();
    if (!isEditMode) {
      // reset() ставить нову «чисту» базу → rhfDirty=false (edit-режим заповнюється load-ефектом).
      reset({
        counterpartyId: '',
        invoiceType: 'STANDARD',
        currencyId: '',
        dueDate: '',
        documentDate: kyivToday(),
        notes: '',
        lines: [],
      });
      setCounterpartyDisplay('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, invoiceId]);

  // Міст RHF isDirty → useDirtyForm (DirtyConfirmDialog + beforeunload збережено).
  useEffect(() => {
    if (rhfDirty) dirty.markDirty();
    else dirty.resetDirty();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rhfDirty]);

  // Мультивалюта: підвантажити перелік валют для резолву символу обраної валюти.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    apiFetch<{ items: { id: string; code: string; symbol?: string | null }[] }>('/currencies')
      .then(r => {
        if (!cancelled) setCurrencies(r.items ?? []);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Символ обраної валюти для колонок/підсумків (fallback — код або базовий символ).
  const selectedCurrency = currencies.find(c => c.id === watchedCurrencyId);
  const currencySymbol =
    selectedCurrency?.symbol || selectedCurrency?.code || baseCurrency?.symbol || '₴';

  // Load invoice data in edit mode
  useEffect(() => {
    if (!open || !isEditMode || !invoiceId) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    apiFetch<InvoiceDetail>(`/invoices/${invoiceId}`)
      .then(inv => {
        if (cancelled) return;
        setInvoiceNumber(inv.number);
        setCurrentStatus(inv.status);
        setWorkOrderNumber(inv.workOrderNumber ?? null);
        setPaidAmount(inv.paidAmount ?? null);
        const loadedLines = (inv.lines ?? []).map(l => ({
          _key: nextKey(),
          id: l.id,
          description: l.description,
          quantity: String(l.quantity),
          unitPrice: String(l.unitPrice),
          lineTotalWithVat: l.priceWithVat, // WEB-R3-4: авторитетна сума з ПДВ для прев'ю «Разом»
        }));
        // reset() із завантаженими даними → нова «чиста» база (rhfDirty=false для незмінених даних).
        reset({
          counterpartyId: inv.counterpartyId ?? '',
          invoiceType: normalizeInvoiceType(inv.invoiceType),
          currencyId: inv.currencyId ?? '',
          dueDate: inv.dueDate ? inv.dueDate.slice(0, 10) : '',
          documentDate: inv.documentDate ? inv.documentDate.slice(0, 10) : kyivToday(),
          notes: inv.notes ?? '',
          lines: loadedLines,
        });
        setCounterpartyDisplay(inv.counterpartyName ?? '');
        initialLineIdsRef.current = new Set(loadedLines.map(l => l.id!).filter(Boolean));
      })
      .catch(e => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Помилка завантаження рахунку');
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
        // Позначаємо завантаження завершеним — value-based ефект захопить базлайн
        // на фактично завантажених даних (не на порожній формі).
      });
    return () => {
      cancelled = true;
    };
  }, [open, invoiceId]);

  // Auto-collapse header when adding lines
  useEffect(() => {
    if (showLineInput) setHeaderCollapsed(true);
  }, [showLineInput]);

  // ── Counterparty picker ───────────────────────────────────────────────────

  type CpItem = SearchPickerItem & { phone?: string | null };

  const fetchCpItems = useCallback(async (q: string): Promise<CpItem[]> => {
    const url = q.trim()
      ? `/counterparties?q=${encodeURIComponent(q.trim())}&limit=30`
      : `/counterparties?limit=30`;
    const data = await apiFetch<{ items: Counterparty[] }>(url);
    return data.items.map(c => ({
      id: c.id,
      primary: displayCounterpartyName(c),
      secondary: c.phone ?? undefined,
    }));
  }, []);

  // ── FSM ───────────────────────────────────────────────────────────────────

  const allowedTransitions = isEditMode
    ? (INVOICE_STATUS_TRANSITIONS[currentStatus] ?? EMPTY_TRANSITIONS)
    : EMPTY_TRANSITIONS;

  const { statusPrevStep, statusNextStep } = useMemo(() => {
    const curIdx = INVOICE_STATUS_ORDER.indexOf(currentStatus);
    let statusPrevStep: string | undefined;
    for (let i = allowedTransitions.length - 1; i >= 0; i--) {
      const s = allowedTransitions[i];
      if (s && INVOICE_STATUS_ORDER.indexOf(s) < curIdx) {
        statusPrevStep = s;
        break;
      }
    }
    const statusNextStep = allowedTransitions.find(
      (s: string) => INVOICE_STATUS_ORDER.indexOf(s) > curIdx,
    );
    return { statusPrevStep, statusNextStep };
  }, [currentStatus, isEditMode]);

  const doTransition = async (newStatus: string) => {
    if (!invoiceId) return;
    setTransitioningBoth(true);
    setError('');
    try {
      await apiFetch(`/invoices/${invoiceId}/transition`, {
        method: 'POST',
        body: JSON.stringify({ status: newStatus }),
      });
      setCurrentStatus(newStatus);
      onSaved?.();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка переходу статусу');
    } finally {
      setTransitioningBoth(false);
    }
  };

  // ── Lines ─────────────────────────────────────────────────────────────────

  // WEB-R3-4: прев'ю «Разом» бере авторитетну суму рядка з ПДВ (lineTotalWithVat) якщо вона відома
  // (завантажений рахунок) — усуває заниження для EXCLUSIVE та подвоєння для INCLUSIVE. Нові ручні
  // рядки (ще без backend-розрахунку) → qty×unitPrice без ПДВ; backend додасть ПДВ при збереженні.
  const total = useMemo(
    () =>
      (watchedLines ?? []).reduce((sum, l) => {
        const withVat = (l as { lineTotalWithVat?: number }).lineTotalWithVat;
        if (withVat != null) return sum + withVat;
        const qty = parseFloat(String(l.quantity)) || 0;
        const price = parseFloat(String(l.unitPrice)) || 0;
        return sum + qty * price;
      }, 0),
    [watchedLines],
  );

  const addLine = () => {
    if (!newLine.description) return;
    append({ ...newLine, _key: nextKey() });
    setNewLine(EMPTY_LINE);
    setShowLineInput(false);
  };

  const removeLine = (index: number) => remove(index);

  // ── Save / Create ─────────────────────────────────────────────────────────

  const canEdit = isEditMode ? currentStatus === 'DRAFT' : true;

  // Тип рядка у field-array (форм-схема + локальні _key/id/lineTotalWithVat).
  type FormLine = {
    _key?: string;
    id?: string;
    description: string;
    quantity: string;
    unitPrice: string;
    lineTotalWithVat?: number;
  };

  // Локальна допоміжна: зібрати рядки для POST з auto-flush pending newLine.
  const collectLines = (): FormLine[] => {
    const arr = (getValues('lines') as FormLine[]) ?? [];
    if (newLine.description) {
      const flushed = { ...newLine, _key: nextKey() };
      append(flushed);
      setNewLine(EMPTY_LINE);
      return [...arr, flushed];
    }
    return arr;
  };

  // WEB-H3: синхронний guard проти concurrent double-submit (savingRef фліпається до re-render).
  const handleCreate = handleSubmit(async (values: InvoiceFormValues) => {
    if (savingRef.current || transitioningRef.current) return;
    setSavingBoth(true);
    setError('');
    try {
      const linesToPost = collectLines();
      // total з рядків → передаємо у POST замість 0.01 placeholder (щоб при обриві між
      // POST /invoices і POST /lines invoice не лишався з нерелевантним amount=0.01).
      const computedTotal = linesToPost.reduce((s, l) => {
        const qty = parseFloat(String(l.quantity)) || 0;
        const price = parseFloat(String(l.unitPrice)) || 0;
        return s + qty * price;
      }, 0);
      // Перевикористовуємо вже створений рахунок на retry, щоб не плодити дублі.
      let inv = createdInvoiceRef.current;
      if (!inv) {
        inv = await apiFetch<{ id: string; number: string }>('/invoices', {
          method: 'POST',
          body: JSON.stringify({
            counterpartyId: values.counterpartyId,
            invoiceType: values.invoiceType,
            currencyId: values.currencyId,
            amount: computedTotal >= 0.01 ? computedTotal : 0.01,
            dueDate: values.dueDate,
            documentDate: values.documentDate,
            notes: values.notes,
          }),
        });
        createdInvoiceRef.current = inv;
      }
      // Постимо рядки; на ретраї пропускаємо вже збережені (Bug #755). Кожен успіх
      // фіксуємо у postedLineKeysRef ДО shift — щоб обрив на наступному рядку не
      // ре-постив попередні при повторному кліку «Створити».
      const remaining = [...linesToPost];
      while (remaining.length) {
        const line = remaining[0]!;
        if (!line._key || !postedLineKeysRef.current.has(line._key)) {
          await apiFetch(`/invoices/${inv.id}/lines`, {
            method: 'POST',
            body: JSON.stringify({
              description: line.description,
              quantity: parseFloat(String(line.quantity)) || 1,
              unitPrice: parseFloat(String(line.unitPrice)) || 0,
            }),
          });
          if (line._key) postedLineKeysRef.current.add(line._key);
        }
        remaining.shift();
      }
      createdInvoiceRef.current = null;
      postedLineKeysRef.current = new Set();
      if (features.toastEnabled) toast.success(`Рахунок ${inv.number} створено`);
      dirty.resetDirty();
      onSaved?.();
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка створення рахунку');
    } finally {
      setSavingBoth(false);
    }
  });

  const handleSave = handleSubmit(async (values: InvoiceFormValues) => {
    if (!invoiceId) return;
    if (savingRef.current || transitioningRef.current) return;
    setSavingBoth(true);
    setError('');
    try {
      await apiFetch(`/invoices/${invoiceId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          counterpartyId: values.counterpartyId,
          invoiceType: values.invoiceType,
          currencyId: values.currencyId,
          dueDate: values.dueDate,
          documentDate: values.documentDate,
          notes: values.notes,
        }),
      });

      const linesNow = collectLines();
      // DELETE рядків, прибраних локально (є у initialLineIdsRef, немає у поточних id).
      const currentIds = new Set(linesNow.map(l => l.id).filter(Boolean) as string[]);
      const removedIds = [...initialLineIdsRef.current].filter(id => !currentIds.has(id));
      for (const lineId of removedIds) {
        await apiFetch(`/invoices/${invoiceId}/lines/${lineId}`, { method: 'DELETE' });
        initialLineIdsRef.current.delete(lineId);
      }
      // POST нових рядків (без id). Bug #755: на ретраї (DELETE ok, але POST нового впав)
      // пропускаємо вже збережені _key — інакше повторний «Зберегти» задвоював нові рядки
      // (без id вони щоразу потрапляли у фільтр). Успіх фіксуємо у postedLineKeysRef.
      for (const line of linesNow.filter(l => !l.id)) {
        if (line._key && postedLineKeysRef.current.has(line._key)) continue;
        await apiFetch(`/invoices/${invoiceId}/lines`, {
          method: 'POST',
          body: JSON.stringify({
            description: line.description,
            quantity: parseFloat(String(line.quantity)) || 1,
            unitPrice: parseFloat(String(line.unitPrice)) || 0,
          }),
        });
        if (line._key) postedLineKeysRef.current.add(line._key);
      }
      postedLineKeysRef.current = new Set();

      if (features.toastEnabled) toast.success('Рахунок збережено');
      dirty.resetDirty();
      onSaved?.();
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка збереження');
    } finally {
      setSavingBoth(false);
    }
  });

  const handleModalClose = useCallback(async () => {
    if (savingRef.current || transitioningRef.current) return;
    if (!(await dirty.confirmClose())) return;
    onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose]);

  // ── Render ────────────────────────────────────────────────────────────────

  const watchedInvoiceType =
    typeof watch('invoiceType') === 'string' ? (watch('invoiceType') as string) : '';
  const watchedDueDate = typeof watch('dueDate') === 'string' ? (watch('dueDate') as string) : '';
  const watchedCounterpartyId = watch('counterpartyId');

  const headerChips =
    isEditMode && headerCollapsed
      ? [
          watchedInvoiceType ? invoiceTypeLabel(watchedInvoiceType) : null,
          counterpartyDisplay || null,
          watchedDueDate ? `до ${watchedDueDate}` : null,
        ].filter(Boolean)
      : [];

  return (
    <>
      <Modal
        open={open}
        onClose={handleModalClose}
        onSubmit={handleSave}
        title={isEditMode ? 'Рахунок-фактура' : 'Новий рахунок'}
        size="content"
        hideClose
        headerContent={
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2 text-[13px] text-muted-foreground shrink-0">
              <span className="font-medium">Номер:</span>
              <span className="text-foreground">
                {isEditMode && invoiceNumber ? invoiceNumber : '— присвоюється автоматично —'}
              </span>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span className="text-[13px] font-medium text-muted-foreground">Дата документа:</span>
              <div className="w-36">
                <Controller
                  control={control}
                  name="documentDate"
                  render={({ field }) => (
                    <DatePickerInput
                      value={typeof field.value === 'string' ? field.value : ''}
                      onChange={field.onChange}
                      disabled={!canEdit}
                    />
                  )}
                />
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span className="text-[13px] font-medium text-muted-foreground">Статус:</span>
              <div ref={statusMenuRef} className="relative flex items-center gap-1">
                <button
                  type="button"
                  disabled={transitioning || !statusPrevStep || !isEditMode}
                  onClick={() => statusPrevStep && void doTransition(statusPrevStep)}
                  title={statusPrevStep ? invoiceStatusLabel(statusPrevStep) : undefined}
                  className="flex items-center gap-0.5 px-1.5 py-1 rounded text-[12px] text-muted-foreground hover:text-foreground hover:bg-border disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                  <ChevronLeft className="h-3.5 w-3.5 shrink-0" />
                  <span className="max-w-20 truncate">
                    {statusPrevStep ? invoiceStatusLabel(statusPrevStep) : '—'}
                  </span>
                </button>
                <button
                  type="button"
                  disabled={transitioning || !isEditMode}
                  onClick={() => isEditMode && setStatusMenuOpen(o => !o)}
                  title={INVOICE_STATUS_DESCRIPTIONS[currentStatus]}
                  className={cn(
                    'text-sm font-medium px-2.5 py-1 rounded-full transition-colors',
                    STATUS_COLORS[currentStatus] ?? 'bg-secondary text-muted-foreground',
                    isEditMode && !transitioning && 'cursor-pointer hover:opacity-80',
                    !isEditMode && 'cursor-default',
                  )}
                >
                  {isEditMode ? invoiceStatusLabel(currentStatus) : invoiceStatusLabel('DRAFT')}
                </button>
                <button
                  type="button"
                  disabled={transitioning || !statusNextStep || !isEditMode}
                  onClick={() => statusNextStep && void doTransition(statusNextStep)}
                  title={statusNextStep ? invoiceStatusLabel(statusNextStep) : undefined}
                  className="flex items-center gap-0.5 px-1.5 py-1 rounded text-[12px] text-muted-foreground hover:text-foreground hover:bg-border disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                  <span className="max-w-20 truncate">
                    {statusNextStep ? invoiceStatusLabel(statusNextStep) : '—'}
                  </span>
                  <ChevronRight className="h-3.5 w-3.5 shrink-0" />
                </button>
                {statusMenuOpen && allowedTransitions.length > 0 && (
                  <div className="absolute top-full left-0 mt-1 z-50 min-w-40 rounded-lg border border-border bg-surface shadow-lg py-1">
                    {allowedTransitions.map(s => (
                      <button
                        key={s}
                        type="button"
                        disabled={transitioning}
                        onClick={() => {
                          setStatusMenuOpen(false);
                          void doTransition(s);
                        }}
                        className="w-full text-left px-3 py-1.5 text-[13px] hover:bg-border transition-colors disabled:opacity-50"
                      >
                        {TRANSITION_LABELS[s] ?? s}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        }
        extraHeaderActions={
          <div className="flex items-center gap-1">
            {isEditMode && (
              <button
                onClick={() => {
                  minimizeModal({
                    kind: 'modal',
                    label: invoiceNumber || 'Рахунок',
                    modalKey: 'invoice',
                    restoreProps: { invoiceId },
                  });
                  onMinimize?.();
                  onClose();
                }}
                className="rounded p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors duration-150"
                title="Згорнути у вкладку"
                disabled={saving || transitioning}
              >
                <Minus className="h-4 w-4" />
              </button>
            )}
            <button
              onClick={handleModalClose}
              className="rounded p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors duration-150"
              title="Закрити"
              disabled={saving || transitioning}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        }
        footer={
          <div className="flex items-center justify-between w-full gap-2">
            <div>
              {isEditMode && allowedTransitions.includes('CANCELLED') && (
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => doTransition('CANCELLED')}
                  loading={transitioning}
                  disabled={transitioning || saving}
                >
                  Скасувати
                </Button>
              )}
            </div>
            <div className="flex gap-2 items-center flex-wrap">
              {isEditMode && (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => window.print()}
                    disabled={saving || transitioning}
                    title="Друк"
                  >
                    <Printer size={15} className="mr-1" />
                    Друк
                  </Button>
                  <div className="relative">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setSaveAsOpen(v => !v)}
                      disabled={saving || transitioning}
                    >
                      <Download size={15} className="mr-1" />
                      Зберегти як
                      <ChevronDown size={13} className="ml-1" />
                    </Button>
                    {saveAsOpen && (
                      <>
                        <div className="fixed inset-0 z-40" onClick={() => setSaveAsOpen(false)} />
                        <div className="absolute bottom-full mb-1 right-0 z-50 bg-surface border border-border rounded-lg shadow-lg py-1 min-w-35">
                          {(['pdf', 'xlsx', 'docx'] as const).map(fmt => (
                            <button
                              key={fmt}
                              type="button"
                              onClick={() => setSaveAsOpen(false)}
                              className="w-full text-left px-3 py-1.5 text-[13px] hover:bg-border transition-colors"
                            >
                              {fmt === 'pdf'
                                ? 'PDF'
                                : fmt === 'xlsx'
                                  ? 'Excel (.xlsx)'
                                  : 'Word (.docx)'}
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={saving || transitioning}
                    title="Скопіювати посилання"
                  >
                    <Share2 size={15} className="mr-1" />
                    Поділитись
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={saving || transitioning}
                    title="Відправити SMS"
                  >
                    <MessageSquare size={15} className="mr-1" />
                    SMS
                  </Button>
                </>
              )}
              {isEditMode ? (
                canEdit && (
                  <Button
                    onClick={handleSave}
                    loading={saving}
                    disabled={saving || transitioning}
                    size="sm"
                  >
                    Зберегти зміни
                  </Button>
                )
              ) : (
                <Button
                  onClick={handleCreate}
                  loading={saving}
                  disabled={saving || !watchedCounterpartyId}
                  size="sm"
                >
                  Створити рахунок
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={onClose}
                disabled={saving || transitioning}
              >
                Закрити
              </Button>
            </div>
          </div>
        }
      >
        <div className="flex flex-col min-h-[70dvh]">
          {/* ── Collapsible header ─────────────────────────────────────── */}
          <div
            className="grid transition-[grid-template-rows] duration-300 ease-in-out shrink-0"
            style={{ gridTemplateRows: headerCollapsed ? '0fr' : '1fr' }}
          >
            <div className="overflow-hidden">
              <div className="space-y-4 pb-1">
                {loading && (
                  <div className="flex justify-center py-4 text-sm text-muted-foreground">
                    Завантаження…
                  </div>
                )}
                {error && (
                  <div className="text-[13px] text-destructive bg-destructive-subtle border border-destructive/30 rounded-lg px-3 py-2">
                    {error}
                  </div>
                )}

                {/* Рядок 2: Контрагент | Тип */}
                <div className="grid grid-cols-2 gap-4">
                  <EntityPickerField<CpItem>
                    label="Контрагент"
                    required={!isEditMode}
                    display={counterpartyDisplay}
                    placeholder="Пошук контрагента…"
                    className="h-8 text-[13px]"
                    disabled={!canEdit}
                    onPick={() => setCpPickerOpen(true)}
                    onSearch={fetchCpItems}
                    onSearchSelect={item => {
                      setCounterpartyDisplay(item.primary);
                      setValue('counterpartyId', item.id, {
                        shouldDirty: true,
                        shouldValidate: true,
                      });
                    }}
                    onClear={() => {
                      setCounterpartyDisplay('');
                      setValue('counterpartyId', '', { shouldDirty: true });
                    }}
                  />
                  <Select
                    label="Тип рахунку"
                    {...register('invoiceType')}
                    disabled={!canEdit}
                    className="h-8 text-[13px] py-0.5 px-2 pr-7"
                  >
                    {Object.keys(INVOICE_TYPE_LABELS).map(k => (
                      <option key={k} value={k}>
                        {invoiceTypeLabel(k)}
                      </option>
                    ))}
                  </Select>
                </div>

                {/* Рядок 3: Валюта */}
                <div className="grid grid-cols-2 gap-4">
                  <Controller
                    control={control}
                    name="currencyId"
                    render={({ field }) => (
                      <CurrencySelect
                        value={typeof field.value === 'string' ? field.value : ''}
                        onChange={id => field.onChange(id)}
                        disabled={!canEdit}
                      />
                    )}
                  />
                </div>

                {/* Рядок 4: Термін оплати | Примітки */}
                <div className="grid grid-cols-2 gap-4">
                  <Controller
                    control={control}
                    name="dueDate"
                    render={({ field }) => (
                      <DatePickerInput
                        label="Термін оплати"
                        value={typeof field.value === 'string' ? field.value : ''}
                        onChange={field.onChange}
                        disabled={!canEdit}
                      />
                    )}
                  />
                  <Input
                    label="Примітки"
                    {...register('notes')}
                    disabled={!canEdit}
                    placeholder="Додаткова інформація…"
                    className="h-8 text-[13px]"
                  />
                </div>

                {/* Рядок 4: Наряд (тільки в edit mode якщо прив'язаний) */}
                {isEditMode && workOrderNumber && (
                  <div className="grid grid-cols-2 gap-4">
                    <Input
                      label="Наряд"
                      value={workOrderNumber}
                      disabled
                      readOnly
                      className="h-8 text-[13px]"
                    />
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* ── Header toggle strip ──────────────────────────────────────── */}
          <button
            type="button"
            onClick={() => setHeaderCollapsed(c => !c)}
            className={[
              'flex items-center gap-2 w-full py-1.5 px-2 text-[11px]',
              'hover:bg-secondary/60 transition-colors select-none shrink-0',
              'border-t border-border',
            ].join(' ')}
          >
            {headerCollapsed ? (
              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronUp className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className="text-muted-foreground">
              {headerCollapsed ? 'Шапка документа' : 'Шапка документа'}
            </span>
            {headerChips.map((chip, i) => (
              <span
                key={i}
                className="bg-secondary text-muted-foreground rounded px-1.5 py-0.5 text-[10px]"
              >
                {chip}
              </span>
            ))}
          </button>

          {/* ── Lines table ──────────────────────────────────────────────── */}
          <div className="flex-1 overflow-auto">
            <table className="w-full table-fixed text-[12px]">
              <colgroup>
                <col className="w-[50%]" />
                <col className="w-[15%]" />
                <col className="w-[20%]" />
                <col className="w-[15%]" />
              </colgroup>
              <thead>
                <tr className="border-b border-border bg-secondary/40">
                  <th className="text-left px-3 py-2 font-medium text-muted-foreground">ОПИС</th>
                  <th className="text-right px-3 py-2 font-medium text-muted-foreground">К-СТЬ</th>
                  <th className="text-right px-3 py-2 font-medium text-muted-foreground">
                    ЦІНА, {currencySymbol}
                  </th>
                  <th className="text-right px-3 py-2 font-medium text-muted-foreground">
                    СУМА, {currencySymbol}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {fields.map((field, index) => {
                  const line = (watchedLines?.[index] ?? field) as FormLine;
                  return (
                    <tr key={field.id} className="hover:bg-secondary/20 group">
                      <td className="px-3 py-2">{line.description}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{line.quantity}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{line.unitPrice}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        <div className="flex items-center justify-end gap-1">
                          <span>
                            {/* WEB-R3-4: рядкова СУМА збігається з логікою «Разом» — завантажений
                                рядок бере авторитетний lineTotalWithVat (з ПДВ), інакше qty×unitPrice. */}
                            {(line.lineTotalWithVat != null
                              ? line.lineTotalWithVat
                              : (parseFloat(String(line.quantity)) || 0) *
                                (parseFloat(String(line.unitPrice)) || 0)
                            ).toFixed(2)}
                          </span>
                          {canEdit && (
                            <button
                              type="button"
                              onClick={() => removeLine(index)}
                              className="opacity-0 group-hover:opacity-100 ml-1 text-muted-foreground hover:text-destructive transition-all"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}

                {/* Add line input row */}
                {canEdit && showLineInput && (
                  <tr className="bg-primary/5">
                    <td className="px-2 py-1.5">
                      <input
                        autoFocus
                        type="text"
                        value={newLine.description}
                        onChange={e => setNewLine(l => ({ ...l, description: e.target.value }))}
                        onKeyDown={e => {
                          if (e.key === 'Enter') addLine();
                          if (e.key === 'Escape') {
                            setShowLineInput(false);
                            setNewLine(EMPTY_LINE);
                          }
                        }}
                        placeholder="Опис позиції…"
                        className="w-full rounded border border-input bg-background px-2 py-1 text-[12px] focus:outline-none focus:ring-1 focus:ring-ring"
                      />
                    </td>
                    <td className="px-2 py-1.5">
                      <input
                        type="number"
                        min="0.001"
                        step="1"
                        value={newLine.quantity}
                        onChange={e => setNewLine(l => ({ ...l, quantity: e.target.value }))}
                        className="w-full rounded border border-input bg-background px-2 py-1 text-[12px] text-right tabular-nums focus:outline-none focus:ring-1 focus:ring-ring"
                      />
                    </td>
                    <td className="px-2 py-1.5">
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={newLine.unitPrice}
                        onChange={e => setNewLine(l => ({ ...l, unitPrice: e.target.value }))}
                        placeholder="0.00"
                        className="w-full rounded border border-input bg-background px-2 py-1 text-[12px] text-right tabular-nums focus:outline-none focus:ring-1 focus:ring-ring"
                      />
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <span className="tabular-nums text-muted-foreground">
                          {(
                            (parseFloat(newLine.quantity) || 0) *
                            (parseFloat(newLine.unitPrice) || 0)
                          ).toFixed(2)}
                        </span>
                        <button
                          type="button"
                          onClick={addLine}
                          disabled={!newLine.description}
                          className="ml-1 text-primary hover:text-primary/80 disabled:opacity-30"
                        >
                          <Plus className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-border bg-secondary/20">
                  <td
                    colSpan={3}
                    className="px-3 py-2 text-right text-[12px] font-medium text-muted-foreground"
                  >
                    Разом:
                  </td>
                  <td className="px-3 py-2 text-right text-[13px] font-semibold tabular-nums">
                    {total.toFixed(2)} {currencySymbol}
                  </td>
                </tr>
                {isEditMode && paidAmount != null && paidAmount > 0 && (
                  <tr className="bg-success-subtle/40">
                    <td
                      colSpan={3}
                      className="px-3 py-1.5 text-right text-[12px] font-medium text-success"
                    >
                      Оплачено:
                    </td>
                    <td className="px-3 py-1.5 text-right text-[13px] font-semibold tabular-nums text-success">
                      {paidAmount.toFixed(2)} {currencySymbol}
                    </td>
                  </tr>
                )}
                {isEditMode && paidAmount != null && total > 0 && paidAmount < total && (
                  <tr className="bg-secondary/10">
                    <td
                      colSpan={3}
                      className="px-3 py-1.5 text-right text-[12px] font-medium text-muted-foreground"
                    >
                      Залишок:
                    </td>
                    <td className="px-3 py-1.5 text-right text-[13px] font-semibold tabular-nums text-destructive">
                      {(total - paidAmount).toFixed(2)} {currencySymbol}
                    </td>
                  </tr>
                )}
              </tfoot>
            </table>

            {/* Add line button */}
            {canEdit && !showLineInput && (
              <button
                type="button"
                onClick={() => setShowLineInput(true)}
                className="flex items-center gap-1.5 mt-2 ml-3 text-[12px] text-primary hover:text-primary/80 transition-colors"
              >
                <Plus className="h-3.5 w-3.5" />
                Додати позицію
              </button>
            )}
          </div>
        </div>
      </Modal>

      {/* Counterparty picker */}
      <SearchPickerModal<CpItem>
        open={cpPickerOpen}
        onClose={() => setCpPickerOpen(false)}
        title="Оберіть контрагента"
        selectedId={watchedCounterpartyId || ''}
        fetchItems={fetchCpItems}
        searchPlaceholder="Ім'я, телефон, компанія..."
        emptyText="Контрагентів не знайдено"
        onSelect={item => {
          setCounterpartyDisplay(item.primary);
          setValue('counterpartyId', item.id, { shouldDirty: true, shouldValidate: true });
          setCpPickerOpen(false);
        }}
      />
      <DirtyConfirmDialog {...dirty.dialogProps} />
    </>
  );
}
