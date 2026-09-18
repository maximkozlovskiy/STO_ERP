// Shared types for pricing-rules page + RuleFormModal (dynamic chunk).

export interface Good {
  id: string;
  name: string;
  sku: string | null;
}

export interface Brand {
  id: string;
  name: string;
}

export interface PricingRuleTier {
  id?: string;
  costMin: number;
  costMax: number | null;
  percentValue: number;
  sortOrder: number;
}

export interface PricingRule {
  id: string;
  name: string;
  type: 'PERCENT' | 'FIXED_AMOUNT' | 'FIXED_PRICE' | 'COMPETITOR_PLUS' | 'COST_TIER';
  priority: number;
  goodId: string | null;
  good: Good | null;
  goodCategory: string | null;
  goodType: string | null;
  percentValue: number | null;
  fixedAmount: number | null;
  fixedPrice: number | null;
  roundTo: number | null;
  isActive: boolean;
  createdAt: string;
  brandId?: string | null;
  brandName?: string | null;
  supplierId?: string | null;
  supplierName?: string | null;
  tiers?: PricingRuleTier[];
}

export type RuleForm = {
  name: string;
  type: PricingRule['type'];
  priority: string;
  goodId: string;
  goodCategory: string;
  goodType: string;
  percentValue: string;
  fixedAmount: string;
  fixedPrice: string;
  roundTo: string;
  isActive: boolean;
  brandId: string;
  supplierId: string;
  supplierName: string;
  tiers: PricingRuleTier[];
};

export const EMPTY_FORM: RuleForm = {
  name: '',
  type: 'PERCENT',
  priority: '10',
  goodId: '',
  goodCategory: '',
  goodType: '',
  percentValue: '',
  fixedAmount: '',
  fixedPrice: '',
  roundTo: '',
  isActive: true,
  brandId: '',
  supplierId: '',
  supplierName: '',
  tiers: [],
};

// i18n: значення = ключі каталогу `pricingRules`; рендер через t(TYPE_LABELS[type]).
export const TYPE_LABELS: Record<string, string> = {
  PERCENT: 'typeLabels.PERCENT',
  FIXED_AMOUNT: 'typeLabels.FIXED_AMOUNT',
  FIXED_PRICE: 'typeLabels.FIXED_PRICE',
  COMPETITOR_PLUS: 'typeLabels.COMPETITOR_PLUS',
  COST_TIER: 'typeLabels.COST_TIER',
};

// i18n: `labelKey` = ключ каталогу `pricingRules`; рендер через t(o.labelKey).
export const GOOD_TYPE_OPTIONS = [
  { value: '', labelKey: 'goodTypeOptions.ANY' },
  { value: 'SPARE_PART', labelKey: 'goodTypeOptions.SPARE_PART' },
  { value: 'CONSUMABLE', labelKey: 'goodTypeOptions.CONSUMABLE' },
  { value: 'MATERIAL', labelKey: 'goodTypeOptions.MATERIAL' },
  { value: 'TOOL', labelKey: 'goodTypeOptions.TOOL' },
];
