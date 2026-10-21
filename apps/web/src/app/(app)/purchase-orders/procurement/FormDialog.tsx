'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';

function DialogError({ message, as }: { message: string; as: 'box' | 'text' }) {
  if (!message) return null;
  if (as === 'text') return <p className="text-sm text-destructive-text">{message}</p>;
  return (
    <div className="text-sm text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-3 py-2">
      {message}
    </div>
  );
}

interface FormDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  size?: 'sm' | 'md';
  submitLabel: string;
  /** Перевірка перед запитом: рядок — помилка в діалозі, запит не йде. */
  validate?: () => string | undefined;
  /** Запит. Помилка (throw) показується в діалозі; закриття й тост — справа викличного. */
  onSubmit: () => Promise<void>;
  /**
   * Діалог щоразу відкривається начисто — помилку минулої спроби скинуто (поля власник скидає
   * сам). Без нього діалог тримає чернетку й помилку до наступного відкриття.
   */
  resetErrorOnOpen?: boolean;
  /** Помилка блоком у рамці (позиції) чи рядком тексту (списки). */
  errorAs?: 'box' | 'text';
  children: ReactNode;
}

/**
 * Діалог-форма «Управління купівлями» (масові дії з позиціями, новий список, об'єднання, ручна
 * позиція): «Скасувати» / дія, Enter — дія, стан запиту й помилка в діалозі.
 */
export function FormDialog({
  open,
  onClose,
  title,
  description,
  size = 'sm',
  submitLabel,
  validate,
  onSubmit,
  resetErrorOnOpen = false,
  errorAs = 'box',
  children,
}: FormDialogProps) {
  const { t } = useTranslation('purchaseLists');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (open && resetErrorOnOpen) setErr('');
  }, [open, resetErrorOnOpen]);

  const submit = async () => {
    const invalid = validate?.();
    if (invalid) {
      setErr(invalid);
      return;
    }
    setSaving(true);
    setErr('');
    try {
      await onSubmit();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : t('errors.action'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      {...(description ? { description } : {})}
      size={size}
      onSubmit={() => void submit()}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={() => void submit()} loading={saving}>
            {submitLabel}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        {children}
        <DialogError message={err} as={errorAs} />
      </div>
    </Modal>
  );
}
