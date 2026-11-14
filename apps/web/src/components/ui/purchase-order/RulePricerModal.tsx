'use client';

// Пікер правила ціноутворення для замовлення постачальнику (TD3-декомпозиція).
// Показує лише правила, що можуть розцінити це замовлення (BR-PO-006, №18): відбір —
// `applicablePricingRules`, перемикача «Всі правила» немає.
import { Modal } from '@/components/ui/modal';
import { useTranslation } from 'react-i18next';
import { Spinner } from '@/components/ui/spinner';
import type { PricingRule } from './types';

/** Рядок `GET /pricing-rules`, потрібний вікну: назва, опис і чи може правило діяти. */
export interface PricingRuleOption extends PricingRule {
  isActive: boolean;
  supplierId: string | null;
}

/**
 * Правила, що можуть розцінити замовлення постачальника `supplierId` (BR-PO-006, №18): активні й
 * без постачальника або саме цього. Вимкнене чи чуже правило розцінка не застосувала б до жодного
 * рядка (`getPricingContext` бере лише активні, `pickRule` — лише свого постачальника).
 */
export function applicablePricingRules(
  rules: readonly PricingRuleOption[],
  supplierId: string | null | undefined,
): PricingRule[] {
  return rules
    .filter(r => r.isActive && (!r.supplierId || r.supplierId === supplierId))
    .map(({ id, name, description }) => ({ id, name, description }));
}

export interface RulePricerModalProps {
  open: boolean;
  onClose: () => void;
  pricingRules: PricingRule[];
  pricingRulesLoading: boolean;
  onSelectRule: (ruleId: string) => void;
}

export function RulePricerModal({
  open,
  onClose,
  pricingRules,
  pricingRulesLoading,
  onSelectRule,
}: RulePricerModalProps) {
  const { t } = useTranslation('purchaseOrders');
  return (
    <Modal open={open} onClose={onClose} title={t('rulePricer.title')} size="md">
      <div className="flex flex-col gap-3" style={{ minHeight: '200px' }}>
        <p className="text-[12px] text-muted-foreground">{t('rulePricer.hint')}</p>
        {pricingRulesLoading ? (
          <div className="flex justify-center py-10">
            <Spinner size="sm" />
          </div>
        ) : pricingRules.length === 0 ? (
          <p className="text-sm text-muted-foreground py-10 text-center">
            {t('rulePricer.noApplicableRules')}
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
