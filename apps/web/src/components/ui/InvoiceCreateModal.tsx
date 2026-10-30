'use client';

import { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useForm, useFieldArray, Controller } from 'react-hook-form';
import { i18nZodResolver } from '@/lib/i18nZodResolver';
import {
  invoiceFormSchema,
  INVOICE_TYPE_VALUES,
  type InvoiceFormInput,
  type InvoiceFormValues,
} from '@sto/shared';
import { ChevronDown, ChevronUp, Plus, Trash2 } from 'lucide-react';
import { apiFetch } from '@/lib/api-client';
import { DeletedDocumentBanner } from '@/components/ui/DeletedDocumentBanner';
import { toast } from '@/lib/toast';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import { useDirtyForm } from '@/hooks/useDirtyForm';
import { useEscapeLayer } from '@/hooks/useEscapeLayer';
import { DirtyConfirmDialog } from '@/components/ui/dirty-confirm-dialog';
import { cn, displayCounterpartyName, lineAmount, roundMoney } from '@/lib/utils';
import { fmtMoney, kyivToday } from '@/lib/format';
import { linePreviewTotal } from '@/lib/invoice-line-total';
import {
  INVOICE_STATUS_LABELS,
  INVOICE_STATUS_DESCRIPTIONS,
  INVOICE_STATUS_TRANSITIONS,
  INVOICE_TYPE_LABELS,
} from '@sto/shared';
import { invoiceStatusLabel, invoiceTypeLabel } from '@/i18n/enumLabel';
import i18n from '@/i18n/config';
import { Modal } from '@/components/ui/modal';
import {
  DocumentCancelAction,
  DocumentCardHeaderActions,
  DocumentEditActions,
} from '@/components/ui/document-card-actions';
import {
  DocumentHeaderField,
  DocumentNumberField,
  DocumentStatusStepper,
  FormDateInput,
} from '@/components/ui/document-card-header';
import { DocLinesHeader, DocLinesEmptyRow } from '@/components/ui/doc-lines-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { DatePickerInput } from '@/components/ui/date-picker-input';
import { EntityPickerField } from '@/components/ui/entity-picker-field';
import { SearchPickerModal, type SearchPickerItem } from '@/components/ui/search-picker-modal';
import { CurrencySelect } from '@/components/ui/CurrencySelect';
import { useBaseCurrency } from '@/hooks/api/useCash';
import type { Invoice } from '@/hooks/api/useInvoices';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Counterparty {
  id: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  phone?: string | null;
}

// Крок 4 (кодогенерація): `InvoiceDetail` + `InvoiceLine` були четвертою і п'ятою
// копіями InvoiceResponseDto. Копія розходилась із беком у двох місцях:
//   · `counterpartyName?: string | null` — бек віддає `string | undefined`
//     (toDto будує рядок через join, ніколи не null) → `?? '—'` тут був мертвим кодом;
//   · `totalWithoutVat/totalVat/totalWithVat?: number` — у беку ОБОВ'ЯЗКОВІ `number`.
// Тепер тип приходить із @sto/shared через хук useInvoices.
type InvoiceDetail = Invoice;

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
  /** Одиниця рядка з сервера (BR-INV-021: як у наряді, напр. «Пак»); ручний рядок — без неї. */
  unitShortName?: string;
  /** Збережений рядок змінено у формі → PATCH при «Зберегти» (BR-INV-024). */
  _dirty?: boolean;
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

const INVOICE_STATUS_ORDER = Object.keys(INVOICE_STATUS_LABELS);

const EMPTY_TRANSITIONS: readonly string[] = Object.freeze([]);

const nextKey = () =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `k${Math.random().toString(36).slice(2)}`;

const EMPTY_LINE: Omit<LocalLine, '_key'> = { description: '', quantity: '1', unitPrice: '' };

// Поле кількості / ціни рядка в таблиці — те саме, що в рядку нової позиції.
const LINE_INPUT_CLASS =
  'w-full rounded border border-input bg-background px-2 py-1 text-[12px] text-right tabular-nums focus:outline-none focus:ring-1 focus:ring-ring';

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
  const { t } = useTranslation('invoices');
  const isEditMode = !!invoiceId;
  const features = useUiFeatures();
  const dirty = useDirtyForm({ enabled: features.unsavedGuardEnabled });

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
    resolver: i18nZodResolver(invoiceFormSchema),
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
  // Рахунок наряду (BR-INV-019): закривається лише оплатою наряду, ручного «Оплачено» немає.
  const [workOrderLinked, setWorkOrderLinked] = useState(false);
  const [paidAmount, setPaidAmount] = useState<number | null>(null);
  // Збережена сума рахунку (`amount`) — її показує список. Рахунок без рядків (створений сумою через
  // API, РАХ-2026-004310) у картці показував «Разом: 0.00», а в списку — 100,00 ₴.
  const [savedAmount, setSavedAmount] = useState<number | null>(null);
  // Рядки, збережені на сервері (BR-INV-023): без них рахунок не виставляється. Рядки, додані у
  // формі, рахуються лише після «Зберегти» — перехід статусу форму не зберігає.
  const [savedLineCount, setSavedLineCount] = useState(0);
  const [newLine, setNewLine] = useState<Omit<LocalLine, '_key'>>(EMPTY_LINE);
  const [showLineInput, setShowLineInput] = useState(false);
  const [headerCollapsed, setHeaderCollapsed] = useState(false);
  const [statusMenuOpen, setStatusMenuOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [transitioning, setTransitioning] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saveAsOpen, setSaveAsOpen] = useState(false);
  const [error, setError] = useState('');
  const [deletedDocId, setDeletedDocId] = useState<string | null>(null);
  // Id документа, який справді завантажено у форму (Bug #844).
  const [loadedDocId, setLoadedDocId] = useState<string | null>(null);
  const [cpPickerOpen, setCpPickerOpen] = useState(false);

  const savingRef = useRef(false);
  const transitioningRef = useRef(false);
  const statusMenuRef = useRef<HTMLDivElement>(null);
  // snapshot id-шників рядків станом на load — щоб у handleSave виявити
  // рядки які користувач видалив локально (з UI). Без цього DELETE на бекенд не
  // йде і видалені рядки повертаються при наступному перезавантаженні модалки.
  const initialLineIdsRef = useRef<Set<string>>(new Set());
  // Сума рядка без ПДВ станом на завантаження (id → кількість × ціна): змінений рядок показує суму
  // з ПДВ пропорційно новій (`lineTotalWithVat × нова / стара`) — ставка рядка та сама.
  const serverNetRef = useRef<Map<string, number>>(new Map());
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
    setSaveAsOpen(false);
    setHeaderCollapsed(false);
    setInvoiceNumber('');
    setCurrentStatus('DRAFT');
    setWorkOrderNumber(null);
    setWorkOrderLinked(false);
    setPaidAmount(null);
    setSavedAmount(null);
    setSavedLineCount(0);
    setNewLine(EMPTY_LINE);
    setShowLineInput(false);
    initialLineIdsRef.current = new Set();
    serverNetRef.current = new Map();
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
    setLoadedDocId(null);
    apiFetch<InvoiceDetail>(`/invoices/${invoiceId}?withDeleted=true`)
      .then(inv => {
        if (cancelled) return;
        setDeletedDocId(inv.deletedAt ? invoiceId : null);
        setLoadedDocId(invoiceId);
        setInvoiceNumber(inv.number);
        setCurrentStatus(inv.status);
        setWorkOrderNumber(inv.workOrderNumber ?? null);
        setWorkOrderLinked(!!inv.workOrderId);
        setPaidAmount(inv.paidAmount ?? null);
        setSavedAmount(inv.amount ?? null);
        setSavedLineCount(inv.lines?.length ?? 0);
        const loadedLines = (inv.lines ?? []).map(l => ({
          _key: nextKey(),
          id: l.id,
          description: l.description,
          quantity: String(l.quantity),
          unitPrice: String(l.unitPrice),
          lineTotalWithVat: l.priceWithVat, // WEB-R3-4: авторитетна сума з ПДВ для прев'ю «Разом»
          // BR-INV-021: картка показує одиницю рядка — «1» без «Пак» читалось як 1 шт (Bug #941).
          unitShortName: l.unitShortName ?? undefined,
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
        initialLineIdsRef.current = new Set(loadedLines.map(l => l.id).filter(Boolean));
        serverNetRef.current = new Map(
          (inv.lines ?? []).map(l => [l.id, lineAmount(l.quantity, l.unitPrice)] as const),
        );
      })
      .catch(e => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : i18n.t('invoices:card.loadError'));
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
    // BR-CP-001: рахунок виставляється клієнту — API відхиляє постачальника (400), тож і
    // пікер його не пропонує. Як у CreateWorkOrderModal.
    const url = q.trim()
      ? `/counterparties?q=${encodeURIComponent(q.trim())}&types=CLIENT&types=BOTH&limit=30`
      : `/counterparties?types=CLIENT&types=BOTH&limit=30`;
    const data = await apiFetch<{ items: Counterparty[] }>(url);
    return data.items.map(c => ({
      id: c.id,
      primary: displayCounterpartyName(c),
      secondary: c.phone ?? undefined,
    }));
  }, []);

  // ── FSM ───────────────────────────────────────────────────────────────────

  // Документ позначено на видалення → картка лише на перегляд. Прапорець прив'язано до id
  // завантаженого документа, тож інший документ у тій самій модалці його не успадковує.
  const isDeleted = isEditMode && !!invoiceId && deletedDocId === invoiceId;
  // Документ ще не завантажено (або завантаження не вдалось): у формі стоять типові значення
  // «чернетки», а не цей документ. Жодних дій — інакше «Підтвердити» провело б документ, якого
  // користувач не бачить (Bug #844). Разом із «видалено» це дає картку лише на перегляд.
  const notLoaded = isEditMode && loadedDocId !== invoiceId;
  const viewOnly = isDeleted || notLoaded;

  // Видалений документ переходів не має: сервер відповість 404 на будь-яку зміну. Рахунок наряду
  // ручного «Оплачено» не має (BR-INV-019) — його закриває оплата наряду («Оплатити»).
  const allowedTransitions = useMemo(() => {
    if (!isEditMode || viewOnly) return EMPTY_TRANSITIONS;
    const all = INVOICE_STATUS_TRANSITIONS[currentStatus] ?? EMPTY_TRANSITIONS;
    return workOrderLinked ? all.filter(s => s !== 'PAID') : all;
  }, [isEditMode, viewOnly, currentStatus, workOrderLinked]);

  // BR-INV-023: чернетку без рядків не виставити — сервер відповість 400 err.invoice.noLinesToIssue.
  const blockedTransitions = useMemo(
    () =>
      currentStatus === 'DRAFT' && savedLineCount === 0
        ? { SENT: t('card.noLinesToIssue') }
        : undefined,
    [currentStatus, savedLineCount, t],
  );

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
  }, [currentStatus, allowedTransitions]);

  const doTransition = async (newStatus: string) => {
    // Стрілки ◀/▶ лежать у тому ж контейнері, що й меню: клік по них меню не закриває, а відкрите
    // меню під підтвердженням з'їло б його перший Escape.
    setStatusMenuOpen(false);
    if (!invoiceId || viewOnly) return;
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
      setError(e instanceof Error ? e.message : t('card.transitionError'));
    } finally {
      setTransitioningBoth(false);
    }
  };

  // ── Lines ─────────────────────────────────────────────────────────────────

  // WEB-R3-4: прев'ю «Разом» бере авторитетну суму рядка з ПДВ (lineTotalWithVat) якщо вона відома
  // (завантажений рахунок) — усуває заниження для EXCLUSIVE та подвоєння для INCLUSIVE. Нові ручні
  // рядки (ще без backend-розрахунку) → qty×unitPrice без ПДВ; backend додасть ПДВ при збереженні.
  // BR-INV-017: сума рядка округлена до копійки (`lineAmount`), як її пише сервер, а «Разом» —
  // сума округлених рядків: сирий добуток давав 0,3 × 100,05 = «30.01» замість 30.02 і три рядки
  // 0,3 × 111,11 = «100.00» замість 99.99 (клас Bug #811).
  const total = useMemo(
    () =>
      roundMoney(
        (watchedLines ?? []).reduce(
          (sum, l) => sum + linePreviewTotal(l as LocalLine, serverNetRef.current),
          0,
        ),
      ),
    [watchedLines],
  );
  // Без жодного рядка — збережена сума документа (те, що показує список і що оплачують);
  // щойно рядки є, «Разом» рахується з них.
  const shownTotal = (watchedLines?.length ?? 0) === 0 && savedAmount != null ? savedAmount : total;

  const addLine = () => {
    if (!newLine.description) return;
    append({ ...newLine, _key: nextKey() });
    setNewLine(EMPTY_LINE);
    setShowLineInput(false);
  };

  const removeLine = (index: number) => remove(index);

  // Збережений рядок змінено у формі → PATCH при «Зберегти» (BR-INV-024). Новий рядок (без id) і так
  // іде POST-ом з поточними значеннями.
  const markLineDirty = (index: number) => {
    const line = getValues(`lines.${index}`) as FormLine | undefined;
    if (line?.id && !line._dirty) setValue(`lines.${index}._dirty`, true);
  };

  // ── Save / Create ─────────────────────────────────────────────────────────

  const canEdit = isEditMode ? currentStatus === 'DRAFT' && !viewOnly : true;

  // Тип рядка у field-array (форм-схема + локальні _key/id/lineTotalWithVat).
  type FormLine = {
    _key?: string;
    id?: string;
    _dirty?: boolean;
    description: string;
    quantity: string;
    unitPrice: string;
    lineTotalWithVat?: number;
    unitShortName?: string;
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
      const computedTotal = roundMoney(
        linesToPost.reduce(
          (s, l) =>
            s +
            lineAmount(parseFloat(String(l.quantity)) || 0, parseFloat(String(l.unitPrice)) || 0),
          0,
        ),
      );
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
        const line = remaining[0];
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
      if (features.toastEnabled) toast.success(t('toast.invoiceCreatedNo', { number: inv.number }));
      dirty.resetDirty();
      onSaved?.();
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('card.createError'));
    } finally {
      setSavingBoth(false);
    }
  });

  const handleSave = handleSubmit(async (values: InvoiceFormValues) => {
    // Ctrl+Enter у модалці кличе цей самий обробник — видалений документ не зберігаємо.
    if (!invoiceId || viewOnly) return;
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
      // BR-INV-024 (як BR-WO-035 наряду): спершу додати й змінити рядки, видалити — останнім. Навпаки
      // заміна рядка давала проміжну суму рахунку без нього, а збій посередині лишав рахунок без
      // рядків. Усе послідовно: кожен запит перераховує суми рахунку (`recalcTotals` без транзакції).
      // POST нових рядків (без id). Bug #755: на ретраї пропускаємо вже збережені _key — інакше
      // повторний «Зберегти» задвоював нові рядки.
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
      // PATCH збережених рядків, змінених у формі. Після помилки прапорець лишається — повторне
      // «Зберегти» шле ті самі значення ще раз (PATCH ідемпотентний).
      for (const line of linesNow.filter(l => !!l.id && l._dirty)) {
        await apiFetch(`/invoices/${invoiceId}/lines/${line.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            quantity: parseFloat(String(line.quantity)) || 1,
            unitPrice: parseFloat(String(line.unitPrice)) || 0,
          }),
        });
      }
      // DELETE рядків, прибраних локально (є у initialLineIdsRef, немає серед поточних id). Відмова
      // одного не зупиняє решту (як allSettled), невидалені лишаються на повтор, помилка — у картці.
      const currentIds = new Set(linesNow.map(l => l.id).filter(Boolean) as string[]);
      const removedIds = [...initialLineIdsRef.current].filter(id => !currentIds.has(id));
      let deleteFailure: Error | null = null;
      for (const lineId of removedIds) {
        try {
          await apiFetch(`/invoices/${invoiceId}/lines/${lineId}`, { method: 'DELETE' });
          initialLineIdsRef.current.delete(lineId);
        } catch (e: unknown) {
          deleteFailure ??= e instanceof Error ? e : new Error(t('card.saveError'));
        }
      }
      if (deleteFailure) throw deleteFailure;
      postedLineKeysRef.current = new Set();

      if (features.toastEnabled) toast.success(t('toast.invoiceSaved'));
      dirty.resetDirty();
      onSaved?.();
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('card.saveError'));
    } finally {
      setSavingBoth(false);
    }
  });

  // Меню статусу й «Зберегти як» — шари над карткою: Escape закриває лише їх (Bug #932, клас Bug #924).
  // Меню видно лише за наявності переходів: інакше перехоплювач «ковтав» би Escape без меню.
  const statusMenuShown = statusMenuOpen && allowedTransitions.length > 0;
  useEscapeLayer(statusMenuShown, () => setStatusMenuOpen(false));
  useEscapeLayer(saveAsOpen, () => setSaveAsOpen(false));
  // Escape в описі нової позиції скасовує лише її, а не закриває рахунок.
  const newLineInputRef = useRef<HTMLInputElement>(null);
  useEscapeLayer(
    canEdit && showLineInput,
    () => {
      setShowLineInput(false);
      setNewLine(EMPTY_LINE);
    },
    newLineInputRef,
  );
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
          watchedDueDate ? t('card.dueChip', { date: watchedDueDate }) : null,
        ].filter(Boolean)
      : [];

  return (
    <>
      {/* (А) handleSave/handleCreate — це handleSubmit() з try/catch + setError,
          doTransition так само, а handleModalClose лише очікує confirmClose()
          (ніколи не реджектиться). Проміси нікому не потрібні → `void`. */}
      <Modal
        open={open}
        onClose={() => void handleModalClose()}
        onSubmit={() => void handleSave()}
        title={isEditMode ? t('card.title') : t('card.titleNew')}
        size="content"
        hideClose
        headerContent={
          <div className="flex items-center gap-6">
            <DocumentNumberField
              label={t('card.number')}
              value={isEditMode && invoiceNumber ? invoiceNumber : t('card.autoNumber')}
            />
            <DocumentHeaderField label={t('card.documentDate')}>
              <FormDateInput control={control} name="documentDate" disabled={!canEdit} />
            </DocumentHeaderField>
            <DocumentStatusStepper
              stepLabel={invoiceStatusLabel}
              label={t('card.status')}
              menuRef={statusMenuRef}
              active={isEditMode}
              busy={transitioning}
              locked={viewOnly}
              prev={statusPrevStep}
              statusLabel={
                isEditMode ? invoiceStatusLabel(currentStatus) : invoiceStatusLabel('DRAFT')
              }
              next={statusNextStep}
              onStep={s => void doTransition(s)}
              menuShown={statusMenuShown}
              setMenuOpen={setStatusMenuOpen}
              transitions={allowedTransitions}
              transitionLabel={s => t(`card.transition.${s}`, { defaultValue: s })}
              statusColor={STATUS_COLORS[currentStatus] ?? 'bg-secondary text-muted-foreground'}
              statusTitle={t(`card.statusDescription.${currentStatus}`, {
                defaultValue: INVOICE_STATUS_DESCRIPTIONS[currentStatus],
              })}
              stepTitles
              blocked={blockedTransitions}
            />
          </div>
        }
        extraHeaderActions={
          <DocumentCardHeaderActions
            minimizeLabel={t('card.minimize')}
            onMinimize={onMinimize}
            closeCard={onClose}
            onClose={() => void handleModalClose()}
            disabled={saving || transitioning}
            minimize={
              isEditMode && !notLoaded
                ? {
                    label: invoiceNumber || t('card.minimizedLabel'),
                    modalKey: 'invoice',
                    restoreProps: { invoiceId },
                  }
                : null
            }
          />
        }
        footer={
          <div className="flex items-center justify-between w-full gap-2">
            <div>
              <DocumentCancelAction
                label={t('actions.cancelInvoice')}
                transitions={allowedTransitions}
                onTransition={doTransition}
                busy={transitioning}
                saving={saving}
              />
            </div>
            <div className="flex gap-2 items-center flex-wrap">
              {/* Незнайдений документ (notLoaded) друкувати й зберігати нічого (TECH-DEBT §9 п.4);
                  видалений — друкується, як і досі. */}
              {isEditMode ? (
                <DocumentEditActions
                  save={canEdit ? { label: t('card.saveChanges'), onSave: handleSave } : null}
                  showFile={!notLoaded}
                  showShare={!viewOnly}
                  labels={{
                    print: t('actions.print'),
                    saveAs: t('card.saveAs'),
                    share: t('card.share'),
                    shareTitle: t('card.shareTitle'),
                    smsTitle: t('card.smsTitle'),
                  }}
                  saveAsOpen={saveAsOpen}
                  setSaveAsOpen={setSaveAsOpen}
                  saving={saving}
                  busy={transitioning}
                />
              ) : (
                <Button
                  onClick={() => void handleCreate()}
                  loading={saving}
                  disabled={saving || !watchedCounterpartyId}
                  size="sm"
                >
                  {t('card.create')}
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                // Як Escape і «×»: незбережені зміни — спершу підтвердження (useDirtyForm).
                onClick={() => void handleModalClose()}
                disabled={saving || transitioning}
              >
                {t('common:close')}
              </Button>
            </div>
          </div>
        }
      >
        <div className="flex flex-col min-h-[70dvh]">
          {isDeleted && <DeletedDocumentBanner className="mb-3 shrink-0" />}
          {/* ── Collapsible header ─────────────────────────────────────── */}
          <div
            className="grid transition-[grid-template-rows] duration-300 ease-in-out shrink-0"
            style={{ gridTemplateRows: headerCollapsed ? '0fr' : '1fr' }}
          >
            <div className="overflow-hidden">
              <div className="space-y-4 pb-1">
                {loading && (
                  <div className="flex justify-center py-4 text-sm text-muted-foreground">
                    {t('common:loading')}
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
                    label={t('columns.counterparty')}
                    required={!isEditMode}
                    display={counterpartyDisplay}
                    placeholder={t('card.counterpartyPlaceholder')}
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
                    label={t('card.invoiceType')}
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
                        // Bug #639-клас: авто-дефолт базової валюти — програмна зміна, не дія
                        // користувача → shouldDirty:false, щоб незаймана модалка не вважалась брудною
                        // (інакше Escape на щойно відкритій формі показує «Є незбережені зміни»).
                        onAutoDefault={id => setValue('currencyId', id, { shouldDirty: false })}
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
                        label={t('columns.dueDate')}
                        value={typeof field.value === 'string' ? field.value : ''}
                        onChange={field.onChange}
                        disabled={!canEdit}
                      />
                    )}
                  />
                  <Input
                    label={t('card.notes')}
                    {...register('notes')}
                    disabled={!canEdit}
                    placeholder={t('card.notesPlaceholder')}
                    className="h-8 text-[13px]"
                  />
                </div>

                {/* Рядок 4: Наряд (тільки в edit mode якщо прив'язаний) */}
                {isEditMode && workOrderNumber && (
                  <div className="grid grid-cols-2 gap-4">
                    <Input
                      label={t('columns.workOrder')}
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
            <span className="text-muted-foreground">{t('common:documentHeader')}</span>
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
            <DocLinesHeader
              title={t('panel.tabLines')}
              onAdd={canEdit && !showLineInput ? () => setShowLineInput(true) : undefined}
            />
            <table className="w-full table-fixed text-[12px]">
              <colgroup>
                <col className="w-[50%]" />
                <col className="w-[15%]" />
                <col className="w-[20%]" />
                <col className="w-[15%]" />
              </colgroup>
              <thead>
                <tr className="border-b border-border bg-secondary/40">
                  <th className="text-left px-3 py-2 font-medium text-muted-foreground">
                    {t('card.colDescription')}
                  </th>
                  <th className="text-right px-3 py-2 font-medium text-muted-foreground">
                    {t('card.colQty')}
                  </th>
                  <th className="text-right px-3 py-2 font-medium text-muted-foreground">
                    {t('card.colPrice', { sym: currencySymbol })}
                  </th>
                  <th className="text-right px-3 py-2 font-medium text-muted-foreground">
                    {t('card.colSum', { sym: currencySymbol })}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {/* Незавантажений документ (notLoaded) підказки не має: рядків ми ще не знаємо. */}
                {fields.length === 0 && !showLineInput && !notLoaded && (
                  <DocLinesEmptyRow colSpan={4} canEdit={canEdit} />
                )}
                {fields.map((field, index) => {
                  const line = (watchedLines?.[index] ?? field) as FormLine;
                  const lineErrors = errors.lines?.[index];
                  return (
                    <tr key={field.id} className="hover:bg-secondary/20 group">
                      <td className="px-3 py-2">{line.description}</td>
                      {canEdit ? (
                        <>
                          {/* BR-INV-024: кількість і ціну рядка чернетки правлять на місці —
                              збережений рядок іде PATCH-ем (`_dirty`), а не видаленням і новим. */}
                          <td className="px-2 py-1.5">
                            <div className="flex items-center justify-end gap-1">
                              <input
                                type="number"
                                min="0.001"
                                step="1"
                                {...register(`lines.${index}.quantity`, {
                                  onChange: () => markLineDirty(index),
                                })}
                                aria-label={t('card.lineQtyAria', { name: line.description })}
                                aria-invalid={lineErrors?.quantity ? true : undefined}
                                className={cn(
                                  LINE_INPUT_CLASS,
                                  lineErrors?.quantity && 'border-destructive',
                                )}
                              />
                              {line.unitShortName && (
                                <span className="text-muted-foreground">{line.unitShortName}</span>
                              )}
                            </div>
                          </td>
                          <td className="px-2 py-1.5">
                            <input
                              type="number"
                              min="0"
                              step="0.01"
                              {...register(`lines.${index}.unitPrice`, {
                                onChange: () => markLineDirty(index),
                              })}
                              aria-label={t('card.linePriceAria', { name: line.description })}
                              aria-invalid={lineErrors?.unitPrice ? true : undefined}
                              className={cn(
                                LINE_INPUT_CLASS,
                                lineErrors?.unitPrice && 'border-destructive',
                              )}
                            />
                          </td>
                        </>
                      ) : (
                        <>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {line.quantity}
                            {line.unitShortName && (
                              <span className="ml-1 text-muted-foreground">
                                {line.unitShortName}
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">{line.unitPrice}</td>
                        </>
                      )}
                      <td className="px-3 py-2 text-right tabular-nums">
                        <div className="flex items-center justify-end gap-1">
                          <span data-testid="invoice-line-sum">
                            {/* WEB-R3-4: рядкова СУМА збігається з логікою «Разом» (linePreviewTotal). */}
                            {fmtMoney(linePreviewTotal(line, serverNetRef.current))}
                          </span>
                          {canEdit && (
                            <button
                              type="button"
                              onClick={() => removeLine(index)}
                              aria-label={t('card.removeLineAria', { name: line.description })}
                              className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 ml-1 text-muted-foreground hover:text-destructive transition-all"
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
                        ref={newLineInputRef}
                        autoFocus
                        type="text"
                        value={newLine.description}
                        onChange={e => setNewLine(l => ({ ...l, description: e.target.value }))}
                        onKeyDown={e => {
                          if (e.key === 'Enter') addLine();
                        }}
                        placeholder={t('card.linePlaceholder')}
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
                          {fmtMoney(
                            lineAmount(
                              parseFloat(newLine.quantity) || 0,
                              parseFloat(newLine.unitPrice) || 0,
                            ),
                          )}
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
                    {t('card.total')}
                  </td>
                  <td className="px-3 py-2 text-right text-[13px] font-semibold tabular-nums">
                    {fmtMoney(shownTotal)} {currencySymbol}
                  </td>
                </tr>
                {isEditMode && paidAmount != null && paidAmount > 0 && (
                  <tr className="bg-success-subtle/40">
                    <td
                      colSpan={3}
                      className="px-3 py-1.5 text-right text-[12px] font-medium text-success"
                    >
                      {t('card.paid')}
                    </td>
                    <td className="px-3 py-1.5 text-right text-[13px] font-semibold tabular-nums text-success">
                      {fmtMoney(paidAmount)} {currencySymbol}
                    </td>
                  </tr>
                )}
                {isEditMode && paidAmount != null && shownTotal > 0 && paidAmount < shownTotal && (
                  <tr className="bg-secondary/10">
                    <td
                      colSpan={3}
                      className="px-3 py-1.5 text-right text-[12px] font-medium text-muted-foreground"
                    >
                      {t('card.remaining')}
                    </td>
                    <td className="px-3 py-1.5 text-right text-[13px] font-semibold tabular-nums text-destructive">
                      {fmtMoney(roundMoney(shownTotal - paidAmount))} {currencySymbol}
                    </td>
                  </tr>
                )}
              </tfoot>
            </table>
          </div>
        </div>
      </Modal>

      {/* Counterparty picker */}
      <SearchPickerModal<CpItem>
        open={cpPickerOpen}
        onClose={() => setCpPickerOpen(false)}
        title={t('card.pickCounterparty')}
        selectedId={watchedCounterpartyId || ''}
        fetchItems={fetchCpItems}
        searchPlaceholder={t('card.pickCounterpartySearch')}
        emptyText={t('card.pickCounterpartyEmpty')}
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
