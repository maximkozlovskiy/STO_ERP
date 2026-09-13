export interface TaxRateItem {
  id: string;
  name: string;
  rate: number;
  isDefault: boolean;
  isActive: boolean;
}

export interface Currency {
  id: string;
  name: string;
  code: string;
  symbol?: string | null;
  fullName?: string | null;
  internationalName?: string | null;
  nbuFetchEnabled: boolean;
  nbuMarkupPercent?: number | null;
  // Системна валюта (UAH) — сервер блокує видалення та зміну коду/назви (currencies.service).
  isSystem?: boolean;
}

export interface ExchangeRate {
  id: string;
  currencyId: string;
  currencyCode: string;
  currencyName: string;
  date: string;
  rate: number;
  coefficient: number;
}

export interface BankAccount {
  id: string;
  name: string;
  ibanUA: string;
  currencyId: string;
  currencyCode: string;
  bankName?: string | null;
  branchId?: string | null;
  branchName?: string | null;
  mfo?: string | null;
  edrpou?: string | null;
  bankAddress?: string | null;
}

// CashRegister тип видалено разом з НДІ→Каса вкладкою (refactor(dedup)):
// каси керуються лише на сторінці «Каса» (вкладка «Каси»), яка бере тип
// `CashRegister` з @/hooks/api/useCash. Тут інтерфейс лишався осиротілим.

export interface BranchInfo {
  id: string;
  name: string;
}
