'use client';

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import ProviderRegistryPanel, { type PanelProviderMeta } from './ProviderRegistryPanel';

/**
 * Вкладка фіскалізації + онлайн-оплат. Два registry-панелі: активний ПРРО-провайдер і активний
 * платіжний шлюз обираються per-branch (ексклюзивно, лише 1 кожного типу). Дзеркалить панель
 * провайдерів сповіщень.
 *
 * Схеми полів кредів — фронт-константа (бекенд list() дає лише code/name). Назви провайдерів —
 * бренди (лишаються як є); підписи полів — з settings-каталогу (fiscal.*).
 */
export default function FiscalTab() {
  const { t } = useTranslation('settings');

  const fiscalProviders: PanelProviderMeta[] = useMemo(
    () => [
      {
        code: 'checkbox',
        name: 'Checkbox',
        hasShiftMode: true,
        fields: [
          { key: 'licenseKey', label: t('fiscal.checkboxLicenseKey'), secret: true },
          { key: 'pinCode', label: t('fiscal.checkboxPinCode'), secret: true },
          {
            key: 'cashRegisterId',
            label: t('fiscal.checkboxCashRegisterId'),
            placeholder: t('fiscal.checkboxCashRegisterIdPlaceholder'),
          },
        ],
      },
      {
        code: 'vchasno',
        name: 'Вчасно.Каса',
        hasShiftMode: true,
        fields: [{ key: 'token', label: t('fiscal.vchasnoToken'), secret: true }],
      },
    ],
    [t],
  );

  const paymentGateways: PanelProviderMeta[] = useMemo(
    () => [
      {
        code: 'monobank',
        name: 'monobank Еквайринг',
        fields: [{ key: 'token', label: t('fiscal.monobankToken'), secret: true }],
      },
      {
        code: 'liqpay',
        name: 'LiqPay (ПриватБанк)',
        fields: [
          { key: 'publicKey', label: t('fiscal.liqpayPublicKey'), placeholder: 'i00000000000' },
          { key: 'privateKey', label: t('fiscal.liqpayPrivateKey'), secret: true },
        ],
      },
    ],
    [t],
  );

  return (
    <div className="space-y-8 max-w-2xl">
      <ProviderRegistryPanel
        title={t('fiscal.prroTitle')}
        endpoint="fiscal-providers"
        providers={fiscalProviders}
      />
      <div className="border-t border-border pt-6">
        <ProviderRegistryPanel
          title={t('fiscal.acquiringTitle')}
          endpoint="payment-gateways"
          providers={paymentGateways}
        />
      </div>
      <p className="text-xs text-muted-foreground">{t('fiscal.footer')}</p>
    </div>
  );
}
