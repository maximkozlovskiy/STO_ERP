'use client';

import { useCallback, useEffect, useRef, useState, useMemo } from 'react';
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
} from 'lucide-react';
import { apiFetch } from '@/lib/api-client';
import { toast } from '@/lib/toast';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import { useTabBarContext } from '@/contexts/TabBarContext';
import { displayCounterpartyName, cn } from '@/lib/utils';
import { kyivToday } from '@/lib/format';
import {
  INVOICE_STATUS_LABELS,
  INVOICE_STATUS_DESCRIPTIONS,
  INVOICE_STATUS_TRANSITIONS,
  INVOICE_TYPE_LABELS,
} from '@sto/shared';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { DatePickerInput } from '@/components/ui/date-picker-input';
import { EntityPickerField } from '@/components/ui/entity-picker-field';
import { SearchPickerModal, type SearchPickerItem } from '@/components/ui/search-picker-modal';

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
}

// ─── Constants ────────────────────────────────────────────────────────────────

// Must stay in sync with INVOICE_STATUS_BADGE in @sto/shared.
const STATUS_COLORS: Record<string, string> = {
  DRAFT: 'bg-secondary text-muted-foreground',
  SENT: 'bg-info-subtle text-info-text',
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
  const { minimizeModal } = useTabBarContext();

  const [form, setForm] = useState({
    counterpartyId: '',
    invoiceType: 'STANDARD',
    dueDate: '',
    documentDate: kyivToday(),
    notes: '',
  });
  const [counterpartyDisplay, setCounterpartyDisplay] = useState('');
  const [currentStatus, setCurrentStatus] = useState('DRAFT');
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [workOrderNumber, setWorkOrderNumber] = useState<string | null>(null);
  const [paidAmount, setPaidAmount] = useState<number | null>(null);
  const [lines, setLines] = useState<LocalLine[]>([]);
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
  // Bug #461: snapshot id-шників рядків станом на load — щоб у handleSave виявити
  // рядки які користувач видалив локально (з UI). Без цього DELETE на бекенд не
  // йде і видалені рядки повертаються при наступному перезавантаженні модалки.
  const initialLineIdsRef = useRef<Set<string>>(new Set());

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
    setError('');
    setStatusMenuOpen(false);
    setHeaderCollapsed(false);
    setInvoiceNumber('');
    setCurrentStatus('DRAFT');
    setWorkOrderNumber(null);
    setPaidAmount(null);
    setLines([]);
    setNewLine(EMPTY_LINE);
    setShowLineInput(false);
    initialLineIdsRef.current = new Set();
    if (!isEditMode) {
      setForm({
        counterpartyId: '',
        invoiceType: 'STANDARD',
        dueDate: '',
        documentDate: kyivToday(),
        notes: '',
      });
      setCounterpartyDisplay('');
    }
  }, [open, invoiceId]);

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
        setForm({
          counterpartyId: inv.counterpartyId ?? '',
          invoiceType: inv.invoiceType ?? 'STANDARD',
          dueDate: inv.dueDate ? inv.dueDate.slice(0, 10) : '',
          documentDate: inv.documentDate ? inv.documentDate.slice(0, 10) : kyivToday(),
          notes: inv.notes ?? '',
        });
        setCounterpartyDisplay(inv.counterpartyName ?? '');
        const loadedLines = (inv.lines ?? []).map(l => ({
          _key: nextKey(),
          id: l.id,
          description: l.description,
          quantity: String(l.quantity),
          unitPrice: String(l.unitPrice),
        }));
        setLines(loadedLines);
        // Bug #461: запам'ятати початковий набір id-шників. handleSave порівняє з поточним
        // станом і пошле DELETE для тих що зникли (користувач натиснув removeLine).
        initialLineIdsRef.current = new Set(loadedLines.map(l => l.id!).filter(Boolean));
      })
      .catch(e => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Помилка завантаження рахунку');
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
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

  const total = useMemo(
    () =>
      lines.reduce((sum, l) => {
        const qty = parseFloat(l.quantity) || 0;
        const price = parseFloat(l.unitPrice) || 0;
        return sum + qty * price;
      }, 0),
    [lines],
  );

  const addLine = () => {
    if (!newLine.description) return;
    setLines(prev => [...prev, { ...newLine, _key: nextKey() }]);
    setNewLine(EMPTY_LINE);
    setShowLineInput(false);
  };

  const removeLine = (key: string) => setLines(prev => prev.filter(l => l._key !== key));

  // ── Save / Create ─────────────────────────────────────────────────────────

  const canEdit = isEditMode ? currentStatus === 'DRAFT' : true;

  const handleCreate = async () => {
    setSavingBoth(true);
    setError('');
    try {
      // Auto-flush pending line
      const pendingLine = newLine.description ? { ...newLine, _key: nextKey() } : null;
      const linesToPost = pendingLine ? [...lines, pendingLine] : lines;
      if (pendingLine) {
        setLines(linesToPost);
        setNewLine(EMPTY_LINE);
      }

      // Bug #463: розрахувати total з рядків і передати у POST замість 0.01 placeholder.
      // Backend `addLine` потім перерахує точно з ПДВ через recalcTotals, але якщо
      // мережа впала між POST /invoices і POST /lines — invoice не залишається з
      // нерелевантним amount=0.01.
      const computedTotal = linesToPost.reduce((s, l) => {
        const qty = parseFloat(l.quantity) || 0;
        const price = parseFloat(l.unitPrice) || 0;
        return s + qty * price;
      }, 0);
      const inv = await apiFetch<{ id: string; number: string }>('/invoices', {
        method: 'POST',
        body: JSON.stringify({
          counterpartyId: form.counterpartyId || undefined,
          invoiceType: form.invoiceType || undefined,
          amount: computedTotal >= 0.01 ? computedTotal : 0.01,
          dueDate: form.dueDate || undefined,
          documentDate: form.documentDate || undefined,
          notes: form.notes || undefined,
        }),
      });

      for (const line of linesToPost) {
        await apiFetch(`/invoices/${inv.id}/lines`, {
          method: 'POST',
          body: JSON.stringify({
            description: line.description,
            quantity: parseFloat(line.quantity) || 1,
            unitPrice: parseFloat(line.unitPrice) || 0,
          }),
        });
      }

      if (features.toastEnabled) toast.success(`Рахунок ${inv.number} створено`);
      onSaved?.();
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка створення рахунку');
    } finally {
      setSavingBoth(false);
    }
  };

  const handleSave = async () => {
    if (!invoiceId) return;
    setSavingBoth(true);
    setError('');
    try {
      await apiFetch(`/invoices/${invoiceId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          counterpartyId: form.counterpartyId || undefined,
          invoiceType: form.invoiceType || undefined,
          dueDate: form.dueDate || undefined,
          documentDate: form.documentDate || undefined,
          notes: form.notes || undefined,
        }),
      });

      // Bug #461: видалити рядки що були у початковому списку але користувач
      // прибрав через removeLine. Без цього бекенд лишає їх у БД.
      const currentIds = new Set(lines.map(l => l.id).filter(Boolean) as string[]);
      const removedIds = [...initialLineIdsRef.current].filter(id => !currentIds.has(id));
      for (const lineId of removedIds) {
        await apiFetch(`/invoices/${invoiceId}/lines/${lineId}`, { method: 'DELETE' });
      }

      // Post new lines (those without id)
      for (const line of lines.filter(l => !l.id)) {
        await apiFetch(`/invoices/${invoiceId}/lines`, {
          method: 'POST',
          body: JSON.stringify({
            description: line.description,
            quantity: parseFloat(line.quantity) || 1,
            unitPrice: parseFloat(line.unitPrice) || 0,
          }),
        });
      }

      if (features.toastEnabled) toast.success('Рахунок збережено');
      onSaved?.();
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка збереження');
    } finally {
      setSavingBoth(false);
    }
  };

  const handleModalClose = useCallback(() => {
    if (savingRef.current || transitioningRef.current) return;
    onClose();
  }, [onClose]);

  // ── Render ────────────────────────────────────────────────────────────────

  const headerChips =
    isEditMode && headerCollapsed
      ? [
          form.invoiceType ? (INVOICE_TYPE_LABELS[form.invoiceType] ?? form.invoiceType) : null,
          counterpartyDisplay || null,
          form.dueDate ? `до ${form.dueDate}` : null,
        ].filter(Boolean)
      : [];

  return (
    <>
      <Modal
        open={open}
        onClose={handleModalClose}
        title={isEditMode ? invoiceNumber || 'Рахунок' : 'Новий рахунок'}
        size="content"
        hideClose
        extraHeaderActions={
          isEditMode ? (
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
          ) : undefined
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
                  disabled={saving || !form.counterpartyId}
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

                {/* Рядок 1: Номер | Дата документа | Статус */}
                <div className="grid grid-cols-3 gap-4">
                  <Input
                    label="Номер"
                    value={
                      isEditMode && invoiceNumber ? invoiceNumber : '— присвоюється автоматично —'
                    }
                    disabled
                    readOnly
                    className="h-8 text-[13px]"
                  />
                  <DatePickerInput
                    label="Дата документа"
                    value={form.documentDate}
                    onChange={v => setForm(f => ({ ...f, documentDate: v }))}
                    disabled={!canEdit}
                  />
                  <div>
                    <label className="block text-[13px] font-medium text-foreground mb-1">
                      Статус
                    </label>
                    <div ref={statusMenuRef} className="relative flex items-center gap-1">
                      <button
                        type="button"
                        disabled={transitioning || !statusPrevStep}
                        onClick={() => statusPrevStep && void doTransition(statusPrevStep)}
                        className="flex items-center gap-0.5 px-1.5 py-1 rounded text-[12px] text-muted-foreground hover:text-foreground hover:bg-border disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                        title={statusPrevStep ? INVOICE_STATUS_LABELS[statusPrevStep] : undefined}
                      >
                        <ChevronLeft className="h-3.5 w-3.5 shrink-0" />
                        <span className="max-w-20 truncate">
                          {statusPrevStep
                            ? (INVOICE_STATUS_LABELS[statusPrevStep] ?? statusPrevStep)
                            : '—'}
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
                        {INVOICE_STATUS_LABELS[currentStatus] ?? currentStatus}
                      </button>
                      <button
                        type="button"
                        disabled={transitioning || !statusNextStep}
                        onClick={() => statusNextStep && void doTransition(statusNextStep)}
                        className="flex items-center gap-0.5 px-1.5 py-1 rounded text-[12px] text-muted-foreground hover:text-foreground hover:bg-border disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                        title={statusNextStep ? INVOICE_STATUS_LABELS[statusNextStep] : undefined}
                      >
                        <span className="max-w-20 truncate">
                          {statusNextStep
                            ? (INVOICE_STATUS_LABELS[statusNextStep] ?? statusNextStep)
                            : '—'}
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

                {/* Рядок 2: Контрагент | Тип */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-[13px] font-medium text-foreground mb-1">
                      Контрагент {!isEditMode && <span className="text-destructive">*</span>}
                    </label>
                    <EntityPickerField<CpItem>
                      display={counterpartyDisplay}
                      placeholder="Пошук контрагента…"
                      className="h-8 text-[13px]"
                      disabled={!canEdit}
                      onPick={() => setCpPickerOpen(true)}
                      onSearch={fetchCpItems}
                      onSearchSelect={item => {
                        setCounterpartyDisplay(item.primary);
                        setForm(f => ({ ...f, counterpartyId: item.id }));
                      }}
                      onClear={() => {
                        setCounterpartyDisplay('');
                        setForm(f => ({ ...f, counterpartyId: '' }));
                      }}
                    />
                  </div>
                  <Select
                    label="Тип рахунку"
                    value={form.invoiceType}
                    onChange={e => setForm(f => ({ ...f, invoiceType: e.target.value }))}
                    disabled={!canEdit}
                    className="h-8 text-[13px] py-0.5 px-2 pr-7"
                  >
                    {Object.entries(INVOICE_TYPE_LABELS).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                  </Select>
                </div>

                {/* Рядок 3: Термін оплати | Примітки */}
                <div className="grid grid-cols-2 gap-4">
                  <DatePickerInput
                    label="Термін оплати"
                    value={form.dueDate}
                    onChange={v => setForm(f => ({ ...f, dueDate: v }))}
                    disabled={!canEdit}
                  />
                  <Input
                    label="Примітки"
                    value={form.notes}
                    onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
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
                    ЦІНА, ₴
                  </th>
                  <th className="text-right px-3 py-2 font-medium text-muted-foreground">
                    СУМА, ₴
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {lines.map(line => (
                  <tr key={line._key} className="hover:bg-secondary/20 group">
                    <td className="px-3 py-2">{line.description}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{line.quantity}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{line.unitPrice}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      <div className="flex items-center justify-end gap-1">
                        <span>
                          {(
                            (parseFloat(line.quantity) || 0) * (parseFloat(line.unitPrice) || 0)
                          ).toFixed(2)}
                        </span>
                        {canEdit && (
                          <button
                            type="button"
                            onClick={() => removeLine(line._key)}
                            className="opacity-0 group-hover:opacity-100 ml-1 text-muted-foreground hover:text-destructive transition-all"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}

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
                    {total.toFixed(2)} ₴
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
                      {paidAmount.toFixed(2)} ₴
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
                      {(total - paidAmount).toFixed(2)} ₴
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
        selectedId={form.counterpartyId}
        fetchItems={fetchCpItems}
        searchPlaceholder="Ім'я, телефон, компанія..."
        emptyText="Контрагентів не знайдено"
        onSelect={item => {
          setCounterpartyDisplay(item.primary);
          setForm(f => ({ ...f, counterpartyId: item.id }));
          setCpPickerOpen(false);
        }}
      />
    </>
  );
}
