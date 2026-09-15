'use client';

// Пікер правила ціноутворення для замовлення постачальнику (TD3-декомпозиція).
// Винесено з PurchaseOrderCreateModal.tsx без зміни поведінки — самодостатній суб-діалог.
import { Modal } from '@/components/ui/modal';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import type { PricingRule } from './types';

export interface RulePricerModalProps {
  open: boolean;
  onClose: () => void;
  supplierId: string;
  supplierDisplay: string;
  ruleFilterBySupplier: boolean;
  onToggleFilter: (bySupplier: boolean) => void;
  pricingRules: PricingRule[];
  pricingRulesLoading: boolean;
  onSelectRule: (ruleId: string) => void;
}

export function RulePricerModal({
  open,
  onClose,
  supplierId,
  supplierDisplay,
  ruleFilterBySupplier,
  onToggleFilter,
  pricingRules,
  pricingRulesLoading,
  onSelectRule,
}: RulePricerModalProps) {
  return (
    <Modal open={open} onClose={onClose} title="Оберіть правило розцінки" size="md">
      <div className="flex flex-col gap-3" style={{ minHeight: '200px' }}>
        {/* Фільтр по постачальнику */}
        {supplierId && (
          <div className="flex items-center gap-2 text-[13px]">
            <button
              type="button"
              onClick={() => onToggleFilter(true)}
              className={cn(
                'px-3 py-1 rounded-full border text-xs font-medium transition-colors',
                ruleFilterBySupplier
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border text-muted-foreground hover:border-primary/50',
              )}
            >
              {supplierDisplay || 'Постачальник'}
            </button>
            <button
              type="button"
              onClick={() => onToggleFilter(false)}
              className={cn(
                'px-3 py-1 rounded-full border text-xs font-medium transition-colors',
                !ruleFilterBySupplier
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border text-muted-foreground hover:border-primary/50',
              )}
            >
              Всі правила
            </button>
          </div>
        )}
        {pricingRulesLoading ? (
          <div className="flex justify-center py-10">
            <Spinner size="sm" />
          </div>
        ) : pricingRules.length === 0 ? (
          <p className="text-sm text-muted-foreground py-10 text-center">
            {ruleFilterBySupplier && supplierId
              ? 'Немає правил для цього постачальника'
              : 'Немає активних правил ціноутворення'}
          </p>
        ) : (
          <div className="space-y-1 overflow-y-auto" style={{ maxHeight: '380px' }}>
            {pricingRules.map(rule => (
              <button
                key={rule.id}
                type="button"
                onClick={() => onSelectRule(rule.id)}
                className="w-full text-left px-3 py-2.5 rounded-lg border border-border bg-surface hover:border-primary hover:bg-primary/5 transition-colors"
              >
                <div className="text-sm font-medium text-foreground">{rule.name}</div>
                {rule.description && (
                  <div className="text-xs text-muted-foreground mt-0.5">{rule.description}</div>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
