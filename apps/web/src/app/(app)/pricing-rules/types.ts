// Shared types for pricing-rules page + RuleFormModal (dynamic chunk).
// Типи відповіді й запиту — зі згенерованого контракту (`@sto/shared`), не рукописні.
import type { ApiSchema } from '@sto/shared';

export type PricingRule = ApiSchema<'PricingRuleResponseDto'>;
export type CreatePricingRulePayload = ApiSchema<'CreatePricingRuleDto'>;
export type UpdatePricingRulePayload = ApiSchema<'UpdatePricingRuleDto'>;
/** Товар у списку правила: `{ id, internalCode, name, sku, brandName }`. */
export type RuleGood = ApiSchema<'PricingRuleGoodRefDto'>;
export type RuleGoodsResponse = ApiSchema<'PricingRuleGoodsDto'>;
export type ResolveGoodsFileResult = ApiSchema<'ResolveGoodsFileResponseDto'>;
/** Товар-кандидат із відповіді розпізнавання файла (має ще `brandId`). */
export type ResolvedGoodRef = ApiSchema<'GoodRefDto'>;
export type GoodRefRaw = ApiSchema<'GoodRefRawDto'>;
type GoodTypeValue = NonNullable<CreatePricingRulePayload['goodType']>;

export interface Brand {
  id: string;
  name: string;
}

/** Грейд у формі: `id` є лише в збережених, `costMax: null` — «без верхньої межі». */
export interface PricingRuleTier {
  id?: string;
  costMin: number;
  costMax: number | null;
  percentValue: number;
  sortOrder: number;
}

export type RuleForm = {
  name: string;
  type: PricingRule['type'];
  priority: string;
  /** Список товарів правила (локальний; у базу йде кнопкою «Зберегти»). */
  goods: RuleGood[];
  /** Категорія з довідника; '' — будь-яка. */
  goodCategoryId: string;
  /** Назва обраної категорії — запасна опція, якщо довідник не завантажився. */
  goodCategoryName: string;
  /**
   * Стара ТЕКСТОВА категорія (лише в правил, яким міграція не знайшла категорію в довіднику).
   * Доки `categoryTouched === false`, `goodCategoryId` на сервер не надсилається — інакше
   * текстова категорія стерлась би без волі користувача.
   */
  legacyGoodCategory: string;
  categoryTouched: boolean;
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
  goods: [],
  goodCategoryId: '',
  goodCategoryName: '',
  legacyGoodCategory: '',
  categoryTouched: false,
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

const GOOD_TYPE_VALUES: readonly string[] = ['SPARE_PART', 'CONSUMABLE', 'MATERIAL', 'TOOL'];
const isGoodType = (v: string): v is GoodTypeValue => GOOD_TYPE_VALUES.includes(v);

// ─── Область правила ──────────────────────────────────────────────────────────

/**
 * Діючий вимір області. Область має ОДИН вимір (сервер нормалізує так само):
 * список товарів > бренд > категорія > тип > весь асортимент. Постачальник — окрема вісь.
 */
export type ScopeDimension = 'goods' | 'brand' | 'category' | 'type' | 'all';

export function scopeDimension(
  form: Pick<RuleForm, 'goods' | 'brandId' | 'goodCategoryId' | 'goodType'>,
): ScopeDimension {
  if (form.goods.length > 0) return 'goods';
  if (form.brandId) return 'brand';
  if (form.goodCategoryId) return 'category';
  if (form.goodType) return 'type';
  return 'all';
}

// ─── Форма ↔ контракт ─────────────────────────────────────────────────────────

/** Правило з API → початковий стан форми. Список товарів довантажується окремо. */
export function ruleToForm(rule: PricingRule): RuleForm {
  return {
    name: rule.name,
    type: rule.type,
    priority: String(rule.priority),
    goods: [],
    goodCategoryId: rule.goodCategoryId ?? '',
    goodCategoryName: rule.goodCategoryName ?? '',
    legacyGoodCategory: rule.goodCategoryId ? '' : (rule.goodCategory ?? ''),
    categoryTouched: false,
    goodType: rule.goodType ?? '',
    percentValue: rule.percentValue != null ? String(rule.percentValue) : '',
    fixedAmount: rule.fixedAmount != null ? String(rule.fixedAmount) : '',
    fixedPrice: rule.fixedPrice != null ? String(rule.fixedPrice) : '',
    roundTo: rule.roundTo != null ? String(rule.roundTo) : '',
    isActive: rule.isActive,
    brandId: rule.brandId ?? '',
    supplierId: rule.supplierId ?? '',
    supplierName: rule.supplierName ?? '',
    tiers: rule.tiers ?? [],
  };
}

function valuePart(form: RuleForm) {
  const isPercent = form.type === 'PERCENT' || form.type === 'COMPETITOR_PLUS';
  return {
    name: form.name,
    type: form.type,
    priority: Number(form.priority) || 10,
    // Надсилаємо лише значення, релевантне для обраного type, щоб не зберігати
    // «сміттєві» поля з минулої редакції форми.
    percentValue: isPercent && form.percentValue ? Number(form.percentValue) : undefined,
    fixedAmount:
      form.type === 'FIXED_AMOUNT' && form.fixedAmount ? Number(form.fixedAmount) : undefined,
    fixedPrice:
      form.type === 'FIXED_PRICE' && form.fixedPrice ? Number(form.fixedPrice) : undefined,
    roundTo: form.roundTo ? Number(form.roundTo) : undefined,
    // Лише поля з DTO грейда: `id` збереженого грейда сервер не приймає (forbidNonWhitelisted).
    tiers:
      form.type === 'COST_TIER'
        ? form.tiers.map((tier, i) => ({
            costMin: tier.costMin,
            ...(tier.costMax != null ? { costMax: tier.costMax } : {}),
            percentValue: tier.percentValue,
            sortOrder: i,
          }))
        : undefined,
  };
}

/** Значення області після нормалізації «один вимір». */
function scopeValues(form: RuleForm) {
  const dim = scopeDimension(form);
  return {
    goodIds: form.goods.map(g => g.id),
    brandId: dim === 'brand' ? form.brandId : null,
    goodCategoryId: dim === 'category' ? form.goodCategoryId : null,
    goodType: dim === 'type' && isGoodType(form.goodType) ? form.goodType : null,
    supplierId: form.supplierId || null,
  };
}

/** POST /pricing-rules: порожні поля області просто не надсилаються. */
export function buildCreatePayload(form: RuleForm): CreatePricingRulePayload {
  const scope = scopeValues(form);
  return {
    ...valuePart(form),
    goodIds: scope.goodIds.length > 0 ? scope.goodIds : undefined,
    brandId: scope.brandId ?? undefined,
    goodCategoryId: scope.goodCategoryId ?? undefined,
    goodType: scope.goodType ?? undefined,
    supplierId: scope.supplierId ?? undefined,
  };
}

/**
 * PATCH /pricing-rules/:id. У PATCH `undefined` = «не чіпати», тож область надсилається ЯВНО
 * І ЦІЛКОМ: зняте у формі значення йде як `null` (список — як `[]`), інакше воно лишилось би
 * на сервері.
 *
 * Виняток — старе правило з ТЕКСТОВОЮ категорією: доки користувач категорію не чіпав,
 * `goodCategoryId` не надсилається взагалі (`null` стер би текстову категорію).
 */
export function buildUpdatePayload(form: RuleForm): UpdatePricingRulePayload {
  const { goodCategoryId, ...scope } = scopeValues(form);
  const keepLegacyCategory = !!form.legacyGoodCategory && !form.categoryTouched;
  return {
    ...valuePart(form),
    ...scope,
    ...(keepLegacyCategory ? {} : { goodCategoryId }),
    isActive: form.isActive,
  };
}
