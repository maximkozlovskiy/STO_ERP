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

export const TYPE_LABELS: Record<string, string> = {
  PERCENT: 'Відсоток від собівартості',
  FIXED_AMOUNT: 'Фіксована надбавка',
  FIXED_PRICE: 'Фіксована ціна',
  COMPETITOR_PLUS: 'Від ціни конкурента',
  COST_TIER: 'Грейди (за собівартістю)',
};

export const GOOD_TYPE_OPTIONS = [
  { value: '', label: '— Будь-який —' },
  { value: 'SPARE_PART', label: 'Запчастина' },
  { value: 'CONSUMABLE', label: 'Витратний матеріал' },
  { value: 'MATERIAL', label: 'Матеріал' },
  { value: 'TOOL', label: 'Інструмент' },
];
