import type { SupplierProvider } from '@prisma/client';

/**
 * Назва постачальника API для людини — одне місце правди: її віддають адаптери (`adapter.name`,
 * список провайдерів у формі підключення) і повідомлення поза модулем supplier-api, яким реєстр
 * адаптерів недоступний (видалення контрагента з увімкненим підключенням, BR-CP-019).
 */
export const SUPPLIER_PROVIDER_NAMES: Record<SupplierProvider, string> = {
  TEHNOMIR: 'Tehnomir',
  BM_PARTS: 'BM Parts',
  UTR: 'UTR (UniqTrade)',
  AD_UKRAINE: 'AD Ukraine (АвтоТехнікс)',
  AVD_TRADE: 'AVD Trade',
};

/** Назва провайдера; невідомий код (новий у БД, старий у коді) — сам код. */
export function supplierProviderName(provider: string): string {
  return (SUPPLIER_PROVIDER_NAMES as Record<string, string | undefined>)[provider] ?? provider;
}
