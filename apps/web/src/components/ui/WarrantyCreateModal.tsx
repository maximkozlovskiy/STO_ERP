'use client';

import { useState } from 'react';
import { Modal, ModalFooter } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DatePickerInput } from '@/components/ui/date-picker-input';
import { kyivToday, addDaysISO } from '@/lib/format';
import { toast } from '@/lib/toast';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import { useCreateWarranty } from '@/hooks/api/useWarranties';

interface Props {
  open: boolean;
  onClose: () => void;
  workOrderId: string;
  counterpartyId: string;
  /** Викликається після успішного створення (батько рефетчить список). */
  onCreated: () => void;
}

/**
 * Ручне створення гарантії на наряд (POST /warranties). Основний потік — авто-створення при
 * COMPLETED; ця модалка для випадків defaultWarrantyDays=0 або окремої гарантії. expiresAt має бути
 * у майбутньому (бекенд інакше 400) — DatePickerInput min=завтра.
 */
export function WarrantyCreateModal({
  open,
  onClose,
  workOrderId,
  counterpartyId,
  onCreated,
}: Props) {
  const features = useUiFeatures();
  const createWarranty = useCreateWarranty();
  const [expiresAt, setExpiresAt] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');

  // min = завтра (Kyiv) — гарантія лише у майбутнє. addDaysISO: UTC-арифметика, без залежності
  // від часового поясу браузера (local-parse + toISOString давав off-by-one на межі дня).
  const tomorrow = addDaysISO(kyivToday(), 1);

  const reset = () => {
    setExpiresAt('');
    setDescription('');
    setError('');
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const submit = async () => {
    setError('');
    if (!expiresAt) {
      setError('Вкажіть дату закінчення гарантії');
      return;
    }
    try {
      await createWarranty.mutateAsync({
        workOrderId,
        counterpartyId,
        // Кінець вибраного дня в UTC (`T23:59:59Z`) — покриває весь день незалежно від
        // часового поясу браузера. Local-parse `T00:00:00`.toISOString() зсував дату на -1
        // у браузерах із додатнім offset (Kyiv UTC+3): 10-09 00:00 → 09-09 21:00Z (off-by-one).
        expiresAt: `${expiresAt}T23:59:59Z`,
        description: description.trim() || undefined,
      });
      if (features.toastEnabled) toast.success('Гарантію створено');
      reset();
      onCreated();
      onClose();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Помилка створення гарантії';
      setError(msg);
      if (features.toastEnabled) toast.error(msg);
    }
  };

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Нова гарантія"
      size="sm"
      onSubmit={() => void submit()}
      footer={
        <ModalFooter>
          <Button variant="outline" onClick={handleClose} disabled={createWarranty.isPending}>
            Скасувати
          </Button>
          <Button onClick={() => void submit()} loading={createWarranty.isPending}>
            Створити
          </Button>
        </ModalFooter>
      }
    >
      <div className="space-y-4">
        {error && (
          <div className="text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-3 py-2">
            {error}
          </div>
        )}
        <div>
          <label className="block text-[13px] font-medium text-foreground mb-1.5">
            Діє до <span className="text-destructive">*</span>
          </label>
          <DatePickerInput value={expiresAt} onChange={setExpiresAt} min={tomorrow} />
        </div>
        <div>
          <label className="block text-[13px] font-medium text-foreground mb-1.5">Опис</label>
          <Input
            value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder="Напр. гарантія на роботу / запчастину"
            maxLength={500}
          />
        </div>
      </div>
    </Modal>
  );
}
