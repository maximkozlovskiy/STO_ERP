'use client';

import { useTranslation } from 'react-i18next';
import { Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Смуга зверху картки документа, позначеного на видалення: картка відкрита лише на перегляд.
 *
 * Одна на всі типи документів (наряд, рахунок, замовлення, повернення, складський документ,
 * оплата постачальнику), щоб текст і вигляд не розходились. `role="status"` — читач екрана
 * оголошує смугу, щойно документ завантажився, а не лишає користувача з мовчки вимкненими полями.
 */
export function DeletedDocumentBanner({ className }: { className?: string }) {
  const { t } = useTranslation('common');
  return (
    <div
      role="status"
      data-testid="deleted-document-banner"
      className={cn(
        'flex items-center gap-2 rounded-lg border border-warning/40 bg-warning-subtle px-3 py-2 text-[13px] font-medium text-foreground',
        className,
      )}
    >
      <Trash2 className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span>{t('deletedDocumentReadOnly')}</span>
    </div>
  );
}
