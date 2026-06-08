'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import { displayCounterpartyName } from '@/lib/utils';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DatePickerInput } from '@/components/ui/date-picker-input';
import { EntityPickerField } from '@/components/ui/entity-picker-field';
import { SearchPickerModal, type SearchPickerItem } from '@/components/ui/search-picker-modal';
import {
  CounterpartyEditModal,
  type CounterpartyForModal,
} from '@/components/ui/CounterpartyEditModal';
import { DirtyConfirmDialog } from '@/components/ui/dirty-confirm-dialog';
import { useDirtyForm } from '@/hooks/useDirtyForm';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import type { Invoice } from '@/hooks/api/useInvoices';
import { kyivToday } from '@/lib/format';

// ─── Types ───────────────────────────────────────────────────────────────────

interface Counterparty {
  id: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  phone?: string | null;
}

// ─── Props ───────────────────────────────────────────────────────────────────

interface InvoiceCreateModalProps {
  open: boolean;
  onClose: () => void;
  /** Called after an invoice is successfully created. */
  onSaved: (inv: Invoice) => void;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function InvoiceCreateModal({ open, onClose, onSaved }: InvoiceCreateModalProps) {
  const features = useUiFeatures();
  const dirty = useDirtyForm({ enabled: features.unsavedGuardEnabled });

  const [form, setForm] = useState({
    counterpartyId: '',
    amount: '',
    dueDate: '',
    documentDate: kyivToday(),
  });
  const [counterpartyDisplay, setCounterpartyDisplay] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Counterparty picker / detail
  const [cpPickerOpen, setCpPickerOpen] = useState(false);
  const [cpDetailOpen, setCpDetailOpen] = useState(false);
  const [cpDetailData, setCpDetailData] = useState<CounterpartyForModal | null>(null);

  const resetForm = useCallback(() => {
    setForm({
      counterpartyId: '',
      amount: '',
      dueDate: '',
      documentDate: kyivToday(),
    });
    setCounterpartyDisplay('');
    setError('');
    dirty.resetDirty();
  }, [dirty]);

  // Reset documentDate to today whenever modal opens
  useEffect(() => {
    if (open) {
      setForm(f => ({ ...f, documentDate: kyivToday() }));
      setError('');
    }
  }, [open]);

  // ── Counterparty handlers ──────────────────────────────────────────────────

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
      phone: c.phone ?? null,
    }));
  }, []);

  const openCpDetail = useCallback(async () => {
    if (!form.counterpartyId) return;
    try {
      const cp = await apiFetch<CounterpartyForModal>(`/counterparties/${form.counterpartyId}`);
      setCpDetailData(cp);
      setCpDetailOpen(true);
    } catch {
      /* ignore */
    }
  }, [form.counterpartyId]);

  // ── Save ───────────────────────────────────────────────────────────────────

  const handleCreate = async () => {
    const amt = parseFloat(form.amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      setError('Введіть коректну суму');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const created = await apiFetch<Invoice>('/invoices', {
        method: 'POST',
        body: JSON.stringify({
          counterpartyId: form.counterpartyId,
          amount: amt,
          dueDate: form.dueDate || undefined,
          documentDate: form.documentDate || undefined,
        }),
      });
      dirty.resetDirty();
      onSaved(created);
      resetForm();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка збереження');
    } finally {
      setSaving(false);
    }
  };

  const handleClose = useCallback(async () => {
    if (!(await dirty.confirmClose())) return;
    resetForm();
    onClose();
  }, [dirty, onClose, resetForm]);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <>
      <Modal
        open={open}
        onClose={handleClose}
        title="Новий рахунок"
        footer={
          <Button
            onClick={handleCreate}
            loading={saving}
            disabled={!form.counterpartyId || !form.amount}
            className="w-full"
          >
            Створити рахунок
          </Button>
        }
      >
        <div className="space-y-4">
          {error && (
            <div className="text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">
              Контрагент <span className="text-destructive-text">*</span>
            </label>
            <EntityPickerField<CpItem>
              display={counterpartyDisplay}
              placeholder="Пошук контрагента…"
              onOpenDetail={form.counterpartyId ? openCpDetail : undefined}
              onPick={() => setCpPickerOpen(true)}
              onSearch={fetchCpItems}
              onSearchSelect={item => {
                setCounterpartyDisplay(item.primary);
                setForm(f => ({ ...f, counterpartyId: item.id }));
                dirty.markDirty();
              }}
              onClear={() => {
                setCounterpartyDisplay('');
                setForm(f => ({ ...f, counterpartyId: '' }));
                dirty.markDirty();
              }}
            />
          </div>

          <Input
            label="Сума, ₴"
            required
            type="number"
            min="0.01"
            value={form.amount}
            onChange={e => {
              setForm(f => ({ ...f, amount: e.target.value }));
              dirty.markDirty();
            }}
            step="0.01"
            placeholder="0.00"
          />
          <DatePickerInput
            label="Термін оплати"
            value={form.dueDate}
            onChange={v => {
              setForm(f => ({ ...f, dueDate: v }));
              dirty.markDirty();
            }}
          />
          <DatePickerInput
            label="Дата документа"
            value={form.documentDate}
            onChange={v => {
              setForm(f => ({ ...f, documentDate: v }));
              dirty.markDirty();
            }}
          />
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
          dirty.markDirty();
          setCpPickerOpen(false);
        }}
      />

      {/* Counterparty detail */}
      <CounterpartyEditModal
        open={cpDetailOpen}
        counterparty={cpDetailData}
        onClose={() => setCpDetailOpen(false)}
        onSaved={updated => {
          setCpDetailData(updated);
          setCounterpartyDisplay(displayCounterpartyName(updated));
          setCpDetailOpen(false);
        }}
      />

      <DirtyConfirmDialog {...dirty.dialogProps} />
    </>
  );
}
