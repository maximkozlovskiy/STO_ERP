'use client';

import { useEffect, useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useConfirm } from '@/hooks/useConfirm';
import { apiFetch } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { TemplatePickerModal, type SystemTemplate } from '@/components/ui/template-picker-modal';
import { cn } from '@/lib/utils';
import { type PaymentMethod } from './shared';

export default function PaymentsTab() {
  const { confirm, dialogProps } = useConfirm();
  const [payments, setPayments] = useState<PaymentMethod[]>([]);
  const [error, setError] = useState('');

  const [editPayment, setEditPayment] = useState<PaymentMethod | null>(null);
  const [editPaymentForm, setEditPaymentForm] = useState({ name: '', requiresFiscal: false });
  const [paymentModal, setPaymentModal] = useState(false);
  const [paymentTemplatePicker, setPaymentTemplatePicker] = useState(false);
  const [newPaymentForm, setNewPaymentForm] = useState({
    code: '',
    name: '',
    requiresFiscal: false,
  });
  const [savingPayment, setSavingPayment] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<PaymentMethod[]>('/payment-methods')
      .then(setPayments)
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : 'Помилка завантаження методів оплати'),
      );
  }, []);

  const togglePayment = async (pm: PaymentMethod) => {
    setTogglingId(pm.id);
    try {
      const updated = await apiFetch<PaymentMethod>(`/payment-methods/${pm.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: !pm.isActive }),
      });
      setPayments(prev => prev.map(p => (p.id === updated.id ? updated : p)));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка');
    } finally {
      setTogglingId(null);
    }
  };

  const openEditPayment = (pm: PaymentMethod) => {
    setEditPayment(pm);
    setEditPaymentForm({ name: pm.name, requiresFiscal: pm.requiresFiscal });
  };

  const saveEditPayment = async () => {
    if (!editPayment) return;
    setSavingPayment(true);
    try {
      const updated = await apiFetch<PaymentMethod>(`/payment-methods/${editPayment.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: editPaymentForm.name,
          requiresFiscal: editPaymentForm.requiresFiscal,
        }),
      });
      setPayments(prev => prev.map(p => (p.id === updated.id ? updated : p)));
      setEditPayment(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка');
    } finally {
      setSavingPayment(false);
    }
  };

  const createPaymentMethod = async () => {
    if (!newPaymentForm.code.trim() || !newPaymentForm.name.trim()) {
      setError("Код і назва є обов'язковими");
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
        }),
      });
      setPayments(prev => [...prev, created]);
      setPaymentModal(false);
      setNewPaymentForm({ code: '', name: '', requiresFiscal: false });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка');
    } finally {
      setSavingPayment(false);
    }
  };

  const importPaymentsFromTemplates = async (templates: SystemTemplate[]) => {
    // sto-optimize: bulk-create templates паралель — кожен POST незалежний (унікальні
    // codes у шаблонах). Sequential N × RTT → max single RTT. Promise.allSettled зберігає
    // per-item error tracking без abort'у решти при першій помилці (паралельний паттерн
    // з ndi/PaymentsTab — cycle-N gap по другому файлу з тим самим pattern).
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
    if (!(await confirm({ title: 'Видалити метод оплати?', variant: 'destructive' }))) return;
    try {
      await apiFetch(`/payment-methods/${id}`, { method: 'DELETE' });
      setPayments(prev => prev.filter(p => p.id !== id));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка');
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
          З шаблону
        </Button>
        <Button
          leftIcon={<Plus className="h-4 w-4" />}
          onClick={() => {
            setNewPaymentForm({ code: '', name: '', requiresFiscal: false });
            setPaymentModal(true);
          }}
        >
          Метод оплати
        </Button>
      </div>

      <TemplatePickerModal
        open={paymentTemplatePicker}
        onClose={() => setPaymentTemplatePicker(false)}
        entityType="payment_method"
        title="Додати методи оплати з шаблону"
        existingKeys={payments.map(p => p.code)}
        onImport={importPaymentsFromTemplates}
      />

      <div className="bg-surface rounded-xl border border-border divide-y divide-border">
        {payments.length === 0 && (
          <p className="p-6 text-sm text-muted-foreground">Методи оплати не знайдено</p>
        )}
        {payments.map(pm => (
          <div key={pm.id} className="flex items-center justify-between px-5 py-4">
            <div>
              <p className="text-sm font-medium text-foreground">{pm.name}</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {pm.code}
                {pm.requiresFiscal ? ' · фіскальний' : ''}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => void togglePayment(pm)}
                disabled={togglingId === pm.id}
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
                className="p-1 text-muted-foreground hover:text-foreground"
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={() => void deletePaymentMethod(pm.id)}
                className="p-1 text-destructive/70 hover:text-destructive hover:bg-destructive/10 rounded"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Edit payment modal */}
      {editPayment && (
        <Modal
          open={!!editPayment}
          onClose={() => setEditPayment(null)}
          title="Редагувати метод оплати"
          footer={
            <Button
              onClick={() => void saveEditPayment()}
              loading={savingPayment}
              className="w-full"
            >
              Зберегти
            </Button>
          }
        >
          <div className="space-y-4">
            <Input
              label="Назва"
              value={editPaymentForm.name}
              onChange={e => setEditPaymentForm(f => ({ ...f, name: e.target.value }))}
              required
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
              <span className="text-[13px] text-foreground">Фіскальний (потребує ПРРО)</span>
            </label>
          </div>
        </Modal>
      )}

      {/* Create payment modal */}
      <Modal
        open={paymentModal}
        onClose={() => setPaymentModal(false)}
        title="Новий метод оплати"
        footer={
          <Button
            onClick={() => void createPaymentMethod()}
            loading={savingPayment}
            disabled={!newPaymentForm.code || !newPaymentForm.name}
            className="w-full"
          >
            Додати
          </Button>
        }
      >
        <div className="space-y-4">
          <Input
            label="Код"
            value={newPaymentForm.code}
            onChange={e => setNewPaymentForm(f => ({ ...f, code: e.target.value }))}
            placeholder="CASH, CARD, BANK"
            required
            hint="Унікальний ідентифікатор (латиниця, великі літери)"
            className="h-8 text-[13px]"
          />
          <Input
            label="Назва"
            value={newPaymentForm.name}
            onChange={e => setNewPaymentForm(f => ({ ...f, name: e.target.value }))}
            placeholder="Готівка"
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
            <span className="text-[13px] text-foreground">Фіскальний (потребує ПРРО)</span>
          </label>
        </div>
      </Modal>

      <ConfirmDialog {...dialogProps} />
    </div>
  );
}
