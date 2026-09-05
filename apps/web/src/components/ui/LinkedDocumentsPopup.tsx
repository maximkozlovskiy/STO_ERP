'use client';

import { useEffect } from 'react';
import { X } from 'lucide-react';
import {
  LinkedDocumentsPanel,
  type LinkedEntityConfig,
} from '@/components/ui/LinkedDocumentsPanel';

/**
 * Правий floating-попап зі списком пов'язаних документів. Раніше цей shell
 * (backdrop + діалог + close-X + document-level Escape) копіювався у кожен
 * список (6 інстансів). Тепер один компонент: сторінка лише тримає `popupId`
 * і рендерить `{popupId && <LinkedDocumentsPopup entityId={popupId} .../>}`.
 */
export function LinkedDocumentsPopup({
  entityId,
  config,
  onClose,
  ariaLabel = "Пов'язані документи",
}: {
  entityId: string;
  config: LinkedEntityConfig;
  onClose: () => void;
  ariaLabel?: string;
}) {
  // Escape закриває попап. Компонент монтується лише коли попап відкритий,
  // тож listener живе рівно стільки, скільки треба (cleanup на unmount).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 bg-black/30" onClick={onClose} role="presentation">
      <div
        className="absolute right-4 top-1/2 -translate-y-1/2 w-90 max-h-[80vh] overflow-y-auto bg-background rounded-xl shadow-2xl border border-border p-4"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold text-sm">Пов&apos;язані документи</h2>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Закрити"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <LinkedDocumentsPanel config={config} entityId={entityId} />
      </div>
    </div>
  );
}
