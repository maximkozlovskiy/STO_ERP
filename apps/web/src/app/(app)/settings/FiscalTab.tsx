'use client';

import ProviderRegistryPanel, { type PanelProviderMeta } from './ProviderRegistryPanel';

// Схеми полів кредів провайдерів (бекенд list() дає лише code/name; поля — фронт-константа,
// бо кожен провайдер має свій набір секретів).
const FISCAL_PROVIDERS: PanelProviderMeta[] = [
  {
    code: 'checkbox',
    name: 'Checkbox',
    hasShiftMode: true,
    fields: [
      { key: 'licenseKey', label: 'Ліцензійний ключ каси', secret: true },
      { key: 'pinCode', label: 'PIN касира', secret: true },
      { key: 'cashRegisterId', label: 'ID каси (cash register)', placeholder: 'напр. 0e5b...' },
    ],
  },
  {
    code: 'vchasno',
    name: 'Вчасно.Каса',
    hasShiftMode: true,
    fields: [{ key: 'token', label: 'API-токен', secret: true }],
  },
];

const PAYMENT_GATEWAYS: PanelProviderMeta[] = [
  {
    code: 'monobank',
    name: 'monobank Еквайринг',
    fields: [{ key: 'token', label: 'X-Token merchant', secret: true }],
  },
  {
    code: 'liqpay',
    name: 'LiqPay (ПриватБанк)',
    fields: [
      { key: 'publicKey', label: 'Public key', placeholder: 'i00000000000' },
      { key: 'privateKey', label: 'Private key', secret: true },
    ],
  },
];

/**
 * Вкладка фіскалізації + онлайн-оплат. Два registry-панелі: активний ПРРО-провайдер і активний
 * платіжний шлюз обираються per-branch (ексклюзивно, лише 1 кожного типу). Дзеркалить панель
 * провайдерів сповіщень.
 */
export default function FiscalTab() {
  return (
    <div className="space-y-8 max-w-2xl">
      <ProviderRegistryPanel
        title="Фіскалізація (ПРРО)"
        endpoint="fiscal-providers"
        providers={FISCAL_PROVIDERS}
      />
      <div className="border-t border-border pt-6">
        <ProviderRegistryPanel
          title="Онлайн-оплата (еквайринг)"
          endpoint="payment-gateways"
          providers={PAYMENT_GATEWAYS}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        Активним може бути лише один провайдер ПРРО і один платіжний шлюз на філію. Керування
        касовою зміною — на сторінці «Каса».
      </p>
    </div>
  );
}
