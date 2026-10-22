'use client';

// Діалог конфлікту «рахунок уже існує» для наряду (TD3-декомпозиція CreateWorkOrderModal).
// Винесено без зміни поведінки: самодостатній суб-діалог з вузькою surface (стан із
// useWorkOrderActions). ESC — шар Escape у `useWorkOrderActions` (useEscapeLayer).
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';

export interface InvoiceConflictDialogProps {
  open: boolean;
  loading: boolean;
  onClose: () => void;
  onRefresh: () => void;
  onOpenExisting: () => void;
}

export function InvoiceConflictDialog({
  open,
  loading,
  onClose,
  onRefresh,
  onOpenExisting,
}: InvoiceConflictDialogProps) {
  const { t } = useTranslation('workOrders');
  if (!open) return null;
  return (
    // ESC — шар Escape у useWorkOrderActions (onKeyDown на <div role="presentation"> без
    // tabIndex/focus не спрацював би).
    // Overlay click + autoFocus для модального UX.
    <div
      className="fixed inset-0 z-60 flex items-center justify-center bg-black/50"
      onClick={() => !loading && onClose()}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="invoice-conflict-title"
        className="bg-surface rounded-xl shadow-xl p-6 max-w-sm w-full mx-4"
        onClick={e => e.stopPropagation()}
      >
        <h3 id="invoice-conflict-title" className="font-semibold text-base mb-2">
          {t('invoice.conflict.title')}
        </h3>
        <p className="text-sm text-muted-foreground mb-5">{t('invoice.conflict.message')}</p>
        <div className="flex flex-col gap-2">
          <Button
            autoFocus
            onClick={onRefresh}
            loading={loading}
            disabled={loading}
            className="w-full"
          >
            {t('invoice.conflict.refresh')}
          </Button>
          {/* захист від race — поки triggers in-flight, інші дії dialog
              заборонені (інакше "Відкрити існуючий" відкриває рахунок паралельно з
              refresh → дві вкладки + застаріле UI). */}
          <Button variant="outline" onClick={onOpenExisting} disabled={loading} className="w-full">
            {t('invoice.conflict.openExisting')}
          </Button>
          <Button variant="ghost" onClick={onClose} disabled={loading} className="w-full">
            {t('common:cancel')}
          </Button>
        </div>
      </div>
    </div>
  );
}
