import { BadRequestException } from '@nestjs/common';

/**
 * Метадата-реєстр конструктора звітів — ЄДИНЕ ДЖЕРЕЛО ПРАВДИ.
 *
 * Описує, які сутності/поля/зв'язки/агрегації дозволені у звітах. Живить і backend-білдер
 * (report-query.builder), і frontend-каталог (GET /reports/builder/metadata).
 *
 * БЕЗПЕКА: користувач передає лише `field.key` (публічний id). Він резолвиться у реєстровий
 * `prismaPath` — ЛІТЕРАЛ у цьому файлі, ніколи не з вводу. Усі helper-и використовують
 * `Object.prototype.hasOwnProperty.call` (як buildSortOrderBy у pagination.ts) — захист від
 * prototype-injection (`__proto__`/`constructor`/`toString`). Значення фільтрів параметризує
 * Prisma-клієнт. Отже generated-SQL-injection неможливий за побудовою.
 */

export type Agg = 'SUM' | 'COUNT' | 'AVG' | 'MIN' | 'MAX';
export const ALLOWED_AGGS: readonly Agg[] = ['SUM', 'COUNT', 'AVG', 'MIN', 'MAX'];

export type FilterOp = 'eq' | 'ne' | 'in' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'isNull';
export const ALLOWED_OPS: readonly FilterOp[] = [
  'eq',
  'ne',
  'in',
  'gt',
  'gte',
  'lt',
  'lte',
  'contains',
  'isNull',
];

/** scalar — рядок/id; number — Float/Int; decimal — грошове; enum — з whitelist; date; relation — леґасі-мітка. */
export type FieldType = 'scalar' | 'number' | 'decimal' | 'enum' | 'date' | 'boolean';

export interface ReportFieldDef {
  /** Публічний id, стабільний. Для relation-поля — dot-path, напр. 'counterparty.type'. */
  key: string;
  label: string;
  type: FieldType;
  /** Dot-path у Prisma-моделі: 'quantity' | 'counterparty.type' | 'good.brand.name'. */
  prismaPath: string;
  /** Для type:'enum' — ключ у REGISTRY.enums (валідація значень фільтра + рендер). */
  enumName?: string;
  /** Дозволені агрегації (порожньо = поле не агрегабельне, лише для колонок/групування). */
  aggregations: Agg[];
  filterable: boolean;
  groupable: boolean;
  /** balance тощо — стан, не потік: SUM заборонено (лише AVG/MIN/MAX). */
  stateNotFlow?: boolean;
  /** Знакове поле (StockMovement.quantity): знак береться з сусіднього enum-поля (напр. 'type'). */
  signedByType?: string;
}

export interface ReportRelationDef {
  /** dot-path гілки: 'counterparty' | 'good.brand' | 'purchaseOrder.supplier'. */
  key: string;
  label: string;
  /** prismaModel цільової сутності (довідково). */
  target: string;
  prismaPath: string;
  /** Фактична глибина ланцюга (кількість хопів). */
  depth: number;
  /** 3+ хопи або дубль — сховати за замовчуванням у UI. */
  advanced: boolean;
  /** Чи інжектити deletedAt:null у nested include на цьому хопі (Bug #607). */
  targetHasSoftDelete: boolean;
}

export type EntityProfile = 'FULL' | 'APPEND_ONLY';

export interface ReportEntityDef {
  key: string;
  /** Ім'я Prisma-делегата: this.prisma[prismaModel].findMany(...). */
  prismaModel: string;
  tableName: string;
  label: string;
  profile: EntityProfile;
  /** FULL → true (інжектимо deletedAt:null); APPEND_ONLY → false (поля немає). */
  hasSoftDelete: boolean;
  /** Поле для dateRange-фільтра. */
  dateField: string;
  defaultSort: { path: string; dir: 'asc' | 'desc' };
  fields: ReportFieldDef[];
  relations: ReportRelationDef[];
}

// ─── ENUM whitelists ────────────────────────────────────────────────────────────
export const REGISTRY_ENUMS: Record<string, readonly string[]> = {
  CounterpartyType: ['CLIENT', 'SUPPLIER', 'BOTH'],
  WorkOrderStatus: [
    'DRAFT',
    'ESTIMATE',
    'APPROVED',
    'IN_PROGRESS',
    'ON_HOLD',
    'COMPLETED',
    'INVOICED',
    'PAID',
    'ARCHIVED',
    'CANCELLED',
  ],
  WorkOrderPriority: ['LOW', 'NORMAL', 'HIGH', 'URGENT'],
  PurchaseOrderStatus: ['DRAFT', 'ORDERED', 'PARTIAL', 'RECEIVED', 'CANCELLED'],
};

// ─── Entity definitions (v1: 3 сутності; реєстр розширюваний) ────────────────────

const workOrder: ReportEntityDef = {
  key: 'workOrder',
  prismaModel: 'workOrder',
  tableName: 'work_orders',
  label: 'Наряди',
  profile: 'FULL',
  hasSoftDelete: true,
  dateField: 'documentDate',
  defaultSort: { path: 'createdAt', dir: 'desc' },
  fields: [
    {
      key: 'number',
      label: 'Номер',
      type: 'scalar',
      prismaPath: 'number',
      aggregations: ['COUNT'],
      filterable: true,
      groupable: true,
    },
    {
      key: 'status',
      label: 'Статус',
      type: 'enum',
      prismaPath: 'status',
      enumName: 'WorkOrderStatus',
      aggregations: ['COUNT'],
      filterable: true,
      groupable: true,
    },
    {
      key: 'priority',
      label: 'Пріоритет',
      type: 'enum',
      prismaPath: 'priority',
      enumName: 'WorkOrderPriority',
      aggregations: ['COUNT'],
      filterable: true,
      groupable: true,
    },
    {
      key: 'totalAmount',
      label: 'Сума',
      type: 'decimal',
      prismaPath: 'totalAmount',
      aggregations: ['SUM', 'AVG', 'MIN', 'MAX'],
      filterable: true,
      groupable: false,
    },
    {
      key: 'totalLabor',
      label: 'Роботи',
      type: 'decimal',
      prismaPath: 'totalLabor',
      aggregations: ['SUM', 'AVG', 'MIN', 'MAX'],
      filterable: true,
      groupable: false,
    },
    {
      key: 'totalParts',
      label: 'Запчастини',
      type: 'decimal',
      prismaPath: 'totalParts',
      aggregations: ['SUM', 'AVG', 'MIN', 'MAX'],
      filterable: true,
      groupable: false,
    },
    {
      key: 'totalVat',
      label: 'ПДВ',
      type: 'decimal',
      prismaPath: 'totalVat',
      aggregations: ['SUM', 'AVG', 'MIN', 'MAX'],
      filterable: true,
      groupable: false,
    },
    {
      key: 'paidAmount',
      label: 'Оплачено',
      type: 'decimal',
      prismaPath: 'paidAmount',
      aggregations: ['SUM', 'AVG', 'MIN', 'MAX'],
      filterable: true,
      groupable: false,
    },
    {
      key: 'completedAt',
      label: 'Завершено',
      type: 'date',
      prismaPath: 'completedAt',
      aggregations: ['MIN', 'MAX', 'COUNT'],
      filterable: true,
      groupable: false,
    },
    {
      key: 'documentDate',
      label: 'Дата',
      type: 'date',
      prismaPath: 'documentDate',
      aggregations: ['MIN', 'MAX', 'COUNT'],
      filterable: true,
      groupable: false,
    },
    // relation-колонки (рівень 1 — прямий шлях WO→CP, рекомендований):
    {
      key: 'counterparty.type',
      label: 'Тип контрагента',
      type: 'enum',
      prismaPath: 'counterparty.type',
      enumName: 'CounterpartyType',
      aggregations: ['COUNT'],
      filterable: true,
      groupable: true,
    },
    {
      key: 'counterparty.companyName',
      label: 'Контрагент',
      type: 'scalar',
      prismaPath: 'counterparty.companyName',
      aggregations: ['COUNT'],
      filterable: true,
      groupable: true,
    },
    {
      key: 'branch.name',
      label: 'Філія',
      type: 'scalar',
      prismaPath: 'branch.name',
      aggregations: ['COUNT'],
      filterable: true,
      groupable: true,
    },
    {
      key: 'vehicle.make',
      label: 'Авто (марка)',
      type: 'scalar',
      prismaPath: 'vehicle.make',
      aggregations: ['COUNT'],
      filterable: true,
      groupable: true,
    },
    {
      key: 'vehicle.licensePlate',
      label: 'Авто (номер)',
      type: 'scalar',
      prismaPath: 'vehicle.licensePlate',
      aggregations: ['COUNT'],
      filterable: true,
      groupable: true,
    },
  ],
  relations: [
    {
      key: 'counterparty',
      label: 'Контрагент',
      target: 'counterparty',
      prismaPath: 'counterparty',
      depth: 1,
      advanced: false,
      targetHasSoftDelete: true,
    },
    {
      key: 'branch',
      label: 'Філія',
      target: 'garageBranch',
      prismaPath: 'branch',
      depth: 1,
      advanced: false,
      targetHasSoftDelete: true,
    },
    {
      key: 'vehicle',
      label: 'Авто',
      target: 'vehicle',
      prismaPath: 'vehicle',
      depth: 1,
      advanced: false,
      targetHasSoftDelete: true,
    },
  ],
};

const workOrderPart: ReportEntityDef = {
  key: 'workOrderPart',
  prismaModel: 'workOrderPart',
  tableName: 'work_order_parts',
  label: 'Запчастини у нарядах',
  profile: 'FULL',
  hasSoftDelete: true,
  dateField: 'createdAt',
  defaultSort: { path: 'createdAt', dir: 'desc' },
  fields: [
    {
      key: 'quantity',
      label: 'Кількість',
      type: 'number',
      prismaPath: 'quantity',
      aggregations: ['SUM', 'AVG', 'MIN', 'MAX', 'COUNT'],
      filterable: true,
      groupable: false,
    },
    {
      key: 'price',
      label: 'Ціна',
      type: 'decimal',
      prismaPath: 'price',
      aggregations: ['AVG', 'MIN', 'MAX'],
      filterable: true,
      groupable: false,
    },
    {
      key: 'amount',
      label: 'Сума',
      type: 'decimal',
      prismaPath: 'amount',
      aggregations: ['SUM', 'AVG', 'MIN', 'MAX'],
      filterable: true,
      groupable: false,
    },
    {
      key: 'batchCostPrice',
      label: 'Собівартість',
      type: 'decimal',
      prismaPath: 'batchCostPrice',
      aggregations: ['SUM', 'AVG', 'MIN', 'MAX'],
      filterable: true,
      groupable: false,
    },
    // relation-колонки (good рівень 1, good→brand рівень 2 — зрозумілий ланцюг):
    {
      key: 'good.name',
      label: 'Товар',
      type: 'scalar',
      prismaPath: 'good.name',
      aggregations: ['COUNT'],
      filterable: true,
      groupable: true,
    },
    {
      key: 'good.sku',
      label: 'SKU',
      type: 'scalar',
      prismaPath: 'good.sku',
      aggregations: ['COUNT'],
      filterable: true,
      groupable: true,
    },
    {
      key: 'good.brand.name',
      label: 'Бренд',
      type: 'scalar',
      prismaPath: 'good.brand.name',
      aggregations: ['COUNT'],
      filterable: true,
      groupable: true,
    },
    {
      key: 'warehouse.name',
      label: 'Склад',
      type: 'scalar',
      prismaPath: 'warehouse.name',
      aggregations: ['COUNT'],
      filterable: true,
      groupable: true,
    },
    {
      key: 'workOrder.number',
      label: 'Наряд',
      type: 'scalar',
      prismaPath: 'workOrder.number',
      aggregations: ['COUNT'],
      filterable: true,
      groupable: true,
    },
    {
      key: 'workOrder.counterparty.companyName',
      label: 'Контрагент',
      type: 'scalar',
      prismaPath: 'workOrder.counterparty.companyName',
      aggregations: ['COUNT'],
      filterable: true,
      groupable: true,
    },
    {
      key: 'workOrder.counterparty.type',
      label: 'Тип контрагента',
      type: 'enum',
      prismaPath: 'workOrder.counterparty.type',
      enumName: 'CounterpartyType',
      aggregations: ['COUNT'],
      filterable: true,
      groupable: true,
    },
  ],
  relations: [
    {
      key: 'good',
      label: 'Товар',
      target: 'good',
      prismaPath: 'good',
      depth: 1,
      advanced: false,
      targetHasSoftDelete: true,
    },
    {
      key: 'good.brand',
      label: 'Бренд',
      target: 'brand',
      prismaPath: 'good.brand',
      depth: 2,
      advanced: false,
      targetHasSoftDelete: true,
    },
    {
      key: 'warehouse',
      label: 'Склад',
      target: 'warehouse',
      prismaPath: 'warehouse',
      depth: 1,
      advanced: false,
      targetHasSoftDelete: true,
    },
    {
      key: 'workOrder',
      label: 'Наряд',
      target: 'workOrder',
      prismaPath: 'workOrder',
      depth: 1,
      advanced: false,
      targetHasSoftDelete: true,
    },
    {
      key: 'workOrder.counterparty',
      label: 'Контрагент (наряду)',
      target: 'counterparty',
      prismaPath: 'workOrder.counterparty',
      depth: 2,
      advanced: false,
      targetHasSoftDelete: true,
    },
  ],
};

const purchaseOrderLine: ReportEntityDef = {
  key: 'purchaseOrderLine',
  prismaModel: 'purchaseOrderLine',
  tableName: 'purchase_order_lines',
  label: 'Рядки закупівель',
  profile: 'FULL',
  hasSoftDelete: true,
  dateField: 'createdAt',
  defaultSort: { path: 'createdAt', dir: 'desc' },
  fields: [
    {
      key: 'quantity',
      label: 'Кількість',
      type: 'number',
      prismaPath: 'quantity',
      aggregations: ['SUM', 'AVG', 'MIN', 'MAX', 'COUNT'],
      filterable: true,
      groupable: false,
    },
    {
      key: 'price',
      label: 'Ціна',
      type: 'decimal',
      prismaPath: 'price',
      aggregations: ['AVG', 'MIN', 'MAX'],
      filterable: true,
      groupable: false,
    },
    {
      key: 'vatAmount',
      label: 'ПДВ',
      type: 'decimal',
      prismaPath: 'vatAmount',
      aggregations: ['SUM', 'AVG', 'MIN', 'MAX'],
      filterable: true,
      groupable: false,
    },
    {
      key: 'receivedQty',
      label: 'Отримано',
      type: 'number',
      prismaPath: 'receivedQty',
      aggregations: ['SUM', 'AVG', 'MIN', 'MAX'],
      filterable: true,
      groupable: false,
    },
    {
      key: 'good.name',
      label: 'Товар',
      type: 'scalar',
      prismaPath: 'good.name',
      aggregations: ['COUNT'],
      filterable: true,
      groupable: true,
    },
    {
      key: 'good.sku',
      label: 'SKU',
      type: 'scalar',
      prismaPath: 'good.sku',
      aggregations: ['COUNT'],
      filterable: true,
      groupable: true,
    },
    {
      key: 'good.brand.name',
      label: 'Бренд',
      type: 'scalar',
      prismaPath: 'good.brand.name',
      aggregations: ['COUNT'],
      filterable: true,
      groupable: true,
    },
    {
      key: 'purchaseOrder.number',
      label: 'Закупівля',
      type: 'scalar',
      prismaPath: 'purchaseOrder.number',
      aggregations: ['COUNT'],
      filterable: true,
      groupable: true,
    },
    {
      key: 'purchaseOrder.status',
      label: 'Статус',
      type: 'enum',
      prismaPath: 'purchaseOrder.status',
      enumName: 'PurchaseOrderStatus',
      aggregations: ['COUNT'],
      filterable: true,
      groupable: true,
    },
    {
      key: 'purchaseOrder.supplier.companyName',
      label: 'Постачальник',
      type: 'scalar',
      prismaPath: 'purchaseOrder.supplier.companyName',
      aggregations: ['COUNT'],
      filterable: true,
      groupable: true,
    },
    {
      key: 'purchaseOrder.supplier.type',
      label: 'Тип постачальника',
      type: 'enum',
      prismaPath: 'purchaseOrder.supplier.type',
      enumName: 'CounterpartyType',
      aggregations: ['COUNT'],
      filterable: true,
      groupable: true,
    },
  ],
  relations: [
    {
      key: 'good',
      label: 'Товар',
      target: 'good',
      prismaPath: 'good',
      depth: 1,
      advanced: false,
      targetHasSoftDelete: true,
    },
    {
      key: 'good.brand',
      label: 'Бренд',
      target: 'brand',
      prismaPath: 'good.brand',
      depth: 2,
      advanced: false,
      targetHasSoftDelete: true,
    },
    {
      key: 'purchaseOrder',
      label: 'Закупівля',
      target: 'purchaseOrder',
      prismaPath: 'purchaseOrder',
      depth: 1,
      advanced: false,
      targetHasSoftDelete: true,
    },
    {
      key: 'purchaseOrder.supplier',
      label: 'Постачальник',
      target: 'counterparty',
      prismaPath: 'purchaseOrder.supplier',
      depth: 2,
      advanced: false,
      targetHasSoftDelete: true,
    },
  ],
};

export const REGISTRY: Record<string, ReportEntityDef> = {
  workOrder,
  workOrderPart,
  purchaseOrderLine,
};

// ─── Helper-и (усі з hasOwnProperty-guard) ──────────────────────────────────────

export function getEntity(key: string): ReportEntityDef {
  if (typeof key !== 'string' || !Object.prototype.hasOwnProperty.call(REGISTRY, key)) {
    throw new BadRequestException(`Невідома сутність звіту: ${String(key)}`);
  }
  return REGISTRY[key];
}

export function getField(entity: ReportEntityDef, key: string): ReportFieldDef {
  const field = entity.fields.find(f => f.key === key);
  if (!field) {
    throw new BadRequestException(`Невідоме поле "${String(key)}" для «${entity.label}»`);
  }
  return field;
}

/**
 * Для relation-поля (prismaPath з крапкою) перевіряє, що ланцюг зв'язків дозволений реєстром:
 * кожен prefix шляху має бути присутній у relations[]. Повертає relation-def для найглибшого хопа.
 */
export function assertRelationPath(entity: ReportEntityDef, prismaPath: string): void {
  if (!prismaPath.includes('.')) return; // scalar кореня — нема relation
  const segments = prismaPath.split('.');
  // усі prefix-и крім останнього сегмента (leaf) мають бути валідними relation-гілками
  for (let i = 1; i < segments.length; i++) {
    const prefix = segments.slice(0, i).join('.');
    const rel = entity.relations.find(r => r.prismaPath === prefix);
    if (!rel) {
      throw new BadRequestException(`Недозволений зв'язок у полі: ${prefix}`);
    }
  }
}

export function relationForPrefix(
  entity: ReportEntityDef,
  prefix: string,
): ReportRelationDef | undefined {
  return entity.relations.find(r => r.prismaPath === prefix);
}

export function assertEnumValue(enumName: string, value: unknown): void {
  if (!Object.prototype.hasOwnProperty.call(REGISTRY_ENUMS, enumName)) {
    throw new BadRequestException(`Невідомий enum: ${enumName}`);
  }
  const allowed = REGISTRY_ENUMS[enumName];
  const values = Array.isArray(value) ? value : [value];
  for (const v of values) {
    if (!allowed.includes(String(v))) {
      throw new BadRequestException(`Недозволене значення "${String(v)}" для ${enumName}`);
    }
  }
}
