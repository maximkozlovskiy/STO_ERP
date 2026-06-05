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

export interface CashRegister {
  id: string;
  name: string;
  currencyId: string;
  currencyCode: string;
  currencySymbol?: string | null;
  branchId: string;
  branchName: string;
}

export interface BranchInfo {
  id: string;
  name: string;
}
